import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import EventBus from '../public/js/core/EventBus.js';
import {StudioStateManager} from '../public/js/core/StudioStateManager.js';
import StudioCatalogManager from '../public/js/studio/StudioCatalogManager.js';
import SourceManager from '../public/js/studio/StudioSourceManager.js';
import {StudioGraphicsManager} from '../public/js/studio/StudioGraphicsManager.js';
import StudioRenderer from '../public/js/studio/StudioRenderer.js';
import StudioTransitionCoordinator from '../public/js/studio/StudioTransitionCoordinator.js';
import StudioProgramCommand from '../public/js/scheduler/StudioProgramCommand.js';
import ScheduleTargetResolver from '../public/js/scheduler/ScheduleTargetResolver.js';
import SchedulerEngine from '../public/js/scheduler/SchedulerEngine.js';
import SchedulerRuntimeState from '../public/js/scheduler/SchedulerRuntimeState.js';
import DominantLiveConfig from '../public/js/studio/DominantLiveConfig.js';
import AutoLiveAuthorityClient from '../public/js/studio/AutoLiveAuthorityClient.js';
import AutoLiveLegacyBridge from '../public/js/studio/AutoLiveLegacyBridge.js';
import AutoLiveEntryController from '../public/js/studio/AutoLiveEntryController.js';
import AutoLiveEntryPresentation from '../public/js/studio/AutoLiveEntryPresentation.js';
import SourcePresenceMonitor from '../public/js/studio/SourcePresenceMonitor.js';
import LiveSourceMonitor from '../public/js/studio/LiveSourceMonitor.js';
import {shareTechnicalLiveHealth} from '../public/js/studio/SharedLiveHealthConsumer.js';
import {restoreRetainedProgramIdentity} from '../public/js/studio/ProgramPlaybackContinuity.js';
import ProgramOutputManager from '../public/js/program-output/ProgramOutputManager.js';
import NetworkProgramOutputTransport from '../public/js/program-output/NetworkProgramOutputTransport.js';
import ControlEventStream from '../public/js/core/ControlEventStream.js';
import ProgramOutputStore from '../server/program-output/ProgramOutputStore.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
import {AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS} from '../public/js/studio/AutoLivePostTakePolicy.js';

