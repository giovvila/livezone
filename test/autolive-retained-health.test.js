import DurableProgramRepository from '../server/program-output/DurableProgramRepository.js';
import ProgramCommitCoordinator from '../server/program-output/ProgramCommitCoordinator.js';
import ProgramRestoreValidation from '../server/program-output/ProgramRestoreValidation.js';
import {activateBrowserExecution} from '../public/js/studio/BrowserExecutionActivation.js';
import RestartReconciliation from '../server/autolive/RestartReconciliation.js';
import BrowserExecutionOwnership from '../server/autolive/BrowserExecutionOwnership.js';
import BrowserExecutionOwnershipClient from '../public/js/studio/BrowserExecutionOwnershipClient.js';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
import DominantLiveUI from '../public/js/ui/DominantLiveUI.js';
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
async function bootstrap(t, {authorityBeforeAdoption=false, delayMapping=false, fenced=false, secondTab=false, entry=false, restarted=false, initialOnline=false, reconcile=false,durable=false,deferRenderer=false}={}) {
    const dom=new JSDOM('<div id="preview"></div><div id="program"></div>', {url:'http://localhost/control/'});
    const oldDocument=globalThis.document;
    globalThis.document=dom.window.document;
    t.after(()=>{globalThis.document=oldDocument;dom.window.close();});
    t.mock.method(console,'log',()=>{});
    let now=Date.parse('2026-09-19T17:00:00Z'),serial=0,decoderReady=entry||reconcile;
    const timers=new Map();
    const setTimer=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:now+ms});return id;};
    const clearTimer=id=>timers.delete(id);
    t.mock.method(globalThis,'setTimeout',setTimer);
    t.mock.method(globalThis,'clearTimeout',clearTimer);
    t.mock.method(Date,'now',()=>now);
    const proto=dom.window.HTMLMediaElement.prototype;
    Object.defineProperties(proto,{readyState:{get:()=>decoderReady?4:0},paused:{get(){return this._paused??true;}},
        duration:{get:()=>600},ended:{get:()=>false},seekable:{get:()=>({length:1,start:()=>0,end:()=>600})}});
    if(durable){const nativeSrc=Object.getOwnPropertyDescriptor(proto,'src');Object.defineProperty(proto,'src',{get:nativeSrc.get,set(value){nativeSrc.set.call(this,value);queueMicrotask(()=>{if(this.isConnected){this.dispatchEvent(new dom.window.Event('loadedmetadata'));this.dispatchEvent(new dom.window.Event('loadeddata'));}});}});}
    if(durable)Object.defineProperty(proto,'currentTime',{get(){return this._time||0;},set(value){this._time=value;queueMicrotask(()=>{if(this.isConnected)this.dispatchEvent(new dom.window.Event('seeked'));});}});
    proto.canPlayType=()=> 'probably';proto.load=()=>{};
    proto.play=async function(){this._paused=false;
        if(!decoderReady){this.dispatchEvent(new dom.window.Event('waiting'));
            queueMicrotask(()=>{this._paused=true;this.dispatchEvent(new dom.window.Event('error'));});return;}
        this.dispatchEvent(new dom.window.Event('loadeddata'));this.dispatchEvent(new dom.window.Event('playing'));};
    proto.pause=function(){this._paused=true;this.dispatchEvent(new dom.window.Event('pause'));};
    const storage=dom.window.localStorage;
    const source={id:'primecast',name:'primecast',kind:'hls',enabled:true,url:'https://example.test/live.m3u8'};
    const clip={id:'clip',name:'retained video',kind:'media',url:'http://localhost/clip.mp4',enabled:true};
    const scenes=[{id:'LIVE',name:'primecast',type:'LIVE',renderer:{kind:'source',sourceId:source.id}},
        {id:'P',name:'Preview',type:'SLATE',renderer:{kind:'slate',title:'Preview',message:'Preview',logo:'http://localhost/logo.svg'}}, {id:'A',name:'retained video',type:'MEDIA',renderer:{kind:'source',sourceId:'clip'}}];
    storage.setItem('livezone.studio.selection.v1',JSON.stringify({version:1,programSceneId:entry?'A':'LIVE',previewSceneId:'P'}));
    const store=new ProgramOutputStore();
    const timestamp=new Date(now-10000).toISOString();
    assert.equal(store.accept(createProgramOutputEnvelope({version:1,publisherSessionId:'before-refresh',revision:9,
        publishedAt:timestamp,committedAt:timestamp,scene:entry?scenes[2]:scenes[0],source:entry?clip:source,
        playback:{initialTime:0,duration:null,playing:true,ended:false,state:'playing',startedAt:timestamp},
        graphics:{items:[]},transition:{type:'cut',durationMs:0}})).accepted,true);
    let durableRepository;
    if(durable){
        const dir=await mkdtemp(join(tmpdir(),'lz-dp1-production-'));t.after(()=>rm(dir,{recursive:true,force:true}));
        const path=join(dir,'program.json'),validation=new ProgramRestoreValidation({catalog:()=>({initialized:true,sources:[source,clip],scenes}),assets:{list:()=>[]}});
        const prior=store.getCurrent();store.current=null;
        const writer=new ProgramCommitCoordinator({store,repository:new DurableProgramRepository({path}),bind:s=>validation.bind(s),validate:r=>validation.validate(r)});
        await writer.initialize();assert.equal((await writer.accept(prior,{check:()=>true})).accepted,true);
        store.current=null;durableRepository=new DurableProgramRepository({path});
        await new ProgramCommitCoordinator({store,repository:durableRepository,validate:r=>validation.validate(r)}).initialize();
        assert.deepEqual(store.getCurrent(),prior);
    }
    const state=new StudioStateManager({storage,eventTarget:null});state.initialize();
    const sources=new SourceManager.constructor();sources.initialize({});
    const catalog=new StudioCatalogManager({studioStateManager:state,studioSourceManager:sources,storage:null,
        baseUrl:dom.window.location.href,eventTarget:null});
    catalog.initialize({sources:[source,clip],scenes});
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
    if(!deferRenderer)renderer.start();
    const coordinator=new StudioTransitionCoordinator({studioStateManager:state,studioRenderer:renderer});coordinator.start();
    const output=new ProgramOutputManager({stateManager:state,catalog,sourceManager:sources,renderer,graphicsManager:graphics,
        transitionCoordinator:coordinator,transport});
    let execution,executionServer;
    if(fenced){
        const dir=await mkdtemp(join(tmpdir(),'lz-owner-bootstrap-'));
        if(restarted)await writeFile(join(dir,'execution'),JSON.stringify({epoch:13}));
        executionServer=new BrowserExecutionOwnership({path:join(dir,'execution'),clock:()=>now,leaseMs:15000});await executionServer.ready;
        if(secondTab)await executionServer.operate({operation:'acquire',ownerInstanceId:'first-tab',publisherSessionId:'first-publisher'},'operator');
        const reconciliation=new RestartReconciliation({ownership:executionServer,store,configuration:()=>({available:true,revision:1,sourceFingerprint:source.url}),clock:()=>now});
        execution=new BrowserExecutionOwnershipClient({clock:()=>now,setTimer,clearTimer,request:async(url,options)=>{
            if(url==='/api/studio/execution-ownership'){
                const value=JSON.parse(options.body);
                return {ok:true,json:async()=>{
                    const result=await (['prepare-reconciliation','reconcile'].includes(value.operation)?reconciliation.execute(value,'operator'):executionServer.operate(value,'operator'));
                    return {...result,...(durable&&result.grant?{durableBinding:{version:1,generation:durableRepository.record.generation,
                        authorityEpoch:executionServer.authorityEpoch,authorityProcessSession:executionServer.authorityProcessSession,
                        publisherSessionId:result.retainedProgram?.publisherSessionId,revision:result.retainedProgram?.revision}}:{})};
                }};
            }
            const envelope=JSON.parse(options.body),grant=JSON.parse(options.headers['X-Livezone-Execution-Grant']||'null');
            if(!executionServer.matches(grant,'operator',envelope.publisherSessionId))return {ok:false,status:409,json:async()=>({error:'execution-owner-required'}),clone(){return this;}};
            published.push(envelope.snapshot);const result=store.accept(envelope);assert.equal(result.accepted,true);return {ok:true,status:202};
        }});
        transport.executionOwnership=execution;output.publisherSessionId=execution.publisherSessionId;output.snapshot=retainedProgram;
        await execution.start();output.executionReady=Boolean(execution.valid());
        t.after(async()=>{execution.close();await executionServer.close();await rm(dir,{recursive:true,force:true});});
    }
    output.start();
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
    let online=initialOnline;
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
    const decisions=[];const evaluate=controller.evaluate.bind(controller);
    t.mock.method(controller,'evaluate',()=>{
        const source=controller.getAuthorizedSource(),target=controller.resolveTarget(source);
        const d={started:Boolean(controller.started),armed:config.getSnapshot().armed,
            schedulerEnabled:Boolean(controller.schedulerSnapshot?.enabled),schedulerInterrupted:Boolean(controller.schedulerSnapshot?.interruptionContext),
            executable:!execution||Boolean(execution.valid()),authorizedSourceId:source?.id,healthSourceId:controller.health.sourceId,
            healthSourceMatch:controller.health.sourceId===source?.id,healthOnline:controller.health.state==='ONLINE',generation:controller.health.generation,
            retainedPending:Boolean(controller.retainedAdoptionPending),session:controller.session?.phase||null,pendingSession:Boolean(controller.pendingSession),
            closingSession:Boolean(controller.closingSession),latched:Boolean(controller.latched),reacquisitionSuppressed:Boolean(controller.reacquisitionSuppressed),
            transitionBusy:Boolean(command.transitionCoordinator?.isBusy()),targetScene:target?.sceneId,programScene:state.getProgramSceneId(),
            programTargetMatch:state.getProgramSceneId()===target?.sceneId,preparationReady:Boolean(renderer.program.prepared?.ready)};
        decisions.push(d);if(decisions.length>64)decisions.shift();return evaluate();
    });
    const end=controller.endSession.bind(controller);
    t.mock.method(controller,'endSession',reason=>{closures.push(reason);return end(reason);});
    controller.subscribe(snapshot=>phases.push(snapshot.phase));
    if(execution)controller.executionOwnership=execution;
    controller.start();
    execution?.subscribe(owner=>{
        if(!owner.valid()){output.executionReady=false;if(controller.started)controller.suspendOwnership();return;}
        if(reconcile&&owner.retainedProgram){
            void activateBrowserExecution({owner,current:owner.retainedProgram,controller,output,renderer,stateManager:state,catalog,sourceManager:sources});
        }
    });
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
    if(!secondTab&&!entry&&!restarted)assert.equal(controller.session?.retained,true);
    const advance=async ms=>{const until=now+ms;while(now<until){now=Math.min(until,now+250);
        for(const video of document.querySelectorAll('video'))if(!video.paused&&video.readyState>=2){video.currentTime+=.25;
            video.dispatchEvent(new dom.window.Event('timeupdate'));}
        for(const [id,timer] of [...timers])if(timer.at<=now&&timers.has(id)){timers.delete(id);timer.fn();}
        await flush();}};
    return {controller,state,calls,closures,phases,published,advance,resolveMapping,monitor,execution,executionServer,output,technical,decisions,
        hydrateRenderer:async()=>{renderer.start();await flush();},
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

for(const variant of ['health-already-online','external-authority-delayed','grant-before-renderer','publisher-snapshot-late','monitor-offline-program-progress'])
test('DP1 activation readiness ordering: '+variant,async t=>{
 const h=await bootstrap(t,{fenced:true,restarted:true,reconcile:true,durable:true,initialOnline:variant!=='monitor-offline-program-progress',
  delayMapping:variant==='external-authority-delayed',deferRenderer:variant==='grant-before-renderer'});
 if(variant==='publisher-snapshot-late')h.output.snapshot=null; // Before activation, not a started controller mutation.
 const program=h.state.getProgramSceneId(),preview=h.state.getPreviewSceneId(),publications=h.published.length;
 const prepared=await h.execution.reconcileRequest('prepare-reconciliation');
 const result=await h.execution.reconcileRequest('reconcile',prepared);assert.ok(result.grant);await flush();
 if(variant==='external-authority-delayed'){h.resolveMapping();await flush();}
 if(variant==='grant-before-renderer')await h.hydrateRenderer();
 await h.advance(125000);
 const c=h.controller;
 const root=document.createElement('div');
 root.innerHTML='<input id="dominant-live-armed" type="checkbox"><span id="dominant-live-status"></span><span id="dominant-live-source"></span>';
 const ui=new DominantLiveUI({root,controller:c,config:c.config});ui.start();t.after(()=>ui.destroy());
 t.diagnostic(JSON.stringify({variant,grantPresent:Boolean(h.execution.grant),leaseValid:Boolean(h.execution.valid()),
  ownership:h.execution.state.state,grantRevision:h.execution.grant?.grantRevision,
  started:c.started,retainedPending:c.retainedAdoptionPending,adoption:c.retainedAdoptionDiagnostics,
  sessionPhase:c.session?.phase,retained:c.session?.retained,activeHealth:c.activeHealth?.current(),
  health:c.health,externalObservation:c.externalObservation,activeHealthState:c.activeHealth?.state,
  programCurrentTime:h.output.renderer.program.renderer?.video?.currentTime,lastHealthyAt:c.activePlayback?.lastProgressAt,
  activationPending:c.executionReconciliationPending,executionReady:h.output.executionReady,uiLabel:ui.status.textContent,
  programSceneId:h.state.getProgramSceneId(),rendererSourceId:h.output.renderer.program.renderer?.sourceId,
  publisherSourceId:h.output.snapshot?.source?.id,calls:h.calls}));
 assert.equal(h.state.getProgramSceneId(),program);assert.equal(h.state.getPreviewSceneId(),preview);
 assert.deepEqual(h.calls,{release:0,execute:0,commitPrepared:0,beginInterruption:0});
 if(variant!=='grant-before-renderer')assert.equal(h.published.length,publications);
 assert.equal(h.published.some(s=>s.source?.id==='autolive-entry-slate'),false);assert.equal(c.session?.retained,true);
 if(variant==='monitor-offline-program-progress'){
  assert.equal(c.externalObservation.state,'OFFLINE');assert.equal(c.externalObservation.reason,'HLS_OFFLINE');
  assert.equal(c.activeHealth.current(),true);assert.equal(c.activeHealth.state,'ONLINE');
  assert.ok(h.output.renderer.program.renderer.video.currentTime>100);
  assert.ok(Date.now()-c.activePlayback.lastProgressAt<1000);
  assert.equal(c.lossTimer,null);assert.equal(c.activeHealth.canClose(),false);
  assert.equal(c.health.authority,'active-program','Observed Program progress must publish the initial active-owner health projection');
  assert.equal(c.health.state,'ONLINE');
 }
 assert.equal(c.executionReconciliationPending,false,'Retained LIVE activation must complete after current external authority is known');
 assert.equal(h.output.executionReady,true);
 if(variant==='monitor-offline-program-progress')assert.equal(ui.status.textContent,'LIVE');
});

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

test('A1 fresh owner bootstrap adopts retained LIVE with no gate or startup publication',async t=>{
 const h=await bootstrap(t,{fenced:true});await h.recover();retained(h);assert.ok(h.execution.valid());
});
test('A1 second fresh Control cannot start AutoLive or publish ENTRY',async t=>{
 const h=await bootstrap(t,{fenced:true,secondTab:true});await h.advance(6000);
 assert.equal(h.controller.started,undefined);assert.equal(h.controller.session,null);assert.equal(h.published.length,0);
 assert.equal(h.state.getProgramSceneId(),'LIVE');assert.equal(h.state.getPreviewSceneId(),'P');assert.equal(h.calls.beginInterruption,0);
});
test('A1 loss of browser ownership suspends active health without return or Program release',async t=>{
 const h=await bootstrap(t,{fenced:true});await h.recover();retained(h);
 h.execution.lose('OWNER_REJECTED');await h.advance(31000);
 assert.equal(h.controller.session,null);assert.equal(h.state.getProgramSceneId(),'LIVE');assert.equal(h.state.getPreviewSceneId(),'P');
 assert.deepEqual(h.closures,[]);assert.equal(h.calls.release,0);assert.equal(h.phases.includes('PREPARING'),false);
});
test('A1 delayed loss callback cannot return Program after local lease expiry',async t=>{
 const h=await bootstrap(t,{fenced:true});await h.recover();retained(h);
 h.execution.deadline=0;h.controller.endSession('source-loss');await flush();
 assert.equal(h.state.getProgramSceneId(),'LIVE');assert.equal(h.state.getPreviewSceneId(),'P');assert.equal(h.calls.release,0);
 assert.equal(h.controller.session,null);assert.equal(h.controller.started,false);
});

for(const initialOnline of [false,true])test('Runtime A fresh granted owner receives '+(initialOnline?'current ONLINE replay':'later ONLINE')+' and enters 30-second gate',async t=>{
 const h=await bootstrap(t,{fenced:true,entry:true,initialOnline});
 assert.equal(h.execution.state.state,'BROWSER_OWNER');assert.equal(Boolean(h.execution.valid()),true);
 if(!initialOnline){await h.recover();await h.advance(4000);}
 assert.equal(h.monitor.getSnapshot().state,'ONLINE');assert.equal(h.controller.health.state,'ONLINE');
 assert.equal(h.controller.health.sourceId,'primecast');assert.equal(h.controller.session?.phase,'PREPARING');
 assert.equal(h.calls.beginInterruption,1);assert.equal(h.state.getPreviewSceneId(),'P');
 await h.advance(Math.max(0,28000-h.controller.entryElapsedMs));assert.equal(h.controller.session?.phase,'PREPARING');assert.equal(h.calls.commitPrepared,0);
 assert.ok(h.controller.entryElapsedMs>=27000);await h.advance(Math.max(0,30000-h.controller.entryElapsedMs)+1000);
 assert.equal(h.controller.session?.phase,'LIVE');assert.equal(h.calls.commitPrepared,1);
 t.diagnostic(JSON.stringify({ownership:h.execution.state.state,health:h.controller.health,onlineEvaluations:h.decisions.filter(d=>d.healthOnline)}));
});

test('Runtime A epoch 13 restart: Technical ONLINE but no executor/health subscription/ENTRY',async t=>{
 const h=await bootstrap(t,{fenced:true,entry:true,restarted:true,initialOnline:true});
 assert.equal(h.execution.state.state,'NO_OWNER');assert.equal(h.execution.state.reason,'RESTART_RECONCILIATION_REQUIRED');
 assert.equal(h.execution.state.authorityEpoch,14);assert.equal(Boolean(h.execution.valid()),false);
 assert.equal(h.technical.getSnapshot().state,'ONLINE');assert.equal(Boolean(h.controller.started),false);
 assert.equal(h.monitor.getSnapshot().state,'IDLE');assert.equal(h.controller.health.state,'IDLE');
 assert.equal(h.controller.session,null);assert.equal(h.controller.getSnapshot().status,'ARMED — WAITING');
 await h.advance(35000);assert.equal(h.calls.beginInterruption,0);assert.equal(h.calls.commitPrepared,0);
 assert.equal(h.state.getProgramSceneId(),'A');assert.equal(h.state.getPreviewSceneId(),'P');
 assert.equal(h.decisions.length,0);
 t.diagnostic(JSON.stringify({ownership:h.execution.state,leaseValid:Boolean(h.execution.valid()),controllerStarted:Boolean(h.controller.started),health:h.monitor.getSnapshot(),technical:h.technical.getSnapshot().state,evaluations:h.decisions.length,beginInterruption:h.calls.beginInterruption}));
});

for(const entry of [false,true])test('DP1 durable restart reconciliation '+(entry?'replays ONLINE into full entry gate':'adopts retained LIVE without TAKE'),async t=>{
 const h=await bootstrap(t,{fenced:true,restarted:true,reconcile:true,initialOnline:true,entry,durable:true});
 await h.advance(1000); // The operator reviews a playing Program before confirming.
 const before=h.state.getProgramSceneId(),preview=h.state.getPreviewSceneId(),publications=h.published.length;
 const p=await h.execution.reconcileRequest('prepare-reconciliation');assert.equal(Boolean(h.execution.valid()),false);
 const r=await h.execution.reconcileRequest('reconcile',p);assert.ok(r.grant);await flush();
 if(!entry)await h.advance(250); // First actual Program progress sample after active-owner subscription.
 assert.equal(h.state.getPreviewSceneId(),preview);assert.equal(h.calls.release,0);
 if(!entry){assert.equal(h.state.getProgramSceneId(),before);assert.equal(h.published.length,publications,JSON.stringify(h.published));
  assert.equal(h.controller.session?.retained,true);assert.equal(h.controller.session?.phase,'LIVE');assert.equal(h.calls.beginInterruption,0);assert.equal(h.calls.commitPrepared,0);
  assert.equal(h.controller.executionReconciliationPending,false,JSON.stringify({health:h.controller.health,externalObservation:h.controller.externalObservation,activeHealth:h.controller.activeHealth?.current(),retainedPending:h.controller.retainedAdoptionPending,executionReady:h.output.executionReady}));
  assert.equal(h.output.executionReady,true);
 }else{assert.equal(h.controller.session?.phase,'PREPARING',JSON.stringify({owner:h.execution.state,started:h.controller.started,health:h.controller.health,renderer:h.output.renderer.getProgramTransport(),cue:h.output.renderer.program.renderer?.initialCueState,readiness:h.output.renderer.program.renderer?.readinessState}));assert.equal(h.calls.beginInterruption,1);
  await h.advance(28000);assert.equal(h.calls.commitPrepared,0);await h.advance(3000);assert.equal(h.controller.session?.phase,'LIVE');assert.equal(h.calls.commitPrepared,1);}
});
