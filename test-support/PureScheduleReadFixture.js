import assert from 'node:assert/strict';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {readOnlyFilesystemObserver} from '../test-support/ReadOnlyFilesystemObserver.js';
const observer=readOnlyFilesystemObserver();
const {eraFixture}=await import('../test-support/NewExecutionEraFixture.js');
const {NewEraRecoveryWorkflow}=await import('../server/recovery/NewEraRecoveryWorkflow.js');
const {componentLaunch}=await import('../test-support/NewEraControlledRuntime.js');
const {controlledStart}=await import('../server/recovery/ControlledStart.js');
const {default:ScheduleRoutes}=await import('../server/scheduler/ScheduleRoutes.js');
const {default:Automation}=await import('../server/scheduler/LiveAutomationCoordinator.js');
const {default:Entry}=await import('../server/scheduler/ScheduledEntryRuntime.js');
const {identityForScheduledEvent}=await import('../server/scheduler/ScheduledEventIdentity.js');
const {hash}=await import('../server/scheduler/ScheduledEntryLedgerV2Protocol.js');
export async function pureScheduleFixture(t){
 const cleanup=[];let runtime,automation,entry,routes;
 t.after(async()=>{observer.disable();routes?.close();automation?.close();entry?.close();await runtime?.close();for(const fn of cleanup.reverse())await fn();});
 const f=await eraFixture({after:fn=>cleanup.push(fn)});await f.writer.transition(f.authorization);
 let now=Date.parse('2030-01-01T11:50:00Z');
 const start=now+60000,end=start+120000;
 f.workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
 runtime=componentLaunch(f,{clock:()=>now});
 await controlledStart({workflow:f.workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
 const owner=runtime.owners[0],source=owner.catalog.sources.find(s=>s.kind==='hls');assert.ok(source);
 const event={version:1,id:'r8-new-future-live',type:'source.live',enabled:true,startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString(),priority:0,
  payload:{sourceId:source.id,precheckSeconds:0,unavailableAction:'KEEP_PROGRAM',unavailableSceneId:null,endAction:'RETURN',endSceneId:null},
  createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
 const inserted=await owner.scheduler.store.insert(event,owner.scheduler.store.getSnapshot().revision);assert.equal(inserted.ok,true,inserted.code);
 automation=new Automation({scheduler:owner.scheduler,catalog:()=>owner.catalog,clock:()=>now,
  healthRegistry:{acquire(descriptor){return {release(){},getSnapshot:()=>({sourceId:descriptor.sourceId,sourceFingerprint:descriptor.fingerprint,
   state:'ONLINE',freshness:'FRESH',validUntil:end+60000,playlistProgressing:true,segmentReachable:true})};}}});
 let active=null,captures=0,executions=0,consumeAttempts=0;
 const consume=owner.ledger.consume.bind(owner.ledger);owner.ledger.consume=(...args)=>{consumeAttempts++;return consume(...args);};
 const reconciliation={manualIntentRevision:0,manualPending:false};
 const scheduledOwnership={transaction:()=>active,capture({eventId,sourceId}){assert.equal(owner.ledger.records.at(-1).type,'COMMIT');assert.equal(owner.ledger.snapshot.entries.filter(e=>e.identity.eventId===eventId).length,1);captures++;active={eventId,sourceId,capturedAt:now,manualIntentRevision:0};return {accepted:true};},release(){active=null;}};
 entry=new Entry({scheduler:owner.scheduler,automation,ownership:owner.executionOwnership,reconciliation,scheduledOwnership,
  mutations:{run:fn=>Promise.resolve().then(fn)},clock:()=>now,ready:Promise.resolve(owner.ledger)});
 automation.subscribeEvaluation(snapshot=>{
  entry.observe();
  if(['TAKE_REQUESTED','LIVE_ACTIVE_REQUESTED','FALLBACK_REQUESTED'].includes(snapshot.state)&&snapshot.eventId&&snapshot.sourceId)
   entry.request(snapshot,async()=>{executions++;});
 });
 await automation.start();await entry.idle();assert.equal(captures,0);
 routes=new ScheduleRoutes({owner:owner.scheduler});
 now=start+1000; // No fake timer fired and no health notification delivered.
 const identity=identityForScheduledEvent(owner.scheduler.store.getEvent(event.id));
 assert.equal((await owner.ledger.inspect(identity)).status,'UNCONSUMED');
 return {f,owner,event,entry,automation,routes,identity,observer,start,end,
  get now(){return now;},set now(value){now=value;},
  get counts(){return {captures,executions,consumeAttempts};},
  async request(method='GET',suffix=''){
   let status,body,headers;const chunks=[];
   const req={method,headers:{},on(){}};
   const res={on(){},writeHead(code,value){status=code;headers=value;},end(value){if(value)body=JSON.parse(value);},write(value){chunks.push(value);return true;}};
   await routes.handle(req,res,new URL('http://fixture.invalid/api/studio/schedule'+suffix));
   return {status,body,headers,chunks};
  },
  async bytes(){const result={};async function walk(dir){for(const name of (await readdir(dir)).sort()){const p=join(dir,name),st=await lstat(p);if(st.isDirectory())await walk(p);else if(st.isFile())result[relative(f.root,p)]=hash(await readFile(p));}}await walk(f.root);return result;},
  async observe(fn,{drain=true}={}){
   const before=await this.bytes(),counts={...this.counts},authorityGeneration=owner.scheduler.runtime.generation,generation=owner.scheduler.generation;
   const retained=owner.scheduler.runtime.getSnapshot();for(const key of Object.keys(observer.counts))observer.counts[key]=0;
   observer.enable();let result;try{result=await fn();if(drain)await entry.idle();}finally{observer.disable();}
   assert.deepEqual(observer.counts,Object.fromEntries(Object.keys(observer.counts).map(k=>[k,0])));
   assert.deepEqual(await this.bytes(),before);assert.deepEqual(this.counts,counts);
   assert.equal(owner.scheduler.runtime.generation,authorityGeneration);assert.equal(owner.scheduler.generation,generation);assert.equal(owner.scheduler.runtime.getSnapshot(),retained);
   return result;
  }
 };
}
export {observer};