const flush = async () => { for (let i=0;i<60;i++) await Promise.resolve(); };
// Real bootstrap modules and ordering; only browser media, HTTP and time are simulated.
async function bootstrap(t, {authorityBeforeAdoption=false, delayMapping=false}={}) {
    const dom=new JSDOM('<div id="preview"></div><div id="program"></div>', {url:'http://localhost/control/'});
    const oldDocument=globalThis.document;
    globalThis.document=dom.window.document;
    t.after(()=>{globalThis.document=oldDocument;dom.window.close();});
    t.mock.method(console,'log',()=>{});
    let now=Date.parse('2026-09-19T17:00:00Z'),serial=0,decoderReady=false;
    const timers=new Map();
    const setTimer=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:now+ms});return id;};
    const clearTimer=id=>timers.delete(id);
    t.mock.method(globalThis,'setTimeout',setTimer);
    t.mock.method(globalThis,'clearTimeout',clearTimer);
    t.mock.method(Date,'now',()=>now);
    const proto=dom.window.HTMLMediaElement.prototype;
    Object.defineProperties(proto,{readyState:{get:()=>decoderReady?4:0},paused:{get(){return this._paused??true;}},
        duration:{get:()=>600},ended:{get:()=>false},seekable:{get:()=>({length:1,start:()=>0,end:()=>600})}});
    proto.canPlayType=()=> 'probably';proto.load=()=>{};
    proto.play=async function(){this._paused=false;
        if(!decoderReady){this.dispatchEvent(new dom.window.Event('waiting'));
            queueMicrotask(()=>{this._paused=true;this.dispatchEvent(new dom.window.Event('error'));});return;}
        this.dispatchEvent(new dom.window.Event('loadeddata'));this.dispatchEvent(new dom.window.Event('playing'));};
    proto.pause=function(){this._paused=true;this.dispatchEvent(new dom.window.Event('pause'));};
    const storage=dom.window.localStorage;
    const source={id:'primecast',name:'primecast',kind:'hls',enabled:true,url:'https://example.test/live.m3u8'};
    const scenes=[{id:'LIVE',name:'primecast',type:'LIVE',renderer:{kind:'source',sourceId:source.id}},
        {id:'P',name:'Preview',type:'SLATE',renderer:{kind:'slate',title:'Preview',message:'Preview',logo:'http://localhost/logo.svg'}}];
    storage.setItem('livezone.studio.selection.v1',JSON.stringify({version:1,programSceneId:'LIVE',previewSceneId:'P'}));
    const store=new ProgramOutputStore();
    const timestamp=new Date(now-10000).toISOString();
    assert.equal(store.accept(createProgramOutputEnvelope({version:1,publisherSessionId:'before-refresh',revision:9,
        publishedAt:timestamp,committedAt:timestamp,scene:scenes[0],source,
        playback:{initialTime:0,duration:null,playing:true,ended:false,state:'playing',startedAt:timestamp},
        graphics:{items:[]},transition:{type:'cut',durationMs:0}})).accepted,true);
    const state=new StudioStateManager({storage,eventTarget:null});state.initialize();
    const sources=new SourceManager.constructor();sources.initialize({});
    const catalog=new StudioCatalogManager({studioStateManager:state,studioSourceManager:sources,storage:null,
        baseUrl:dom.window.location.href,eventTarget:null});
    catalog.initialize({sources:[source],scenes});
    const wire=new EventTarget();wire.readyState=1;wire.close=()=>{};
    const send=envelope=>wire.dispatchEvent(Object.assign(new Event('program'),{data:JSON.stringify(envelope)}));
    const events=new ControlEventStream({eventSourceFactory:()=>wire,baseUrl:dom.window.location.href,lifecycle:{},setTimer,clearTimer});
    events.presenceSource('/api/media-library/reference-presence');
    send(store.getCurrent());
    const offStore=store.subscribe(send),published=[];
    const transport=new NetworkProgramOutputTransport({role:'publisher',publishUrl:'/api/program-output',subscribeUrl:'/api/program-output/events',
        baseUrl:dom.window.location.href,tokenProvider:()=> 'isolated-test-token',eventSourceFactory:events.eventSource,setTimer,clearTimer,
        fetchImplementation:async(_url,options)=>{const envelope=JSON.parse(options.body);published.push(envelope.snapshot);
            const result=store.accept(envelope);assert.equal(result.accepted,true);return {ok:true,status:202};}});
    const retainedProgram=await transport.readRetained();
    const resolved=restoreRetainedProgramIdentity(retainedProgram,{stateManager:state,catalog,sourceManager:sources});
    assert.equal(resolved,true);
    const graphics=new StudioGraphicsManager();graphics.initialize();
    const renderer=new StudioRenderer({previewRoot:document.getElementById('preview'),programRoot:document.getElementById('program'),
        studioStateManager:state,definitionRegistry:catalog,studioSourceManager:sources,studioGraphicsManager:graphics});
    renderer.start();
    const coordinator=new StudioTransitionCoordinator({studioStateManager:state,studioRenderer:renderer});coordinator.start();
    const output=new ProgramOutputManager({stateManager:state,catalog,sourceManager:sources,renderer,graphicsManager:graphics,
        transitionCoordinator:coordinator,transport});output.start();
    const config=new DominantLiveConfig({storage,eventTarget:null});
    const runtimeState=new SchedulerRuntimeState({storage});
    let authority={version:1,config:{version:1,revision:1,enabled:!authorityBeforeAdoption,armed:true,sourceId:source.id},
        runtime:{executionAuthority:'browser-legacy',sessionId:'server-autolive',generation:1,configRevision:1},
        migration:{pristine:false,completed:true}};
    const client=new AutoLiveAuthorityClient({streamFactory:()=>events.eventSource('/api/studio/schedule/events'),
        request:async()=>({ok:true,json:async()=>authority})});
    const bridge=new AutoLiveLegacyBridge({client,config,runtimeState,lifecycle:{}});await bridge.start();
    const command=new StudioProgramCommand({stateManager:state,catalog,transitionCoordinator:coordinator,
        targetResolver:new ScheduleTargetResolver({catalog})});
    const scheduler=new SchedulerEngine({command,catalog,programTransportProvider:()=>renderer.getProgramTransport(),
        runtimeState,programExecution:false,setTimer,clearTimer});bridge.attachEngine(scheduler);scheduler.restoreEnabledState();
    const calls={release:0,execute:0,commitPrepared:0,beginInterruption:0},closures=[],phases=[];
    for(const method of ['release','execute','commitPrepared']){const original=command[method].bind(command);
        t.mock.method(command,method,(...args)=>{calls[method]++;return original(...args);});}
    const begin=scheduler.beginInterruption.bind(scheduler);
    t.mock.method(scheduler,'beginInterruption',(...args)=>{calls.beginInterruption++;return begin(...args);});
    let online=false;
    const technical=new LiveSourceMonitor({consumerFactory:(_source,handlers)=>({
        start(){online?handlers.online():handlers.offline();},destroy(){}}),setTimer,clearTimer});
    technical.selectSource(catalog.getSources()[0]);
    let resolveMapping;
    const mapping=new Promise(resolve=>{resolveMapping=resolve;});
    if(!delayMapping)resolveMapping();
    const monitor=new SourcePresenceMonitor({setTimer,clearTimer,
        externalConsumerFactory:shareTechnicalLiveHealth(technical,()=>{throw Error('unexpected fallback');}),
        fetchImplementation:async()=>{await mapping;return {ok:true,status:200,json:async()=>({ingestId:'managed',
            playbackHlsUrl:'http://localhost/managed/index.m3u8'})};}});
    const controller=new AutoLiveEntryController({renderer,retainedProgramIdentityResolved:resolved,retainedProgram,
        config,catalog,monitor,scheduler,command,targetResolver:new ScheduleTargetResolver({catalog,namespace:'dominant-live-source'}),setTimer,clearTimer});
    const end=controller.endSession.bind(controller);
    t.mock.method(controller,'endSession',reason=>{closures.push(reason);return end(reason);});
    controller.subscribe(snapshot=>phases.push(snapshot.phase));
    controller.start();
    const binding=new AutoLiveEntryPresentation({controller,output,renderer,stateManager:state,root:renderer.program.root,
        logoUrl:'http://localhost/logo.svg',setTimer,clearTimer});binding.start();
    t.after(()=>{bridge.destroy();output.destroy();events.destroy();controller.destroy();binding.destroy();scheduler.destroy();
        technical.destroy();coordinator.destroy();renderer.destroy();offStore();EventBus.listeners.clear();});
    await flush();
    if(authorityBeforeAdoption){
        assert.equal(controller.session,null);
        assert.equal(controller.health.authority,'external-hls');
        authority={...authority,config:{...authority.config,enabled:true,revision:2},runtime:{...authority.runtime,configRevision:2}};
        client.accept(authority);await flush();
    }
    assert.equal(controller.session?.retained,true);
    const advance=async ms=>{const until=now+ms;while(now<until){now=Math.min(until,now+250);
        for(const video of document.querySelectorAll('video'))if(!video.paused&&video.readyState>=2){video.currentTime+=.25;
            video.dispatchEvent(new dom.window.Event('timeupdate'));}
        for(const [id,timer] of [...timers])if(timer.at<=now&&timers.has(id)){timers.delete(id);timer.fn();}
        await flush();}};
    return {controller,state,calls,closures,phases,published,advance,resolveMapping,monitor,
        recover:async()=>{decoderReady=true;online=true;technical.selectSource(catalog.getSources()[0]);
            for(const video of document.querySelectorAll('video'))await video.play();await advance(1000);}};
}

