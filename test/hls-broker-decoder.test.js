import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, writeFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import Broker, {remoteReference,brokerInputInfo} from '../server/autolive/decoder/HlsDecodeInputBroker.js';
import SafeHttp from '../server/autolive/AutoLiveSafeHttp.js';
import Worker, {decoderArguments} from '../server/autolive/decoder/FFmpegHealthWorker.js';
import Supervisor from '../server/autolive/decoder/DecoderSupervisor.js';
import {generate,LOCAL_BACKEND,alive} from '../test-support/DecoderLocalFixture.js';

async function fixture(t, mp4 = false, live = false) {
    const root=await mkdtemp(join(tmpdir(),'lz-hls-generated-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    await generate(['-f','lavfi','-i','testsrc2=size=96x64:rate=10:duration=5','-f','lavfi','-i','sine=sample_rate=16000:duration=5',
        '-c:v','libx264','-preset','ultrafast','-g','10','-c:a','aac','-f','hls','-hls_time','1','-hls_list_size','0',
        ...(mp4?['-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4']:[]),
        '-hls_segment_filename',join(root,mp4?'segment%d.m4s':'segment%d.ts'),join(root,'input.m3u8')],{cwd:root});
    const manifest=await readFile(join(root,'input.m3u8'),'utf8');
    let reads=0;
    const server=createServer(async(req,res)=>{
        reads++; const name=req.url.slice(1);
        if(!/^(?:input\.m3u8|init\.mp4|segment\d+\.(?:ts|m4s))$/.test(name)){res.writeHead(404);return res.end();}
        try{res.end(name==='input.m3u8'&&live?manifest.replace('#EXT-X-ENDLIST',''):await readFile(join(root,name)));}
        catch(error){t.diagnostic(`isolated fixture missing ${name}: ${error.code}`);res.writeHead(404);res.end();}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
    const http=new SafeHttp({parseUrl:v=>new URL(remoteReference(v)),allowAddress:ip=>ip==='127.0.0.1',validateRedirect:remoteReference});
    const endpoint=`http://127.0.0.1:${server.address().port}/input.m3u8`;
    const broker=new Broker({endpoint,sourceId:'fixture',sourceFingerprint:'a'.repeat(64),http});
    t.after(()=>broker.close()); await broker.start();
    return {root,broker,endpoint,reads:()=>reads};
}
async function advancingFixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'lz-hls-advancing-'));
    t.after(() => rm(root, {recursive:true, force:true}));

    // Generate enough independent TS media for a genuinely advancing live window.
    await generate([
        '-f','lavfi',
        '-i','testsrc2=size=96x64:rate=10:duration=12',
        '-f','lavfi',
        '-i','sine=sample_rate=16000:duration=12',
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

    let sequence = 0;

    const liveManifest = () =>
        '#EXTM3U\n' +
        '#EXT-X-VERSION:3\n' +
        '#EXT-X-TARGETDURATION:1\n' +
        `#EXT-X-MEDIA-SEQUENCE:${sequence}\n` +
        '#EXTINF:1,\n' +
        `segment${sequence}.ts\n` +
        '#EXTINF:1,\n' +
        `segment${sequence + 1}.ts\n` +
        '#EXTINF:1,\n' +
        `segment${sequence + 2}.ts\n`;

    const server = createServer(async (req, res) => {
        if (req.url === '/input.m3u8') {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.end(liveManifest());
        }

        const match = /^\/segment(\d+)\.ts$/.exec(req.url);
        if (!match) {
            res.writeHead(404);
            return res.end();
        }

        try {
            res.end(await readFile(join(root, `segment${match[1]}.ts`)));
        } catch {
            res.writeHead(404);
            res.end();
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });

    const http = new SafeHttp({
        parseUrl: value => new URL(remoteReference(value)),
        allowAddress: ip => ip === '127.0.0.1',
        validateRedirect: remoteReference
    });

    const endpoint =
        `http://127.0.0.1:${server.address().port}/input.m3u8`;

    const broker = new Broker({
        endpoint,
        sourceId:'fixture',
        sourceFingerprint:'a'.repeat(64),
        http
    });

    t.after(() => broker.close());

    await broker.start();

    return {
        broker,
        advance() {
            sequence++;
        },
        sequence: () => sequence
    };
}
for(const mp4 of [false,true]) test(`real broker-local ${mp4?'fMP4':'TS'} HLS decodes required A/V through controlled loopback input`,async t=>{
    const {broker,endpoint}=await fixture(t,mp4);
    const info=await brokerInputInfo(broker.input),args=decoderArguments(info,'AUDIO_VIDEO');
    assert.equal(info.transport,'loopback-http');
    assert.match(info.path,/^http:\/\/127\.0\.0\.1:\d+\/input\.m3u8$/);
    assert.equal(args[args.indexOf('-protocol_whitelist')+1],'file,http,tcp');
    assert.equal(args[args.indexOf('-i')+1],info.path);
    assert.ok(!args.includes(endpoint));
    assert.ok(!args.some(a=>typeof a==='string'&&a.includes('example.com')));
    assert.equal(info.broker.executionAllowed,false);
    assert.equal(info.broker.serverTake,false);
    assert.equal(info.broker.transferReady,false);
    const worker=new Worker({backend:LOCAL_BACKEND,brokerInput:broker.input,sourceId:'fixture',profile:'AUDIO_VIDEO',maxRuntimeMs:15000});
    const samples=[];worker.on('observation',s=>samples.push(s));t.after(()=>worker.stop());
    await worker.start();const result=await worker.closed;
    assert.equal(result.sample.state,'DECODER_ENDED',JSON.stringify(result.sample));
    assert.ok(samples.some(s=>s.state==='DECODER_PROGRESS'),JSON.stringify(samples.map(s=>[s.state,s.reason])));
    const progress=samples.find(s=>s.state==='DECODER_PROGRESS');
    assert.ok(progress.tracks.audio.count>1);assert.ok(progress.tracks.video.count>1);
    assert.equal(progress.localFixtureOnly,false);assert.equal(progress.brokerGeneration,broker.generation);
    assert.equal(progress.sourceFingerprint,'a'.repeat(64));assert.equal(progress.executionAllowed,false);
    assert.equal(alive(worker.pid),false);
    const cache=broker.root;await broker.close();await assert.rejects(access(cache));
});
test('broker handles and loopback HLS arguments cannot be forged',async()=>{
    await assert.rejects(brokerInputInfo({kind:'BROKER_LOCAL_HLS'}),/UNAVAILABLE/);
    assert.throws(()=>decoderArguments({
        path:'http://127.0.0.1:12345/input.m3u8',
        format:'hls'
    },'AUDIO_VIDEO'),/BROKER_LOOPBACK_REQUIRED/);
    assert.throws(()=>decoderArguments({
        path:'http://example.com/input.m3u8',
        format:'hls',
        transport:'loopback-http',
        broker:{}
    },'AUDIO_VIDEO'),/BROKER_LOOPBACK_REQUIRED/);
});
test('supervisor restart closes previous broker-fed decoder before a new generation',async t=>{
    const {broker}=await fixture(t,false,true);
    const supervisor=new Supervisor({backend:LOCAL_BACKEND,brokerInput:broker.input,sourceId:'fixture',profile:'AUDIO_VIDEO',maxRuntimeMs:20000});
    t.after(()=>supervisor.stop()); const first=await supervisor.start();await delay(600);await supervisor.stop();
    assert.equal(alive(first.pid),false);await delay(1050);const second=await supervisor.start();
    assert.equal(second.restartGeneration,1);assert.notEqual(first.pid,second.pid);await supervisor.stop();
    assert.equal(alive(second.pid),false);
});
test('normal Node experiment shutdown drains FFmpeg and removes its broker cache',async t=>{
    const {endpoint}=await fixture(t,false,true);
    const child=fork(new URL('../test-support/BrokerShutdownFixture.js',import.meta.url),[endpoint],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    t.after(()=>{if(child.exitCode===null)child.kill();});
    const closed=once(child,'exit');const [started]=await once(child,'message');
    assert.ok(started.pid);assert.equal(alive(started.pid),true);
    const finished=once(child,'message');child.send('shutdown');const [message]=await finished;
    const [code]=await closed;assert.equal(code,0);assert.equal(message.result.cleanup,true);
    assert.equal(message.result.executionAllowed,false);assert.equal(message.result.serverTake,false);
    assert.equal(alive(started.pid),false);await assert.rejects(access(started.cache));
});
test('malformed bytes in an allowed TS container fail boundedly without weakening network policy',async t=>{
    const {root,broker}=await fixture(t);
    await broker.close();const data=Buffer.alloc(188*4);for(let n=0;n<data.length;n+=188)data[n]=0x47;
    for(let n=0;n<5;n++)await writeFile(join(root,`segment${n}.ts`),data);
    const replacement=new Broker({endpoint:broker.endpoint,sourceId:'fixture',sourceFingerprint:'a'.repeat(64),http:broker.http});
    t.after(()=>replacement.close());await replacement.start();
    const worker=new Worker({backend:LOCAL_BACKEND,brokerInput:replacement.input,sourceId:'fixture',profile:'AUDIO_VIDEO',maxRuntimeMs:5000});
    t.after(()=>worker.stop());let healthy=false;worker.on('observation',s=>{healthy ||= s.state==='DECODER_PROGRESS';});
    await worker.start();const result=await worker.closed;
    assert.equal(healthy,false);assert.ok(['DECODER_ERROR','DECODER_UNAVAILABLE'].includes(result.sample.state));
    assert.equal(alive(worker.pid),false);assert.equal(result.sample.serverTake,false);
});
test('advancing live manifest remains consumable during repeated FFmpeg refresh', async t => {
    const {broker, advance} = await advancingFixture(t);

    const worker = new Worker({
        backend: LOCAL_BACKEND,
        brokerInput: broker.input,
        sourceId: 'fixture',
        profile: 'AUDIO_VIDEO',
        maxRuntimeMs: 20000
    });

    t.after(() => worker.stop());

    const samples = [];
    worker.on('observation', sample => samples.push(sample));

    await worker.start();

    // Advance the remote LIVE window while the same FFmpeg process is
    // continuously consuming the broker-local HLS input.
    //
    // Do not wait for DECODER_PROGRESS before refreshing: a real LIVE source
    // continues producing media while decoder qualification is being earned.
    for (let n = 0; n < 7; n++) {
        await delay(750);

        advance();

await broker.refresh();

        assert.equal(
            broker.snapshot().ready,
            true,
            JSON.stringify(broker.snapshot())
        );

        assert.equal(
            alive(worker.pid),
            true,
            `FFmpeg exited during live refresh ${n + 1}`
        );
    }

    // Allow the evidence model to observe sustained A/V progression.
    for (let n = 0; n < 20; n++) {
        if (samples.some(sample => sample.state === 'DECODER_PROGRESS')) break;
        await delay(250);
    }

    assert.ok(
        samples.some(sample => sample.state === 'DECODER_PROGRESS'),
        JSON.stringify(samples.map(sample => [sample.state, sample.reason]))
    );

    const progress = samples.filter(
        sample => sample.state === 'DECODER_PROGRESS'
    );

    assert.ok(progress.length >= 1);

    const latest = progress.at(-1);

    assert.ok(latest.tracks.audio.advancing);
    assert.ok(latest.tracks.video.advancing);

    await worker.stop();

    assert.equal(alive(worker.pid), false);
});