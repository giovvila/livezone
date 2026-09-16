import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';
import Registry,{ManagedIngestHealthProducer} from '../server/autolive/AutoLiveHealthRegistry.js';
import {observation,capabilities,freshObservation,resolveHealthSource} from '../server/autolive/AutoLiveHealthContract.js';
import SafeHttp from '../server/autolive/AutoLiveSafeHttp.js';import Authority from '../server/autolive/AutoLiveAuthority.js';
import Feed from '../server/program-output/ControlEventFeed.js';import Inventory from '../server/media-library/AssetReferenceInventory.js';
import IngestClient from '../server/media-ingest/MediaIngestStatusClient.js';import IngestConfig from '../server/media-ingest/MediaIngestConfig.js';
import compareHealth from '../public/js/studio/AutoLiveShadowComparison.js';
const flush=()=>new Promise(setImmediate);
const sample={state:'ONLINE',reason:'PUBLISHER_TRACKS_PRESENT',publisherPresent:true,readiness:'publisher-present'};
const source=()=>resolveHealthSource({id:'live',kind:'hls',url:'https://public.example.com/live.m3u8'});
function timers(){let now=1000,next=0;const queue=new Map();return {clock:()=>now,setTimer:(fn,delay)=>{const id=++next;queue.set(id,{fn,at:now+delay});return id;},clearTimer:id=>queue.delete(id),queue,
    async advance(ms){now+=ms;for(const [id,item] of [...queue])if(item.at<=now){queue.delete(id);item.fn();}await flush();}};}