function retained(h){
    assert.equal(h.controller.session?.phase,'LIVE');assert.equal(h.controller.session.retained,true);
    assert.equal(h.controller.activeHealth?.current(),true);assert.equal(h.controller.retainedAdoptionPending,false);
    assert.equal(h.state.getProgramSceneId(),'LIVE');assert.equal(h.state.getPreviewSceneId(),'P');
    assert.deepEqual(h.calls,{release:0,execute:0,commitPrepared:0,beginInterruption:0});
    assert.deepEqual(h.closures,[]);assert.equal(h.phases.includes('PREPARING'),false);
    assert.equal(h.published.some(s=>s.source?.id==='autolive-entry-slate'),false);
}

test('retained LIVE survives reload failure and recovery with external authority already known',async t=>{
    const h=await bootstrap(t,{authorityBeforeAdoption:true});
    await h.advance(6250);await h.recover();retained(h);
    assert.equal(h.controller.acquisitionState,'ON_AIR');
});

test('retained LIVE attaches delayed external authority before legacy loss can close it',async t=>{
    const h=await bootstrap(t,{delayMapping:true});
    assert.equal(h.controller.activeHealth?.current()??false,false);
    // Resolve inside the bounded mapping request, after initial CHECKING has arrived.
    await h.advance(1000);h.resolveMapping();await flush();
    assert.equal(h.controller.activeHealth?.current(),true,'late external authority must establish active health ownership');
    const owner=h.controller.activeHealth;
    await h.advance(6250);await h.recover();retained(h);
    assert.equal(h.controller.activeHealth,owner,'repeated health observations must not replace the owner');
    assert.equal(h.controller.acquisitionState,'ON_AIR');
});

test('retained LIVE still closes once after persistent active-health confirmed loss',async t=>{
    const h=await bootstrap(t);
    await h.advance(6000);retained(h);
    const deadline=h.controller.activeHealth.confirmedSince+AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS;
    await h.advance(deadline-Date.now()-1);retained(h);
    await h.advance(1);await flush();
    assert.equal(h.controller.session,null);assert.equal(h.state.getProgramSceneId(),null);
    assert.deepEqual(h.closures,['source-loss']);assert.equal(h.calls.release,1);
    assert.equal(h.calls.beginInterruption,0);assert.equal(h.state.getPreviewSceneId(),'P');
    await h.advance(5000);assert.equal(h.calls.release,1);
});
