import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import Origin from '../server/autolive/decoder/DecoderLoopbackOrigin.js';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {generate, LOCAL_BACKEND} from '../test-support/DecoderLocalFixture.js';

const get = url => new Promise((resolve, reject) => {
    const req = request(url, {method:'GET'}, res => {
        const chunks = [];

        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks),
            headers: res.headers
        }));
    });

    req.once('error', reject);
    req.end();
});

test('decoder loopback origin binds only to IPv4 loopback', async t => {
    const origin = new Origin({
        manifest: () => '#EXTM3U\n#EXT-X-ENDLIST\n'
    });

    t.after(() => origin.close());

    await origin.start();

    const state = origin.snapshot();

    assert.equal(state.host, '127.0.0.1');
    assert.ok(Number.isInteger(state.port));
    assert.equal(state.executionAllowed, false);
    assert.equal(state.serverTake, false);
    assert.equal(state.transferReady, false);
});

test('loopback origin serves only generated manifest and opaque media', async t => {
    const token = `${'a'.repeat(64)}.ts`;
    const media = Buffer.from([1,2,3,4]);

    const origin = new Origin({
        manifest: () =>
            `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n/media/${token}\n`,
        object: value => value === token ? {body:media} : null
    });

    t.after(() => origin.close());

    await origin.start();

    const manifest = await get(origin.url);

    assert.equal(manifest.status, 200);
    assert.match(manifest.body.toString(), /^#EXTM3U/);

    const object = await get(
        `http://127.0.0.1:${origin.port}/media/${token}`
    );

    assert.equal(object.status, 200);
    assert.deepEqual(object.body, media);

    for (const path of [
        '/http://example.com/a.ts',
        '/media/../secret',
        '/media/%2e%2e%2fsecret',
        '/media/file:///secret',
        '/media/not-opaque.ts',
        '/fetch?url=http://example.com'
    ]) {
        const result = await get(
            `http://127.0.0.1:${origin.port}${path}`
        );

        assert.equal(result.status, 404, path);
    }
});

test('loopback origin never becomes an execution surface', async t => {
    const origin = new Origin({
        manifest: () => '#EXTM3U\n#EXT-X-ENDLIST\n'
    });

    t.after(() => origin.close());

    await origin.start();

    const state = origin.snapshot();

    assert.equal(state.executionAllowed, false);
    assert.equal(state.serverTake, false);
    assert.equal(state.transferReady, false);

    assert.equal('take' in origin, false);
    assert.equal('return' in origin, false);
    assert.equal('execute' in origin, false);
});
test('loopback origin serves only an explicitly resolved cached file', async t => {
    const root = await mkdtemp(join(tmpdir(), 'lz-loopback-file-'));
    t.after(() => rm(root, {recursive:true, force:true}));

    const token = `${'b'.repeat(64)}.ts`;
    const path = join(root, 'authorized.ts');
    const body = Buffer.from([0x47,1,2,3,4,5]);

    await writeFile(path, body);

    const origin = new Origin({
        manifest: () =>
            `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n/media/${token}\n`,
        object: value =>
            value === token ? {path} : null
    });

    t.after(() => origin.close());

    await origin.start();

    const result = await get(
        `http://127.0.0.1:${origin.port}/media/${token}`
    );

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, body);

    const missing = await get(
        `http://127.0.0.1:${origin.port}/media/${'c'.repeat(64)}.ts`
    );

    assert.equal(missing.status, 404);
});
test('real FFmpeg decodes A/V only through the controlled loopback origin', async t => {
    const root = await mkdtemp(join(tmpdir(), 'lz-loopback-decoder-'));
    t.after(() => rm(root, {recursive:true, force:true}));

    await generate([
        '-f','lavfi',
        '-i','testsrc2=size=96x64:rate=10:duration=5',
        '-f','lavfi',
        '-i','sine=sample_rate=16000:duration=5',
        '-c:v','libx264',
        '-preset','ultrafast',
        '-g','10',
        '-c:a','aac',
        '-f','hls',
        '-hls_time','1',
        '-hls_list_size','0',
        '-hls_segment_filename',join(root,'segment%d.ts'),
        join(root,'generated.m3u8')
    ], {cwd:root});

    const sourceManifest =
        await readFile(join(root,'generated.m3u8'),'utf8');

    const media = new Map();

    for (let n = 0; n < 5; n++) {
        const body = await readFile(join(root,`segment${n}.ts`));
        const token = `${String(n).padStart(64,'0')}.ts`;

        media.set(token,{body});
    }

    let localized = sourceManifest;

    for (let n = 0; n < 5; n++) {
        const token = `${String(n).padStart(64,'0')}.ts`;

        localized = localized.replace(
            `segment${n}.ts`,
            `/media/${token}`
        );
    }

    const origin = new Origin({
        manifest: () => localized,
        object: token => media.get(token) ?? null
    });

    t.after(() => origin.close());

    await origin.start();

    const args = [
        '-hide_banner',
        '-nostats',
        '-loglevel','info',
        '-xerror',
        '-protocol_whitelist','file,http,tcp',
        '-i',origin.url,

        '-map','0:v:0',
        '-vf','showinfo=checksum=0',

        '-map','0:a:0',
        '-af','ashowinfo',

        '-f','null',
        '-'
    ];

    const child = spawn(LOCAL_BACKEND.path,args,{
        shell:false,
        windowsHide:true,
        stdio:['ignore','ignore','pipe']
    });

    let video = 0;
    let audio = 0;

    child.stderr.setEncoding('utf8');

    child.stderr.on('data',chunk => {
        for (const line of chunk.split(/\r?\n/)) {
            if (
                line.includes('Parsed_showinfo_') &&
                line.includes('pts_time:')
            ) video++;

            if (
                line.includes('Parsed_ashowinfo_') &&
                line.includes('pts_time:')
            ) audio++;
        }
    });

    const code = await new Promise((resolve,reject) => {
        child.once('error',reject);
        child.once('close',resolve);
    });

    assert.equal(code,0);
    assert.ok(video > 0,`video frames: ${video}`);
    assert.ok(audio > 0,`audio frames: ${audio}`);

    const state = origin.snapshot();

    assert.ok(state.requests >= 2);
    assert.equal(state.executionAllowed,false);
    assert.equal(state.serverTake,false);
    assert.equal(state.transferReady,false);
});
test('loopback origin close is bounded with an active client connection', async t => {
    const origin = new Origin({
        manifest: () => '#EXTM3U\n#EXT-X-ENDLIST\n'
    });

    await origin.start();

    const req = request(origin.url, {
        method: 'GET',
        headers: {
            Connection: 'keep-alive'
        }
    });

    const response = await new Promise((resolve, reject) => {
        req.once('response', resolve);
        req.once('error', reject);
        req.end();
    });

    response.pause();

    const result = await Promise.race([
        origin.close().then(() => 'CLOSED'),
        new Promise(resolve =>
            setTimeout(() => resolve('TIMEOUT'), 3000)
        )
    ]);

    response.destroy();

    assert.equal(
        result,
        'CLOSED',
        'loopback origin close must finish with an active client connection'
    );
});