async function waitFor(predicate){for(let n=0;n<200;n++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('condition timed out');}
const descriptor=source();
const valid=()=>({version:1,sourceId:'live',sourceFingerprint:descriptor.fingerprint,endpointFingerprint:descriptor.endpointFingerprint,authority:'external-hls-http',sessionId:'session',generation:1,sequence:1,observedAt:1000,validUntil:2000,state:'ONLINE',reason:'PLAYLIST_ADVANCING',publisherPresent:null,playbackAvailable:true,playbackProgressing:null,playlistProgressing:true,segmentReachable:true,readiness:'transport-only',freshness:'FRESH',uncertain:false,capabilities:capabilities('external-hls-http')});
test('A2 health contract serialization, capability split and expiry',()=>{
    const value=observation(valid());assert.deepEqual(observation(JSON.parse(JSON.stringify(value))),value);
    assert.equal(freshObservation(value,2001).state,'UNKNOWN');assert.equal(freshObservation(value,2001).playlistProgressing,null);assert.equal(value.capabilities.decoderProgressEvidence,false);
});
for(const patch of [{sequence:0},{generation:-1},{validUntil:999},{sourceFingerprint:'bad'},{playbackProgressing:true},{state:'LIVE'},{reason:'http://secret/'},{extra:'x'}, {capabilities:{decoderProgressEvidence:true}}])test('A2 strict health rejects '+JSON.stringify(patch),()=>assert.throws(()=>observation({...valid(),...patch})));
test('A2 fingerprints fence same ID with changed URL, query, configRef resolution or revision',()=>{
    const base={id:'live',kind:'hls',url:'https://example.com/live?secret=one'},first=resolveHealthSource(base);
    for(const changed of [{...base,url:'https://example.com/live?secret=two'},{...base,revision:2},{...base,configRef:'live.url'}])assert.notEqual(resolveHealthSource(changed).fingerprint,first.fingerprint);
    assert.notEqual(resolveHealthSource({id:'live',kind:'hls',configRef:'live.url'},()=>base.url).fingerprint,resolveHealthSource({id:'live',kind:'hls',configRef:'live.url'},()=>base.url+'2').fingerprint);
    assert.equal(first.fingerprint.includes('secret'),false);
});
test('A2 registry deduplicates, retains, rejects stale sequence and cleans last release',async()=>{
    const time=timers();let calls=0;const registry=new Registry({...time,producerFactory:()=>({sample:async()=>{calls++;return sample;}})});
    const a=[],b=[];const first=registry.acquire(source(),v=>a.push(v));await flush();const second=registry.acquire(source(),v=>b.push(v));await flush();
    assert.equal(calls,1);assert.equal(registry.entries.size,1);assert.equal(b[0].state,'ONLINE');
    const entry=[...registry.entries.values()][0];assert.equal(registry.accept(entry,{...entry.value,sequence:1}),false);
    assert.equal(registry.accept(entry,{...entry.value,sequence:99,generation:99}),false);
    assert.equal(registry.accept(entry,{...entry.value,sequence:99,sourceFingerprint:'a'.repeat(64)}),false);
    first.release();assert.equal(registry.entries.size,1);second.release();assert.equal(registry.entries.size,0);assert.equal(time.queue.size,0);registry.close();
});
test('A2 freshness expires during stalled request; source switch aborts and fences stale callback',async()=>{
    const time=timers();let finish,aborted=false,calls=0;
    const registry=new Registry({...time,ttlMs:20,intervalMs:5,timeoutMs:100,producerFactory:()=>({sample:async(s,signal)=>{calls++;if(calls===1)return sample;return new Promise(r=>{finish=r;signal.addEventListener('abort',()=>aborted=true);});}})});
    const values=[];const lease=registry.acquire(source(),v=>values.push(v));await flush();await time.advance(6);await time.advance(20);
    assert.equal(lease.getSnapshot().state,'UNKNOWN');assert.equal(values.at(-1).freshness,'EXPIRED');
    const oldGeneration=values[0].generation,oldFinish=finish;lease.release();assert.equal(aborted,true);
    const changed=resolveHealthSource({id:'live',kind:'hls',url:'https://other.example.com/live'});const next=[];const nextLease=registry.acquire(changed,v=>next.push(v));await flush();
    oldFinish(sample);await flush();assert.equal(next.length,1);assert.equal(next[0].state,'CHECKING');assert.ok(next[0].generation>oldGeneration);assert.equal(next[0].sourceFingerprint,changed.fingerprint);nextLease.release();registry.close();
});
for(const state of ['offline','connecting','error','live'])test('A2 managed '+state+' evidence has no playback claim',async()=>{
    const config=new IngestConfig();const client={config,getStatus:async options=>{assert.equal(options.sourceOnly,true);return {...config.toPublic(),state,health:{publisherPresent:state==='live'}};}};
    const desc=resolveHealthSource({id:'live',kind:'hls',url:config.playbackHlsUrl},()=>null,config);
    const value=await new ManagedIngestHealthProducer(client).sample(desc,new AbortController().signal);
    assert.equal(value.state,{offline:'OFFLINE',connecting:'UNCERTAIN',error:'ERROR',live:'ONLINE'}[state]);assert.equal(value.playbackAvailable,null);
});
test('A2 managed descriptor requires exact mapping and rejects changed ingest ID',async()=>{
    const config=new IngestConfig(),desc=resolveHealthSource({id:'live',kind:'hls',url:config.playbackHlsUrl},()=>null,config);
    assert.equal(desc.authority,'managed-ingest');assert.equal(resolveHealthSource({id:'live',kind:'hls',url:config.playbackHlsUrl+'?x=1'},()=>null,config).authority,'external-hls-http');
    const client={config,getStatus:async()=>({...config.toPublic(),ingestId:'wrong'})};await assert.rejects(new ManagedIngestHealthProducer(client).sample(desc),{code:'MAPPING_MISMATCH'});
});
test('A2 managed complete body timeout and abort are bounded',async()=>{
    const config=new IngestConfig({timeoutMs:100});let aborted=false;
    const client=new IngestClient({config,fetchImplementation:async(url,{signal})=>{signal.addEventListener('abort',()=>aborted=true);return {ok:true,json:()=>new Promise(()=>{})};}});
    assert.equal((await client.getStatus({sourceOnly:true})).state,'error');assert.equal(aborted,true);
    const controller=new AbortController();const request=client.getStatus({sourceOnly:true,signal:controller.signal});controller.abort();assert.equal((await request).state,'error');
});
for(const mode of ['managed','external'])test('A2 Control CLOSED '+mode+' health, late feed, disable and restart without execution',async t=>{
    const root=await mkdtemp(join(tmpdir(),'lz-a2-authority-'));let server,owner,registry;let sequence=1;
    let config=new IngestConfig();let url=config.playbackHlsUrl;
    if(mode==='managed'){
        server=createServer((req,res)=>{assert.equal(req.url,'/v3/paths/list');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items:[{name:config.mediaPath,online:true,source:{type:'rtmpSession'},tracks2:['H264']}]}));});
        await new Promise(r=>server.listen(0,'127.0.0.1',r));config=new IngestConfig({apiOrigin:`http://127.0.0.1:${server.address().port}`});
    }
    if(mode==='external'){
        server=createServer((req,res)=>res.end(req.url.endsWith('.ts')?'x':`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${sequence++}\n#EXTINF:1,\nx-${sequence}.ts`));await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}/live.m3u8`;
    }
    const options={path:join(root,'config.json'),recoveryPath:join(root,'recovery.json'),catalog:()=>({initialized:true,sources:[{id:'live',kind:'hls',url}],scenes:[]}),managedConfig:config};
    const makeRegistry=()=>new Registry({intervalMs:10,managedClient:new IngestClient({config}),http:new SafeHttp({parseUrl:v=>new URL(v),allowAddress:ip=>ip==='127.0.0.1'})});
    t.after(async()=>{await owner?.close();registry?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(root,{recursive:true,force:true});});
    registry=makeRegistry();owner=new Authority({...options,healthRegistry:registry});await owner.ready;
    await owner.mutate({enabled:true,armed:true,sourceId:'live'},0);await waitFor(()=>owner.current().runtime.healthState==='ONLINE');
    const current=owner.current();assert.equal(current.runtime.executionAuthority,'browser-legacy');assert.equal(current.runtime.entryHealthyMs,0);assert.equal(current.runtime.deadline,null);assert.equal(current.runtime.healthObservation.playbackProgressing,null);
    const before=registry.entries.size;const noop=()=>()=>{};const feed=new Feed({autoLive:owner,effectiveOutput:{subscribe:noop,getCurrent:()=>null},scheduler:{subscribe:noop,current:()=>({programPlan:{execution:'SUSPENDED'}})}});
    const packets=[];const response={write:p=>{packets.push(p);return true;},end(){}};feed.connect(response);assert.ok(packets.some(p=>p.includes('autolive-state')&&p.includes('ONLINE')));assert.equal(registry.entries.size,before);feed.close();
    const asset={id:'asset-00000000-0000-4000-8000-000000000001',kind:'video'};const inventory=new Inventory({repository:{list:()=>[asset]},inventories:()=>owner.references()});assert.equal((await inventory.inspect(asset)).status,'UNUSED');
    const session=current.runtime.healthObservation.sessionId;await owner.close();registry.close();registry=makeRegistry();owner=new Authority({...options,healthRegistry:registry});await owner.ready;
    assert.notEqual(owner.current().runtime.healthObservation.sessionId,session);assert.equal(owner.current().runtime.healthObservation.state,'CHECKING');
    await owner.mutate({enabled:false},1);assert.equal(registry.entries.size,0);assert.equal(owner.current().runtime.healthState,'UNKNOWN');assert.equal(owner.current().runtime.entryHealthyMs,0);
});
test('A2 shadow comparison is local, endpoint-fenced and explicitly not decoder-equivalent',async()=>{
    const result=await compareHealth(valid(),{sourceId:'live',endpoint:'https://public.example.com/live.m3u8',state:'ONLINE',checkedAt:900});
    assert.equal(result.endpointMatch,true);assert.equal(result.stateAgreement,true);assert.equal(result.timestampDeltaMs,100);assert.equal(result.progressionAgreement,null);
    assert.equal((await compareHealth(valid(),{sourceId:'other',endpoint:'https://other.example.com',state:'ONLINE'})).stateAgreement,null);
    assert.doesNotMatch(JSON.stringify(result),/https:|secret/);
});
