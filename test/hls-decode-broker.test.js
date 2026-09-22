import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {readFile, readdir, access} from 'node:fs/promises';
import {join} from 'node:path';
import SafeHttp from '../server/autolive/AutoLiveSafeHttp.js';
import Broker, {parseDecodePlaylist, remoteReference, brokerInputInfo} from '../server/autolive/decoder/HlsDecodeInputBroker.js';
import {DecoderEvidence, sameEvidenceGeneration} from '../server/autolive/decoder/DecoderEvidenceContract.js';

const fp = 'a'.repeat(64);
const ts = () => { const data = Buffer.alloc(188 * 4); for (let n = 0; n < data.length; n += 188) data[n] = 0x47; return data; };
const playlist = (seq = 1, uri = `s${seq}.ts`, extra = '') => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${seq}\n${extra}#EXTINF:2,\n${uri}\n`;
const readLoopback = url => new Promise((resolve, reject) => {
    const req = request(url, {method:'GET'}, res => {
        const chunks = [];

        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
        }));
    });

    req.once('error', reject);
    req.end();
});
async function fixture(t, handler, options = {}) {
    const server = createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
    const endpoint = `http://127.0.0.1:${server.address().port}/master.m3u8`;
    // Test-only local trust injection into the REAL pinned client, never production defaults.
    const http = new SafeHttp({parseUrl: v => new URL(remoteReference(v)), allowAddress: ip => ip === '127.0.0.1',
        validateRedirect: remoteReference, ...options});
    return {endpoint, http};
}
async function make(t, fixture, extra = {}) {
    const broker = new Broker({...fixture, sourceId: 'fixture', sourceFingerprint: fp, ...extra});
    t.after(() => broker.close()); await broker.start(); return broker;
}
test('safe master/media/segment graph produces opaque local-only atomic manifest', async t => {
    let seq = 1;
    const f = await fixture(t, (req, res) => {
        assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
        if (req.url === '/master.m3u8') return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42e01e,mp4a.40.2",RESOLUTION=320x180\nmedia.m3u8\n');
        if (req.url === '/media.m3u8') return res.end(playlist(seq));
        assert.equal(req.headers.range, undefined); assert.equal(req.headers.accept,'*/*'); res.end(ts());
    });
    const broker = await make(t, f), input = await brokerInputInfo(broker.input);
    assert.equal(input.format, 'hls'); assert.equal(input.transport, 'loopback-http'); assert.equal(input.digest, fp);
    assert.match(input.path, /^http:\/\/127\.0\.0\.1:\d+\/input\.m3u8$/);
    const beforeResponse = await readLoopback(input.path); assert.equal(beforeResponse.status, 200);
    const before = beforeResponse.body;
    assert.ok(!before.includes(f.endpoint)); assert.ok(!before.includes('s1.ts'));
    assert.match(before, /\/media\/[a-f0-9]{64}\.ts/);
    seq++;
    const reading = []; const pending = broker.refresh();
    for (let n = 0; n < 10; n++) {
        const current = await readLoopback(input.path);
        assert.equal(current.status, 200);
        reading.push(current.body);
    }
    await pending;
    const afterResponse = await readLoopback(input.path); assert.equal(afterResponse.status, 200);
    const after = afterResponse.body; assert.notEqual(before, after);
    assert.ok(!after.includes(f.endpoint)); assert.ok(!after.includes('s2.ts'));
    assert.match(after, /\/media\/[a-f0-9]{64}\.ts/);
    assert.ok(reading.every(text => text === before || text === after));
    assert.equal(broker.snapshot().brokerContentGeneration, 2); assert.equal(broker.snapshot().profile.codecs, 'avc1.42e01e,mp4a.40.2');
    const root = broker.root; await broker.close(); await assert.rejects(access(root));
    await assert.rejects(brokerInputInfo(broker.input), /UNAVAILABLE/);
});
test('production HTTP policy rejects private/mixed DNS and never invokes request', async () => {
    for (const addresses of [[{address:'127.0.0.1',family:4}], [{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]]) {
        const http = new SafeHttp({resolve: async () => addresses}); http.request = () => assert.fail('socket must not open');
        await assert.rejects(http.read('https://public.example.com/a', {binary:true}), {code:'ADDRESS_FORBIDDEN'});
    }
});
test('default broker has no local address exception', async () => {
    const broker = new Broker({endpoint:'http://127.0.0.1/a', sourceId:'x',sourceFingerprint:fp});
    await assert.rejects(broker.start(), {code:'ADDRESS_FORBIDDEN'});
});
test('binary requests retain DNS pinning with one validated lookup', async t => {
    const f = await fixture(t, (req,res) => res.end(ts())); let lookups = 0;
    f.http.resolve = async () => { lookups++; return [{address:'127.0.0.1',family:4}]; };
    const result = await f.http.read(f.endpoint.replace('127.0.0.1','fixture.example.com'), {binary:true});
    assert.equal(lookups,1); assert.deepEqual(result.body,ts());
});
test('redirects revalidate addresses and reject traversal before URL normalization', async t => {
    const f = await fixture(t, (req,res) => {
        if (req.url === '/ok') return res.end(ts());
        res.writeHead(302, {Location:req.url === '/private' ? 'http://10.0.0.1/x' : req.url === '/traverse' ? '../secret' : '/ok'}); res.end();
    });
    assert.deepEqual((await f.http.read(f.endpoint,{binary:true})).body,ts());
    await assert.rejects(f.http.read(new URL('/private',f.endpoint).href,{binary:true}),{code:'ADDRESS_FORBIDDEN'});
    await assert.rejects(f.http.read(new URL('/traverse',f.endpoint).href,{binary:true}),{code:'REFERENCE_FORBIDDEN'});
});
for (const uri of ['../a.ts','%2e%2e/a.ts','%252e%252e/a.ts','file:///secret','ftp://host/a','data:text/plain,x',
    'javascript:alert(1)','\\\\host\\a','//host/a','http://u:p@host/a']) {
    test(`unsafe reference ${uri.slice(0,25)} is rejected`, () => assert.throws(() => remoteReference(uri,'https://public.example.com/a/'), /FORBIDDEN/));
}
for (const [name, text] of [
    ['nested segment', playlist(1,'http://10.0.0.1/a.ts')],
    ['init map', playlist(1,'s.ts','#EXT-X-MAP:URI="http://10.0.0.1/init.mp4"\n')],
    ['unsafe key', playlist(1,'s.ts','#EXT-X-KEY:METHOD=AES-128,URI="file:///key"\n')],
    ['encryption', playlist(1,'s.ts','#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n')],
    ['alternate audio', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n'],
    ['malformed', 'not a playlist'],
    ['LL-HLS', playlist(1,'s.ts','#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part.ts"\n')],
    ['oversized playlist', '#EXTM3U\n' + 'x'.repeat(131073)]]) {
    test(`graph rejects ${name} without handing input to decoder`, async t => {
        const f = await fixture(t, (req,res) => res.end(text)); const broker = new Broker({...f,sourceId:'fixture',sourceFingerprint:fp});
        t.after(() => broker.close()); await assert.rejects(broker.start());
        await assert.rejects(brokerInputInfo(broker.input)); assert.ok(!broker.reason.includes('http'));
    });
}
test('oversized segment, partial body, timeout and abort stay bounded', async t => {
    const f = await fixture(t, (req,res) => {
        if (req.url === '/large') return res.end(Buffer.alloc(2000));
        if (req.url === '/partial') { res.writeHead(206); return res.end(ts()); }
    }, {timeoutMs:100});
    await assert.rejects(f.http.read(new URL('/large',f.endpoint).href,{binary:true,maxBytes:1000}),{code:'BODY_LIMIT'});
    await assert.rejects(f.http.read(new URL('/partial',f.endpoint).href,{binary:true}),{code:'PARTIAL_BODY_UNSUPPORTED'});
    await assert.rejects(f.http.read(f.endpoint,{binary:true}),{code:'ABORTED'});
    const c = new AbortController(); const pending = f.http.read(f.endpoint,{binary:true,signal:c.signal}); c.abort();
    await assert.rejects(pending,{code:'ABORTED'});
});
test('unsafe init/key schemes are rejected before fetching referenced objects', () => {
    for (const tag of ['#EXT-X-MAP:URI="ftp://host/init"', '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain,x"'])
        assert.throws(() => parseDecodePlaylist(playlist(1,'a.ts',tag+'\n'),'https://public.example.com/a'),/FORBIDDEN/);
});
test('sequence regression and accepted media rewrite fence broker generation', async t => {
    let seq=2, changed=false;
    const f=await fixture(t,(req,res)=>req.url.endsWith('.ts')?res.end(ts()):res.end(playlist(seq,changed?'other.ts':'a.ts',changed?'#EXT-X-DISCONTINUITY\n':'')));
    const broker=await make(t,f); changed=true; await assert.rejects(broker.refresh(),{code:'ACCEPTED_MEDIA_CHANGED'});
    assert.equal(broker.snapshot().ready,false);
    changed=false; const second=await make(t,f); seq=1; await assert.rejects(second.refresh(),{code:'MEDIA_SEQUENCE_REGRESSED'});
});
test('rotating effective playlist URL does not select another rendition', async t => {
    let seq=1;
    const f=await fixture(t,(req,res)=>{
        if(req.url==='/master.m3u8'){res.writeHead(302,{Location:`/window${seq}.m3u8`});return res.end();}
        res.end(req.url.endsWith('.ts')?ts():playlist(seq));
    });
    const broker=await make(t,f), identity=broker.snapshot().renditionIdentity; seq++;
    await broker.refresh(); assert.equal(broker.snapshot().renditionIdentity,identity); assert.equal(broker.snapshot().endSequence,2);
});
test('stale playlist suppresses readiness; finite ENDLIST is preserved', async t => {
    let now=0;
    const f=await fixture(t,(req,res)=>res.end(req.url.endsWith('.ts')?ts():playlist()+'#EXT-X-ENDLIST\n'));
    const broker=await make(t,f,{clock:()=>now}); assert.equal(broker.snapshot().endlist,true);
    const input = await brokerInputInfo(broker.input);
    const endlist = await readLoopback(input.path);
    assert.equal(endlist.status,200);
    assert.match(endlist.body,/#EXT-X-ENDLIST/);
    now=16000; await broker.refresh(); assert.equal(broker.snapshot().reason,'PLAYLIST_STALE');
});
test('cache retains bounded windows and enforces byte ceiling', async t => {
    let seq=1; const f=await fixture(t,(req,res)=>res.end(req.url.endsWith('.ts')?ts():playlist(seq)));
    const broker=await make(t,f);
    for(seq=2;seq<12;seq++) await broker.refresh();
    assert.equal(broker.snapshot().objects,2); assert.equal((await readdir(broker.root)).length,2);
    const small=await make(t,f,{maxBytes:1024}); seq++; await assert.rejects(small.refresh(),{code:'CACHE_LIMIT'});
    assert.equal(small.snapshot().ready,false);
});
test('playlist payload masquerading as a segment is never presented to FFmpeg', async t => {
    const f=await fixture(t,(req,res)=>res.end(req.url.endsWith('.ts')?'#EXTM3U\nfile:///secret\n':playlist()));
    const broker=new Broker({...f,sourceId:'fixture',sourceFingerprint:fp});
    await assert.rejects(broker.start(),{code:'MEDIA_CONTAINER_UNSUPPORTED'});
});
test('broker generation/rendition changes invalidate evidence; ordinary content advances do not', () => {
    let now=0; const broker={brokerGeneration:'broker',brokerContentGeneration:1,renditionIdentity:'c'.repeat(64),
        sourceId:'fixture',sourceFingerprint:fp,ready:true,discontinuity:0};
    const model=new DecoderEvidence({sourceId:'fixture',sourceFingerprint:fp,backend:{digest:'b'.repeat(64),version:'test'},
        workerId:'worker',workerGeneration:1,profile:'VIDEO_ONLY',broker,clock:()=>now,wallClock:()=>now});
    const frame=pts=>model.ingest({kind:'video',signature:'v',pts,workerGeneration:1,restartGeneration:0});
    frame(0);now=600;frame(.6);const first=model.snapshot();assert.equal(first.state,'DECODER_PROGRESS');
    model.updateBroker({...broker,brokerContentGeneration:2});now=1200;frame(1.2);
    assert.equal(sameEvidenceGeneration(first,model.snapshot()),true);
    model.updateBroker({...broker,brokerContentGeneration:3,ready:false});assert.notEqual(model.snapshot().state,'DECODER_PROGRESS');
    model.updateBroker({...broker,brokerGeneration:'new'});assert.equal(model.snapshot().state,'DECODER_UNAVAILABLE');
});
test('transient timeout retries once without retrying policy errors or cancellation',async t=>{
    let segments=0;
    const f=await fixture(t,(req,res)=>{
        if(!req.url.endsWith('.ts'))return res.end(playlist());
        if(++segments===1)return;res.end(ts());
    },{timeoutMs:50});
    const broker=await make(t,f);assert.equal(broker.snapshot().retries,1);assert.equal(segments,2);
    const rejected=new Broker({...f,sourceId:'fixture',sourceFingerprint:fp});
    rejected.http={read:async()=>{throw Object.assign(Error('blocked'),{code:'ADDRESS_FORBIDDEN'});}};
    await assert.rejects(rejected.start(),{code:'ADDRESS_FORBIDDEN'});assert.equal(rejected.retries,0);
});
test('partial-body timeout diagnostics are bounded and preserve the fixed request deadline',async t=>{
    const f=await fixture(t,(req,res)=>{res.writeHead(200);res.write(Buffer.from([1,2,3]));},{timeoutMs:50});
    await assert.rejects(f.http.read(f.endpoint,{binary:true}),e=>e.code==='ABORTED'&&e.receivedBytes===3&&
        e.headersReceived===true&&e.requestPhase==='REQUEST'&&!('url' in e));
});
test('binary body mode cannot raise the manifest cap or become a one-byte probe',async()=>{
    const http=new SafeHttp();
    await assert.rejects(http.read('https://public.example.com/a',{maxBytes:131073}),{code:'BODY_OPTIONS_INVALID'});
    await assert.rejects(http.read('https://public.example.com/a',{binary:true,segment:true}),{code:'BODY_OPTIONS_INVALID'});
    await assert.rejects(http.read('https://public.example.com/a',{binary:true,maxBytes:16777217}),{code:'BODY_OPTIONS_INVALID'});
});
test('closing during refresh cancels pending fetch, does not retry, and removes cache',async t=>{
    let hang=false;const f=await fixture(t,(req,res)=>{if(hang)return;res.end(req.url.endsWith('.ts')?ts():playlist());});
    const broker=await make(t,f),root=broker.root;hang=true;
    const pending=broker.refresh();const rejected=assert.rejects(pending,{code:'ABORTED'});await broker.close();await rejected;
    assert.equal(broker.retries,0);await assert.rejects(access(root));
});
test('per-read timeout override is bounded and does not change client default', async t => {
    const started = Date.now();
    const f = await fixture(t, (req, res) => {
        setTimeout(() => res.end(ts()), 120);
    }, {timeoutMs: 50});

    await assert.rejects(
        f.http.read(f.endpoint, {binary:true}),
        {code:'ABORTED'}
    );

    const result = await f.http.read(f.endpoint, {
        binary:true,
        timeoutMs:250
    });

    assert.deepEqual(result.body, ts());
    assert.ok(Date.now() - started >= 120);

    await assert.rejects(
        f.http.read(f.endpoint, {binary:true, timeoutMs:10001}),
        {code:'BODY_OPTIONS_INVALID'}
    );

    await assert.rejects(
        f.http.read(f.endpoint, {binary:true, timeoutMs:0}),
        {code:'BODY_OPTIONS_INVALID'}
    );
});

test('broker applies media timeout only to media objects', async t => {
    const observed = [];
    const f = await fixture(t, (req, res) => {
        if (req.url === '/master.m3u8') {
            return res.end(
                '#EXTM3U\n' +
                '#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42e01e,mp4a.40.2",RESOLUTION=320x180\n' +
                'media.m3u8\n'
            );
        }
        if (req.url === '/media.m3u8') return res.end(playlist());
        return res.end(ts());
    });

    const originalRead = f.http.read.bind(f.http);
    f.http.read = async (uri, options = {}) => {
        observed.push({
            uri: new URL(uri).pathname,
            timeoutMs: options.timeoutMs ?? null,
            binary: options.binary ?? false
        });
        return originalRead(uri, options);
    };

    const broker = await make(t, f, {mediaTimeoutMs:10000});

    const master = observed.find(x => x.uri === '/master.m3u8');
    const media = observed.find(x => x.uri === '/media.m3u8');
    const segment = observed.find(x => x.uri.endsWith('.ts'));

    assert.equal(master.timeoutMs, null);
    assert.equal(media.timeoutMs, null);
    assert.equal(segment.timeoutMs, 10000);
    assert.equal(segment.binary, true);

    assert.equal(broker.mediaTimeoutMs, 10000);
});

test('broker media timeout option is explicitly bounded', async t => {
    const f = await fixture(t, (req, res) =>
        res.end(req.url.endsWith('.ts') ? ts() : playlist())
    );

    for (const mediaTimeoutMs of [2499, 10001, 0, -1]) {
        assert.throws(
            () => new Broker({
                ...f,
                sourceId:'fixture',
                sourceFingerprint:fp,
                mediaTimeoutMs
            }),
            /BROKER_OPTIONS_INVALID/
        );
    }

    const minimum = await make(t, f, {mediaTimeoutMs:2500});
    assert.equal(minimum.mediaTimeoutMs, 2500);

    const maximum = await make(t, f, {mediaTimeoutMs:10000});
    assert.equal(maximum.mediaTimeoutMs, 10000);
});
test('broker close bounds a non-cooperative pending operation and reports incomplete drain', async t => {
    const f = await fixture(t, (req, res) => {
        if (req.url.endsWith('.ts')) return res.end(ts());
        res.end(playlist());
    });

    const broker = new Broker({
        endpoint:f.endpoint,
        sourceId:'fixture',
        sourceFingerprint:fp,
        http:f.http
    });

    await broker.start();

    const root = broker.root;

    broker.pending = new Promise(() => {});

    const started = Date.now();

    let closeError = null;
    try {
        await broker.close();
    } catch (error) {
        closeError = error;
    }

    const elapsed = Date.now() - started;

    assert.equal(closeError?.code,'PENDING_DRAIN_TIMEOUT');
    assert.ok(elapsed >= 1900, 'close returned too early');
    assert.ok(elapsed < 4000, 'close was not bounded');
    await assert.rejects(access(root));
    assert.equal(broker.snapshot().executionAllowed,false);
    assert.equal(broker.snapshot().serverTake,false);
    assert.equal(broker.snapshot().transferReady,false);
});