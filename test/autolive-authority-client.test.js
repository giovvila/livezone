import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import AutoLiveAuthorityClient from '../public/js/studio/AutoLiveAuthorityClient.js';
import AutoLiveLegacyBridge from '../public/js/studio/AutoLiveLegacyBridge.js';
import DominantLiveConfig from '../public/js/studio/DominantLiveConfig.js';
import SchedulerRuntimeState from '../public/js/scheduler/SchedulerRuntimeState.js';
import ControlEventStream from '../public/js/core/ControlEventStream.js';

const state=(revision=1,generation=revision,sessionId='server-a')=>({version:1,config:{version:1,revision,enabled:false,armed:true,sourceId:'live-a'},
    runtime:{executionAuthority:'browser-legacy',sessionId,generation,configRevision:revision},migration:{pristine:revision===0,completed:revision>0}});
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};};
class Stream extends EventTarget {readyState=1;close(){this.closed=true;}send(type,value){const e=new Event(type);e.data=JSON.stringify(value);this.dispatchEvent(e);}}

test('A1 client consumes retained state using the same physical Control SSE',async()=>{
    let sockets=0,physical;const owner=new ControlEventStream({baseUrl:'http://local/control/',lifecycle:new EventTarget(),eventSourceFactory:()=>{sockets++;return physical=new Stream();}});
    const presence=owner.presenceSource('/api/media-library/reference-presence?referenceClient=a');
    const program=owner.eventSource('/api/program-output/events'),schedule=owner.eventSource('/api/studio/schedule/events');
    const client=new AutoLiveAuthorityClient({request:async()=>response(state()),streamFactory:()=>owner.eventSource('/api/studio/schedule/events')});await client.start();
    physical.send('autolive-state',state(2));assert.equal(client.state.snapshot.config.revision,2);assert.equal(sockets,1);
    const late=owner.eventSource('/api/studio/schedule/events');let replay;late.addEventListener('autolive-state',e=>replay=JSON.parse(e.data));await Promise.resolve();assert.equal(replay.config.revision,2);
    client.destroy();assert.equal(physical.closed,undefined);late.close();program.close();schedule.close();presence.close();assert.equal(physical.closed,true);owner.destroy();
});
test('A1 client rejects old revision, old generation and retired session replay',async()=>{
    const client=new AutoLiveAuthorityClient({request:async()=>response(state(2))});await client.start();
    assert.equal(client.accept(state(1)),false);assert.equal(client.accept(state(2,1)),false);
    assert.equal(client.accept(state(2,1,'server-b')),true);assert.equal(client.accept(state(9,9,'server-a')),false);client.destroy();
});
test('A1 client sends revision and refreshes conflict without success',async()=>{
    const calls=[];const client=new AutoLiveAuthorityClient({request:async(url,options)=>{calls.push({url,options});return options?
        response({error:{code:'REVISION_CONFLICT'}},412):response(state(calls.length>1?2:1));}});await client.start();
    assert.deepEqual(await client.mutate({armed:false}),{ok:false,code:'REVISION_CONFLICT'});
    assert.equal(calls[1].options.headers['If-Match'],'"autolive-1"');assert.equal(client.state.snapshot.config.revision,2);client.destroy();
});
test('A1 bridge server config wins over local keys/storage events, replay does not renotify',async()=>{
    const local=storage(),config=new DominantLiveConfig({storage:local,eventTarget:new EventTarget()}),runtimeState=new SchedulerRuntimeState({storage:local});
    config.setArmed(false);let model=state();const client=new AutoLiveAuthorityClient({request:async(url,options)=>{
        if(options){model=state(model.config.revision+1);Object.assign(model.config,JSON.parse(options.body));}return response(model);}});
    const bridge=new AutoLiveLegacyBridge({client,config,runtimeState,lifecycle:new EventTarget()});await bridge.start();
    assert.equal(config.getSnapshot().armed,true);assert.equal(runtimeState.load().enabled,false);
    config.handleStorage({key:'livezone.studio.dominantLive.v1',newValue:JSON.stringify({version:1,armed:false,authorizedSourceId:'stale'})});
    assert.equal(config.getSnapshot().authorizedSourceId,'live-a');
    let notifications=0;config.subscribe(()=>notifications++);client.accept(model);assert.equal(notifications,1);
    assert.equal((await config.setArmed(false)).ok,true);assert.equal(config.getSnapshot().armed,false);
    assert.equal(JSON.parse(local.getItem('livezone.studio.dominantLive.v1')).armed,false);bridge.destroy();config.destroy();
});
test('A1 explicit bridge migration preserves two flags and never automatically imports',async()=>{
    const local=storage(),config=new DominantLiveConfig({storage:local,eventTarget:new EventTarget()}),runtimeState=new SchedulerRuntimeState({storage:local});
    config.setArmed(true);config.setAuthorizedSourceId('live-a');runtimeState.save(false);
    const calls=[];const client=new AutoLiveAuthorityClient({request:async(url,options)=>{calls.push({url,options});return response(state(options?1:0));}});
    const bridge=new AutoLiveLegacyBridge({client,config,runtimeState,lifecycle:new EventTarget()});await bridge.start();assert.equal(calls.length,1);
    assert.equal((await config.setArmed(false)).code,'MIGRATION_REQUIRED');assert.equal(calls.length,1);
    assert.equal((await bridge.migrate()).ok,true);const payload=JSON.parse(calls[1].options.body);
    assert.deepEqual(payload,{version:1,enabled:false,armed:true,sourceId:'live-a'});assert.equal(calls[1].url,'/api/studio/autolive/migrate');bridge.destroy();config.destroy();
});
test('A1 unreachable server preserves accepted config and reports failed mutation',async()=>{
    const local=storage(),config=new DominantLiveConfig({storage:local,eventTarget:new EventTarget()}),runtimeState=new SchedulerRuntimeState({storage:local});
    const client=new AutoLiveAuthorityClient({request:async(url,options)=>{if(options)throw Error('offline');return response(state());}});
    const bridge=new AutoLiveLegacyBridge({client,config,runtimeState,lifecycle:new EventTarget()});await bridge.start();
    assert.equal((await config.setArmed(false)).ok,false);assert.equal(config.getSnapshot().armed,true);assert.equal(config.lastWrite.ok,false);bridge.destroy();config.destroy();
});
test('A1 destroy while GET pending does not revive client',async()=>{
    let finish;const client=new AutoLiveAuthorityClient({request:()=>new Promise(r=>finish=r)});const starting=client.start();client.destroy();finish(response(state()));await starting;
    assert.equal(client.state.snapshot,null);
});
test('A1 Control bootstrap keeps one legacy executor and suspended scheduler; new client never constructs EventSource',()=>{
    const control=readFileSync(new URL('../public/js/entries/control-room-app.js',import.meta.url),'utf8');
    assert.equal((control.match(/new AutoLiveEntryController\(/g)||[]).length,1);assert.match(control,/programExecution: false/);
    assert.match(control,/streamFactory:.*controlEvents.eventSource/);
    const client=readFileSync(new URL('../public/js/studio/AutoLiveAuthorityClient.js',import.meta.url),'utf8');assert.doesNotMatch(client,/new EventSource/);
});

test('A1 bridge destroyed during bootstrap never changes legacy consent',async()=>{
    let finish;const local=storage(),config=new DominantLiveConfig({storage:local,eventTarget:new EventTarget()}),runtimeState=new SchedulerRuntimeState({storage:local});
    config.setArmed(true);const client=new AutoLiveAuthorityClient({request:()=>new Promise(r=>finish=r)});
    const bridge=new AutoLiveLegacyBridge({client,config,runtimeState,lifecycle:new EventTarget()});const starting=bridge.start();bridge.destroy();finish(response(state()));
    assert.equal(await starting,false);assert.equal(config.getSnapshot().armed,true);config.destroy();
});

test('review two client revisions, stale PATCH, explicit retry and storage cannot roll back',async()=>{
    let model=state(1),writes=0;const request=async(url,options)=>{
        if(!options)return response(structuredClone(model));writes++;
        if(options.headers['If-Match']!==`"autolive-${model.config.revision}"`)return response({error:{code:'REVISION_CONFLICT'}},412);
        const patch=JSON.parse(options.body),next=state(model.config.revision+1);next.config={...model.config,...patch,revision:next.config.revision};model=next;return response(structuredClone(model));
    };
    const a=new AutoLiveAuthorityClient({request}),b=new AutoLiveAuthorityClient({request});
    const config=new DominantLiveConfig({storage:storage(),eventTarget:new EventTarget()});const bridge=new AutoLiveLegacyBridge({client:b,config,runtimeState:new SchedulerRuntimeState({storage:storage()}),lifecycle:new EventTarget()});
    await a.start();await bridge.start();assert.equal((await a.mutate({armed:false})).ok,true);
    assert.equal((await b.mutate({sourceId:'live-b'})).code,'REVISION_CONFLICT');assert.equal(model.config.sourceId,'live-a');
    b.accept(structuredClone(model));config.handleStorage({key:'livezone.studio.dominantLive.v1',newValue:JSON.stringify({version:1,armed:true,authorizedSourceId:'stale'})});
    assert.equal(writes,2);assert.equal(config.getSnapshot().armed,false);assert.equal((await b.mutate({sourceId:'live-b'})).ok,true);assert.equal(model.config.armed,false);
    a.destroy();bridge.destroy();config.destroy();
});
for(const corrupt of [false,true])test('review pristine legacy '+(corrupt?'corrupt':'absent')+' storage is safe and never auto-imported',async()=>{
    const local=storage();if(corrupt){local.setItem('livezone.studio.dominantLive.v1','bad');local.setItem('livezone.scheduler.runtime.v1','bad');}
    const config=new DominantLiveConfig({storage:local,eventTarget:new EventTarget()}),runtimeState=new SchedulerRuntimeState({storage:local});let mutations=0;
    const client=new AutoLiveAuthorityClient({request:async(url,options)=>{if(options)mutations++;return response(state(0));}});
    const bridge=new AutoLiveLegacyBridge({client,config,runtimeState,lifecycle:new EventTarget()});await bridge.start();
    assert.deepEqual(bridge.legacy,{version:1,enabled:false,armed:false,sourceId:null});assert.equal(mutations,0);bridge.destroy();config.destroy();
});


test('A4 client posts browser stage without mutating config revision',async()=>{
    const calls=[];const client=new AutoLiveAuthorityClient({request:async(url,options)=>{
        calls.push({url,options});
        if(!options)return response(state(3));
        if(url.endsWith('/browser-stage'))return response({ok:true,runtime:{}});
        return response(state(3));
    }});
    await client.start();
    assert.deepEqual(await client.observeBrowserStage('LIVE'),{ok:true});
    assert.equal(calls.at(-1).url,'/api/studio/autolive/browser-stage');
    assert.equal(JSON.parse(calls.at(-1).options.body).stage,'LIVE');
    assert.equal(client.state.snapshot.config.revision,3);
    client.destroy();
});

test('A4 bridge reports LIVE and INACTIVE edges only',async()=>{
    const local=storage(),config=new DominantLiveConfig({storage:local,eventTarget:new EventTarget()}),runtimeState=new SchedulerRuntimeState({storage:local});
    const stages=[];const client=new AutoLiveAuthorityClient({request:async()=>response(state())});
    client.observeBrowserStage=async stage=>{stages.push(stage);return {ok:true};};
    const bridge=new AutoLiveLegacyBridge({client,config,runtimeState,lifecycle:new EventTarget()});await bridge.start();
    const listeners=new Set();let snapshot={session:null};const controller={subscribe(fn){listeners.add(fn);fn(snapshot);return()=>listeners.delete(fn);}};
    bridge.setBrowserStageProvider(()=>({controller,snapshot}));
    snapshot={session:{id:'s1'}};for(const fn of listeners)fn(snapshot);
    for(const fn of listeners)fn(snapshot);
    snapshot={session:null};for(const fn of listeners)fn(snapshot);
    await Promise.resolve();
    assert.deepEqual(stages,['INACTIVE','LIVE','INACTIVE']);
    bridge.destroy();config.destroy();
});


test('A4 Control diagnostics renders shadow transition state without execution claim',async()=>{
    const local=storage(),config=new DominantLiveConfig({storage:local,eventTarget:new EventTarget()}),runtimeState=new SchedulerRuntimeState({storage:local});
    const model=state();model.runtime={...model.runtime,decisionMode:'shadow',shadowDecisionState:'LOSS_PENDING',shadowEntryHealthyMs:30000,
        shadowEntryEligible:true,shadowLossMs:5000,shadowLossEligible:false,shadowLastTransitionAt:1000,
        shadowLastTransitionFrom:'LIVE_OBSERVED',shadowLastTransitionTo:'LOSS_PENDING'};
    model.runtime.healthObservation={authority:'external-hls-http',state:'OFFLINE',observedAt:1000,freshness:'FRESH',reason:'HTTP_ERROR',capabilities:{presenceEvidence:false,playlistProgressEvidence:true,segmentReachabilityEvidence:true,decoderProgressEvidence:false}};
    model.runtime.healthDiagnostics={httpStatus:403,httpStage:'manifest'};
    const client=new AutoLiveAuthorityClient({request:async()=>response(model)});
    const root={append(){}};const bridge=new AutoLiveLegacyBridge({client,config,runtimeState,lifecycle:new EventTarget(),root:null});
    const removable=()=>({remove(){}});
    bridge.indicator=removable();bridge.button=removable();bridge.healthIndicator=removable();await bridge.start();bridge.render();
    assert.match(bridge.healthIndicator.textContent,/DECISION LOSS_PENDING/);assert.match(bridge.healthIndicator.textContent,/LIVE_OBSERVED→LOSS_PENDING/);
    assert.match(bridge.healthIndicator.textContent,/HTTP 403\/manifest/);assert.match(bridge.healthIndicator.textContent,/execution=false/);
    assert.doesNotMatch(bridge.healthIndicator.textContent,/https?:|secret/i);
    bridge.destroy();config.destroy();
});
