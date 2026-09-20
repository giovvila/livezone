import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {createProgramOutputServer} from '../server/program-output-server.js';
import {createInitializedState} from '../server/studio/AuthoritativeStateContract.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
import OwnershipClient,{startBrowserExecutionOwnership} from '../public/js/studio/BrowserExecutionOwnershipClient.js';
import AutoLiveAuthorityClient from '../public/js/studio/AutoLiveAuthorityClient.js';
import AutoLiveLegacyBridge from '../public/js/studio/AutoLiveLegacyBridge.js';
import DominantLiveConfig from '../public/js/studio/DominantLiveConfig.js';
import AutoLiveEntryController from '../public/js/studio/AutoLiveEntryController.js';
import SchedulerRuntimeState from '../public/js/scheduler/SchedulerRuntimeState.js';
import SchedulerEngine from '../public/js/scheduler/SchedulerEngine.js';
import StudioScheduleSummaryUI from '../public/js/ui/StudioScheduleSummaryUI.js';
import DominantLiveUI from '../public/js/ui/DominantLiveUI.js';

// Diagnostic-only reproducer. Real HTTP authority and production configuration,
// ownership, bridge, scheduler, controller and UI modules in Control startup order.
// Media/catalog observations are inert: this test must never TAKE or publish Program.
async function fixture(t,mode='owner') {
 const dir=await mkdtemp(join(tmpdir(),'lz-config-bootstrap-'));
 const source={id:'primecast',name:'primecast',kind:'hls',enabled:true,url:'https://example.test/live.m3u8'};
 const state=createInitializedState({sources:[source],scenes:[],scheduler:{version:1,timezone:'Europe/Rome',items:[],enabled:false},
  globalOverlays:{textCrawl:null},dominantLive:{armed:false,authorizedSourceId:null}},{stateId:'test',updatedAt:new Date().toISOString()});
 await writeFile(join(dir,'studio.json'),JSON.stringify(state));
 // Existing, migrated server configuration, initially OFF; no migration ambiguity.
 await writeFile(join(dir,'studio.json.autolive.json'),JSON.stringify({version:1,revision:1,enabled:mode==='restart-enabled',armed:mode==='restart-enabled',sourceId:'primecast',
  updatedAt:new Date().toISOString(),migration:{version:1,completedAt:new Date().toISOString()}}));
 if(mode.startsWith('restart'))await writeFile(join(dir,'studio.json.autolive.json.execution'),JSON.stringify({epoch:1}));
 if(mode==='duplicate')await writeFile(join(dir,'studio.json.autolive.json.execution.lock'),'diagnostic competing authority');
 const auth=new OperatorAuth({username:'operator',password:'config-bootstrap-test-only',secureCookie:false});
 const session=auth.authenticate('operator','config-bootstrap-test-only');
 const owner=createProgramOutputServer({publisherToken:'config-bootstrap-publisher',operatorAuth:auth,studioStatePath:join(dir,'studio.json'),
  schedulePath:join(dir,'schedule.json'),mediaLibraryRoot:join(dir,'media')});
 await Promise.all([owner.autoLive.ready,owner.executionOwnership.ready]);
 await new Promise(r=>owner.server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+owner.server.address().port,calls=[];
 const request=async(path,options={})=>{
  const response=await fetch(origin+path,{...options,headers:{Cookie:auth.createCookie(session).split(';')[0],Origin:origin,
   'X-Livezone-Operator-Request':'1','X-Livezone-CSRF':session.csrfToken,...options.headers}});
  const body=await response.clone().json();calls.push({path,method:options.method||'GET',status:response.status,
   ifMatch:options.headers?.['If-Match'],revision:body.config?.revision,code:body.error?.code,
   ownership:body.state?.state,reason:body.state?.reason});return response;
 };
 const dom=new JSDOM(await readFile(new URL('../public/control/index.html',import.meta.url),'utf8'),{url:origin+'/control/'});
 const previousDocument=globalThis.document;globalThis.document=dom.window.document;
 const config=new DominantLiveConfig({storage:dom.window.localStorage,eventTarget:dom.window});
 const runtimeState=new SchedulerRuntimeState({storage:dom.window.localStorage});
 const catalog={getSources:()=>[source],getDefinition:()=>null,subscribe:fn=>{fn();return()=>{};}};
 let execution,bridge,engine,controller,ui,scheduleUI;
 t.after(async()=>{
  ui?.destroy();scheduleUI?.destroy();controller?.destroy();bridge?.destroy();engine?.destroy();config.destroy();
  // Avoid a racing fire-and-forget release during fixture HTTP shutdown.
  if(execution){execution.grant=null;execution.close();}
  owner.server.closeAllConnections();await new Promise(r=>owner.server.close(r));
  globalThis.document=previousDocument;dom.window.close();await rm(dir,{recursive:true,force:true});
 });
 return {owner,calls,request,config,runtimeState,dom,get execution(){return execution;},
  async bootstrap(options={}){
   execution=await startBrowserExecutionOwnership({request,...options});
   bridge=new AutoLiveLegacyBridge({client:new AutoLiveAuthorityClient({request}),config,runtimeState,lifecycle:dom.window});
   bridge.executionOwnership=execution;await bridge.start();
   const command={stateManager:{getProgramSceneId:()=>null,addProgramGuard:()=>()=>{}},
    execute:()=>assert.fail('configuration must not execute Program')};
   engine=new SchedulerEngine({command,catalog,runtimeState,programExecution:false});bridge.attachEngine(engine);
   scheduleUI=new StudioScheduleSummaryUI({root:dom.window.document,engine,catalog,
    store:{serverAuthoritative:true,subscribe:()=>()=>{}},clockTicker:{subscribe:()=>()=>{}}});
   scheduleUI.autoLiveBridge=bridge;scheduleUI.start();engine.restoreEnabledState();
   controller=new AutoLiveEntryController({config,catalog,scheduler:engine,command,renderer:{},monitor:{
    subscribe:()=>()=>{},selectSource(){},stop(){},destroy(){}}});
   controller.executionOwnership=execution;execution.subscribe(value=>{if(value.valid())controller.start();});
   ui=new DominantLiveUI({root:dom.window.document.getElementById('dominant-live-control'),config,controller});ui.start();
  },
  async enable(){await scheduleUI.handleToggle();ui.toggle.checked=true;await ui.handleChange();},
  get engine(){return engine;},get ui(){return ui;}
 };
}

for(const mode of ['owner','restart','duplicate'])test('diagnostic OFF -> enabled/armed configuration with '+mode,async t=>{
 const h=await fixture(t,mode);await h.bootstrap();await h.enable();
 assert.equal(Boolean(h.execution.valid()),mode==='owner');
 assert.equal(h.config.getSnapshot().armed,true);assert.equal(h.config.getSnapshot().authorizedSourceId,'primecast');
 assert.equal(h.engine.getSnapshot().enabled,true);assert.equal(h.engine.programExecution,false);
 assert.equal(h.owner.store.getCurrent(),null);
 const patches=h.calls.filter(c=>c.method==='PATCH');assert.deepEqual(patches.map(c=>[c.status,c.ifMatch,c.revision]),
  [[200,'"autolive-1"',2],[200,'"autolive-2"',3]]);
 assert.equal(h.ui.source.textContent,'primecast');assert.equal(h.ui.toggle.checked,true);
 assert.equal(h.ui.status.textContent,mode==='restart'?'RIPRISTINO RICHIESTO':'IN ATTESA');
 t.diagnostic(JSON.stringify(h.calls));
});

test('diagnostic restarted authority with persisted true true primecast installs controls despite NO_OWNER',async t=>{
 const h=await fixture(t,'restart-enabled');await h.bootstrap();
 assert.equal(h.execution.state.state,'NO_OWNER');assert.equal(h.execution.state.reason,'RESTART_RECONCILIATION_REQUIRED');
 assert.equal(h.ui.started,true);assert.equal(h.ui.toggle.checked,true);assert.equal(h.ui.source.textContent,'primecast');
 assert.equal(h.engine.getSnapshot().enabled,true);assert.equal(h.engine.programExecution,false);
 assert.equal(h.owner.store.getCurrent(),null);
 t.diagnostic(JSON.stringify(h.calls));
});


for(const mode of ['owner','duplicate'])test('browser timer receiver contract keeps controls usable: '+mode,async t=>{
 const h=await fixture(t,mode),clear=globalThis.clearTimeout,set=globalThis.setTimeout;
 t.mock.method(globalThis,'clearTimeout',function(id){if(this instanceof OwnershipClient)throw new TypeError('Illegal invocation');return clear(id);});
 t.mock.method(globalThis,'setTimeout',function(fn,ms,...args){if(this instanceof OwnershipClient)throw new TypeError('Illegal invocation');return set(fn,ms,...args);});
 try{await h.bootstrap();await h.enable();assert.equal(Boolean(h.execution.valid()),mode==='owner');assert.equal(h.engine.getSnapshot().enabled,true);assert.equal(h.owner.store.getCurrent(),null);}
 finally{t.mock.restoreAll();}
});
for(const available of [true,false])test('missing randomUUID; secure random bytes '+available+'; config remains usable',async t=>{
 const h=await fixture(t),descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:available?{getRandomValues:globalThis.crypto.getRandomValues.bind(globalThis.crypto)}:{}});
 t.after(()=>Object.defineProperty(globalThis,'crypto',descriptor));
 await h.bootstrap();await h.enable();
 assert.equal(Boolean(h.execution.valid()),available);assert.equal(h.config.getSnapshot().armed,true);assert.equal(h.engine.getSnapshot().enabled,true);
 if(!available){assert.equal(h.execution.state.reason,'SECURE_IDENTITY_UNAVAILABLE');assert.equal(h.calls.some(c=>c.path.includes('execution-ownership')),false);}
 assert.equal(h.owner.store.getCurrent(),null);
});
test('ownership client construction failure is isolated from authenticated configuration',async t=>{
 const h=await fixture(t);await h.bootstrap({uuid:()=>{throw new TypeError('identity failure');}});await h.enable();
 assert.equal(h.execution.state.reason,'OWNERSHIP_STARTUP_FAILED');assert.equal(Boolean(h.execution.valid()),false);
 assert.equal(h.config.getSnapshot().armed,true);assert.equal(h.engine.getSnapshot().enabled,true);assert.equal(h.owner.store.getCurrent(),null);
});
test('passive UI follows accepted configuration notifications without a checkbox click',async t=>{
 const h=await fixture(t,'duplicate');await h.bootstrap();
 await h.request('/api/studio/autolive',{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':'"autolive-1"'},body:JSON.stringify({armed:true,enabled:true})});
 // Use the same accepted projection as a private SSE/refresh notification.
 h.runtimeState.serverEnabled=true;h.engine.start({persist:false});h.config.update({armed:true,authorizedSourceId:'primecast'},{persist:false});
 assert.equal(h.ui.toggle.checked,true);assert.equal(h.ui.source.textContent,'primecast');assert.equal(h.ui.status.textContent,'IN ATTESA');
 assert.equal(Boolean(h.execution.valid()),false);assert.equal(h.owner.store.getCurrent(),null);
});


test('restart UI explicitly prepares, fails closed without Program, and cancels without execution',async t=>{
 const h=await fixture(t,'restart-enabled');await h.bootstrap();
 assert.equal(h.ui.status.textContent,'RIPRISTINO RICHIESTO');assert.equal(h.ui.reconcileButton.hidden,false);
 await h.ui.prepareReconciliation();assert.equal(h.ui.status.textContent,'PROGRAM NON VERIFICABILE');
 assert.equal(h.ui.reconcileConfirm.disabled,true);assert.equal(h.owner.executionOwnership.restartBlocked,true);
 assert.equal(h.owner.store.getCurrent(),null);assert.equal(h.execution.valid(),null);
 h.ui.cancelHandler();assert.equal(h.ui.reconcilePanel.hidden,true);
});

test('reconciliation HTTP requires operator CSRF/origin and rejects publisher token alone',async t=>{
 const h=await fixture(t,'restart-enabled');const body=JSON.stringify({operation:'prepare-reconciliation',ownerInstanceId:'tab',publisherSessionId:'pub'});
 for(const headers of [{'X-Livezone-CSRF':'bad'},{Origin:'https://untrusted.example'},{Cookie:'',Authorization:'Bearer config-bootstrap-publisher'},{'X-Livezone-Operator-Request':''}]){
  const r=await h.request('/api/studio/execution-ownership',{method:'POST',headers:{'Content-Type':'application/json',...headers},body});
  assert.ok([401,403].includes(r.status));
 }
 assert.equal(h.owner.executionOwnership.grant,null);
});

test('reconciliation HTTP confirms explicit empty Program without publishing',async t=>{
 const h=await fixture(t,'restart-enabled');await h.bootstrap();
 const at=new Date().toISOString();const snapshot={version:1,publisherSessionId:'before',revision:1,publishedAt:at,committedAt:at,scene:null,source:null,
  playback:{initialTime:0,duration:null,playing:false,ended:false,state:'ready',startedAt:at},graphics:{items:[]},transition:{type:'cut',durationMs:0}};
 assert.equal((await h.owner.programCommits.accept({protocolVersion:1,publisherSessionId:'before',revision:1,publishedAt:at,snapshot},{check:()=>true})).accepted,true);
 const before=h.owner.store.getCurrent();await h.ui.prepareReconciliation();assert.equal(h.ui.reconcileConfirm.disabled,false);
 assert.equal(h.owner.executionOwnership.grant,null);await h.ui.confirmReconciliation();
 assert.equal(Boolean(h.execution.valid()),true);assert.equal(h.owner.store.getCurrent(),before);
 assert.equal(h.ui.reconcilePanel.hidden,true);assert.equal(h.calls.some(c=>c.path==='/api/program-output'),false);
});

test('queued HTTP manual Program intent wins over a prepared reconciliation',async t=>{
 const h=await fixture(t,'restart-enabled');await h.bootstrap();
 const at=new Date().toISOString();const snapshot={version:1,publisherSessionId:'before',revision:1,publishedAt:at,committedAt:at,scene:null,source:null,
  playback:{initialTime:0,duration:null,playing:false,ended:false,state:'ready',startedAt:at},graphics:{items:[]},transition:{type:'cut',durationMs:0}};
 const envelope={protocolVersion:1,publisherSessionId:'before',revision:1,publishedAt:at,snapshot};await h.owner.programCommits.accept(envelope,{check:()=>true});
 const prepared=await h.execution.reconcileRequest('prepare-reconciliation');let release,entered;
 const blocked=new Promise(r=>entered=r);const hold=h.owner.assetMutations.run(()=>new Promise(r=>release=r));await new Promise(setImmediate);
 const original=h.owner.assetMutations.run.bind(h.owner.assetMutations);h.owner.assetMutations.run=fn=>{entered();return original(fn);};
 const manual=h.request('/api/program-output',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer config-bootstrap-publisher','X-Livezone-Program-Manual':'1'},body:JSON.stringify({...envelope,revision:2,snapshot:{...snapshot,revision:2}})});
 await blocked;const confirmation=h.execution.reconcileRequest('reconcile',prepared);release();await hold;
 assert.equal((await manual).status,202);assert.ok((await confirmation).error);assert.equal(h.owner.executionOwnership.grant,null);
});
