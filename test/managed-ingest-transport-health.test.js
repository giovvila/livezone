import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import Registry,{ManagedIngestHealthProducer} from '../server/autolive/AutoLiveHealthRegistry.js';
import {resolveHealthSource} from '../server/autolive/AutoLiveHealthContract.js';
import {managedResource,managedHttp} from '../server/autolive/ManagedIngestTransport.js';
import Config from '../server/media-ingest/MediaIngestConfig.js';
import Decision from '../server/autolive/AutoLiveDecisionShadow.js';
import {managedFixture} from '../test-support/ManagedHealthFixture.js';

function fixture(){
    const f=managedFixture();let now=1000;
    const source={id:'managed',kind:'hls',url:f.config.playbackHlsUrl};
    const descriptor=resolveHealthSource(source,()=>null,f.config);
    const producer=new ManagedIngestHealthProducer(f.client,{http:f.http,clock:()=>now});
    return {...f,source,descriptor,producer,advance:ms=>now+=ms,
        sample:(value=descriptor)=>producer.sample(value,new AbortController().signal)};
}

test('managed transport keeps publisher, valid playlist, progression and segment evidence distinct',async()=>{
    const f=fixture();f.state.present=false;
    let v=await f.sample();assert.equal(v.state,'OFFLINE');assert.equal(v.reason,'PUBLISHER_ABSENT');
    assert.deepEqual(f.state.calls,['/v3/paths/list']);
    f.state.present=true;v=await f.sample();
    assert.equal(v.publisherPresent,true);assert.equal(v.playbackAvailable,true);
    assert.equal(v.playlistProgressing,null);assert.equal(v.segmentReachable,true);assert.equal(v.state,'UNCERTAIN');
    v=await f.sample();assert.equal(v.playlistProgressing,false);assert.equal(v.reason,'PLAYLIST_STALLED');
    f.state.sequence++;v=await f.sample();assert.equal(v.state,'ONLINE');assert.equal(v.reason,'TRANSPORT_READY');
    f.state.sequence++;f.state.segment=false;v=await f.sample();
    assert.equal(v.playlistProgressing,true);assert.equal(v.segmentReachable,false);assert.equal(v.state,'UNCERTAIN');
    assert.equal(v.reason,'SEGMENT_UNREACHABLE');
});

for(const [failure,reason] of [['NETWORK_ERROR','PLAYLIST_UNREACHABLE'],['HTTP_ERROR','HTTP_ERROR'],
    ['ABORTED','ABORTED'],['BODY_LIMIT','BODY_LIMIT']])test('managed playlist failure '+failure,async()=>{
    const f=fixture();await f.sample();f.state.failure=failure;
    const v=await f.sample();assert.equal(v.publisherPresent,true);assert.equal(v.playbackAvailable,false);
    assert.equal(v.playlistProgressing,null);assert.equal(v.segmentReachable,null);assert.equal(v.reason,reason);
    delete f.state.failure;f.state.sequence++;assert.equal((await f.sample()).playlistProgressing,null);
});

for(const body of ['<html>200 OK</html>','#EXTM3U\n#EXTINF:2,\nx.mp4',
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PART:DURATION=no,URI="part.mp4"'])
    test('managed malformed playlist is not evidence '+body.slice(0,30),async()=>{
        const f=fixture();f.state.body=body;const v=await f.sample();assert.equal(v.reason,'PLAYLIST_INVALID');assert.notEqual(v.state,'ONLINE');
    });

const ll=(msn,parts,extra='')=>`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${msn}\n${extra}${Array.from({length:parts},(_,i)=>`#EXT-X-PART:DURATION=0.2,URI="part-${msn}-${i}.mp4"`).join('\n')}\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="future.mp4"\n`;
test('LL-HLS parts-only playlist advances; preload hint is never probed; completion advances',async()=>{
    const f=fixture();f.state.body=ll(10,1);assert.equal((await f.sample()).playlistProgressing,null);
    assert.equal((await f.sample()).playlistProgressing,false);
    f.state.body=ll(10,2);assert.equal((await f.sample()).state,'ONLINE');
    assert.ok(f.state.calls.includes('/camera/part-10-1.mp4'));assert.ok(!f.state.calls.includes('/camera/future.mp4'));
    f.state.body=f.media();assert.equal((await f.sample()).state,'ONLINE');
    f.state.body=ll(11,1);assert.equal((await f.sample()).state,'ONLINE');
});
test('master playlist resolves a same-directory variant before its current resource',async()=>{
    const f=fixture(),request=f.http.request.bind(f.http);
    f.http.request=(url,...args)=>url.pathname.endsWith('/index.m3u8')?
        Promise.resolve({body:'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="avc1,mp4a"\nstream.m3u8'}):request(url,...args);
    await f.sample();f.state.sequence++;assert.equal((await f.sample()).state,'ONLINE');
    assert.ok(f.state.calls.includes('/camera/stream.m3u8'));
});
test('reset, discontinuity, publisher restart, absence and expired history require new evidence',async()=>{
    const f=fixture();await f.sample();f.state.sequence++;assert.equal((await f.sample()).state,'ONLINE');
    f.state.sequence=1;assert.equal((await f.sample()).reason,'SEQUENCE_RESET');
    f.state.sequence++;assert.equal((await f.sample()).state,'ONLINE');
    f.state.body=ll(3,1,'#EXT-X-DISCONTINUITY-SEQUENCE:1\n');assert.equal((await f.sample()).reason,'SEQUENCE_RESET');
    f.state.body=ll(3,2,'#EXT-X-DISCONTINUITY-SEQUENCE:1\n');assert.equal((await f.sample()).state,'ONLINE');
    f.state.onlineTime='2026-09-30T16:01:00Z';assert.equal((await f.sample()).playlistProgressing,null);
    f.advance(10001);assert.equal((await f.sample()).playlistProgressing,null);
    f.state.present=false;await f.sample();f.state.present=true;assert.equal((await f.sample()).playlistProgressing,null);
});
for(const suffix of ['#EXT-X-ENDLIST','#EXT-X-PLAYLIST-TYPE:VOD','#EXT-X-BYTERANGE:20@0'])
    test('non-live or unsupported media cannot become ONLINE '+suffix,async()=>{
        const f=fixture();await f.sample();f.state.sequence++;f.state.body=f.media()+suffix;
        assert.notEqual((await f.sample()).state,'ONLINE');
    });
test('source identity/fingerprint and managed configuration isolate history',async()=>{
    const f=fixture();await f.sample();f.state.sequence++;
    const next=resolveHealthSource({...f.source,id:'other'},()=>null,f.config);
    assert.equal((await f.sample(next)).playlistProgressing,null);f.state.sequence++;
    assert.equal((await f.sample({...next,fingerprint:'b'.repeat(64)})).playlistProgressing,null);
    for(const patch of [{apiOrigin:'http://localhost:9998'},{ingestId:'other'},{timeoutMs:2000},
        {mediaPath:'next',playbackHlsUrl:'http://127.0.0.1:18181/next/index.m3u8'}]){
        const config=new Config({...f.config,...patch});
        const changed=resolveHealthSource({...f.source,url:config.playbackHlsUrl},()=>null,config);
        assert.notEqual(changed.fingerprint,f.descriptor.fingerprint);
    }
});

test('endpoint mismatch is rejected and cannot preserve progression history',async()=>{
    const f=fixture();await f.sample();f.state.sequence++;
    await assert.rejects(f.sample({...f.descriptor,endpoint:f.descriptor.endpoint+'?changed=1'}),{code:'MAPPING_MISMATCH'});
    assert.equal((await f.sample()).playlistProgressing,null);
    const getStatus=f.client.getStatus.bind(f.client);
    f.client.getStatus=async options=>({...await getStatus(options),ingestId:'wrong'});
    await assert.rejects(f.sample(),{code:'MAPPING_MISMATCH'});
    f.client.getStatus=getStatus;f.state.sequence++;
    assert.equal((await f.sample()).playlistProgressing,null);
});

for(const uri of ['https://other.invalid/camera/x.mp4','//other.invalid/camera/x.mp4','file:///camera/x',
    '../other/x.mp4','%2e%2e/other.mp4','%252e%252e/x.mp4','/other/x.mp4','..\\x.mp4',
    'http://user:secret@127.0.0.1:18181/camera/x.mp4','/camera/a%2fb.mp4'])test('unsafe resource rejected '+uri,async()=>{
    const f=fixture();assert.throws(()=>managedResource(uri,f.config.playbackHlsUrl,f.config.playbackHlsUrl),{code:'URL_FORBIDDEN'});
    f.state.body=`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${uri}\n`;
    const v=await f.sample();assert.equal(v.segmentReachable,false);assert.equal(v.reason,'URL_FORBIDDEN');
    assert.equal(f.state.calls.length,2);
});

test('canonical transport HTTP bounds response, timeout, redirects and transferred segment bytes',async t=>{
    const requests=[];
    const server=createServer((req,res)=>{
        requests.push(req.url);
        if(req.url.endsWith('/large'))return res.end('x'.repeat(131073));
        if(req.url.endsWith('/error')){res.writeHead(503);return res.end();}
        if(req.url.endsWith('/redirect')){res.writeHead(302,{Location:'/camera/ok'});return res.end();}
        if(req.url.endsWith('/hang'))return;
        if(req.url.endsWith('/segment')){assert.equal(req.headers.range,'bytes=0-0');res.writeHead(206);return res.end('x');}
        res.end('#EXTM3U');
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
    const config=new Config({mediaPath:'camera',playbackHlsUrl:`http://127.0.0.1:${server.address().port}/camera/index.m3u8`,timeoutMs:100});
    const http=managedHttp(config),url=name=>new URL(name,config.playbackHlsUrl).href;
    await assert.rejects(http.read(url('large')),{code:'BODY_LIMIT'});
    await assert.rejects(http.read(url('error')),{code:'HTTP_ERROR'});
    await assert.rejects(http.read(url('redirect')),{code:'REDIRECT_INVALID'});
    assert.ok(!requests.includes('/camera/ok'));
    await assert.rejects(http.read(url('hang')),{code:'ABORTED'});
    const abort=new AbortController();const pending=http.read(url('hang'),{signal:abort.signal});abort.abort();
    await assert.rejects(pending,{code:'ABORTED'});
    assert.equal((await http.read(url('segment'),{segment:true})).bytes,1);
});

test('registry retains shared progression, publishes expiry, and resets after final release',async t=>{
    const f=fixture();let now=1000;const timers=new Map();let id=0;
    const registry=new Registry({managedClient:f.client,managedTransportHttp:f.http,clock:()=>now,
        setTimer:(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;},clearTimer:id=>timers.delete(id)});
    t.after(()=>registry.close());const a=registry.acquire(f.descriptor,()=>{});
    await new Promise(setImmediate);f.state.sequence++;
    const entry=[...registry.entries.values()][0];registry.clearTimer(entry.timer);
    await registry.poll(entry);assert.equal(a.getSnapshot().state,'ONLINE');
    const b=registry.acquire(f.descriptor,()=>{});assert.equal(b.getSnapshot().state,'ONLINE');
    now+=10001;assert.equal(b.getSnapshot().freshness,'EXPIRED');
    a.release();b.release();assert.equal(timers.size,0);
    const c=registry.acquire(f.descriptor,()=>{});await new Promise(setImmediate);
    assert.equal(c.getSnapshot().playlistProgressing,null);c.release();
});

test('AutoLive shadow waits for managed transport; transport is never decoder authority',async()=>{
    const f=fixture();let now=0;const decision=new Decision({clock:()=>now});
    const update=health=>decision.update({enabled:true,armed:true,sourceId:f.source.id,
        sourceFingerprint:f.descriptor.fingerprint,health:{...health,freshness:'FRESH',validUntil:100000}});
    assert.equal(update(await f.sample()).state,'WAITING_HEALTH');
    now=31000;assert.equal(update(await f.sample()).readyForEntry,false);
    f.state.sequence++;assert.equal(update(await f.sample()).state,'ENTRY_PENDING');
    now+=30000;f.state.sequence++;const result=update(await f.sample());
    assert.equal(result.readyForEntry,true);assert.equal(result.serverTake,false);assert.equal(result.executionAllowed,false);
});
