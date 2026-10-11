import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {executionEraStartup,eraAdmits,issueEraEntry,eraRecordBytes,unsealEra} from '../server/recovery/ExecutionEraContract.js';
import {identityForScheduledEvent,requiresLiveExecutionAuthority} from '../server/scheduler/ScheduledEventIdentity.js';
import ScheduledEntryRuntime from '../server/scheduler/ScheduledEntryRuntime.js';
import {inspectV2,hash,seal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {grantFutureRuntime} from '../test-support/EraGrantFutureRuntime.js';
import {spawn} from 'node:child_process';

async function ready(t,fn){
 const f=await eraFixture(t);await f.writer.transition(f.authorization);let now=Date.parse('2030-01-01T11:50:00Z');
 const runtime=componentLaunch(f,{clock:()=>now}),workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
 try{const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const store=owner.scheduler.store,authority=owner.executionOwnership,era=executionEraStartup(f.paths.ledger);
  const guard=new ScheduledEntryRuntime({scheduler:owner.scheduler,clock:()=>now,ready:Promise.resolve(owner.ledger)});await guard.ready;
  const c={f,runtime,workflow,owner,store,authority,era,clock:()=>now,setNow:v=>now=v,readyPath:join(era.directory,'start-'+authority.authorityProcessSession+'.json.ready')};
  c.event=id=>{const e={...store.listEvents().find(e=>e.type==='source.live'),id,startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};for(const k of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete e[k];return e;};
  await fn(c);
 }finally{await runtime.close();}
}
const image=async c=>({wal:await readFile(c.f.paths.ledger+'.wal'),snapshot:await readFile(c.f.paths.ledger)});
const restore=async(c,v)=>{await writeFile(c.f.paths.ledger+'.wal',v.wal);await writeFile(c.f.paths.ledger,v.snapshot);};
const consume=(c,i)=>c.owner.ledger.consume(i,{authorityEpoch:c.authority.authorityEpoch,authorityProcessSession:c.authority.authorityProcessSession,consumedAt:'2030-01-01T12:00:00.000Z'});
const insert=async(c,id)=>{assert.equal((await c.store.insert(c.event(id),c.store.state.revision)).ok,true);return c.store.getEvent(id);};
const grants=async c=>Object.fromEntries(await Promise.all((await readdir(c.era.directory)).filter(n=>n.startsWith('grant-')).sort().map(async n=>[n,hash(await readFile(join(c.era.directory,n)))])));
const grantNames=async era=>(await readdir(era.directory)).filter(n=>n.startsWith('grant-')).sort();
async function protectedHashes(c){
 const paths=[c.f.paths.schedule,c.f.paths.program,c.f.paths.autoLive,c.readyPath,c.f.paths.authority,c.f.paths.authorityLock,c.f.paths.bootstrap,c.f.paths.ledger,c.f.paths.ledger+'.wal',c.f.paths.ledgerLock];
 const binding=c.authority.controlledStartBinding;paths.push(binding.reservationPath,binding.claimPath,binding.runtimeOwnedPath);
 return Object.fromEntries(await Promise.all(paths.map(async p=>[p,hash(await readFile(p))])));
}
async function lose(c,event){const zero=await image(c),identity=identityForScheduledEvent(event);assert.equal((await consume(c,identity)).status,'CONSUMED');const latest=await image(c);await restore(c,zero);assert.equal((await c.owner.ledger.inspect(identity)).status,'UNAVAILABLE');await restore(c,latest);assert.equal((await inspectV2(c.f.paths.ledger)).current.generation,1);assert.equal(c.owner.ledger.status,'UNAVAILABLE');}

test('exact A6: restored valid files do not authorize a new executable revision',t=>ready(t,async c=>{
 const old=await insert(c,'era15-a6');await lose(c,old);
 const before=await protectedHashes(c),beforeGrants=await grants(c),identity=identityForScheduledEvent(old);
 const proposed={...old,startAt:'2030-01-01T12:20:00.000Z',endAt:'2030-01-01T12:30:00.000Z',entryRevision:old.entryRevision+1};
 assert.notEqual(identity.entryKey,identityForScheduledEvent(proposed).entryKey);
 const result=await c.store.update(old.id,{startAt:proposed.startAt,endAt:proposed.endAt},c.store.state.revision);
 assert.equal(result.ok,false,'EXECUTABLE_REVISION_PUBLISHED_WITH_UNAVAILABLE_LEDGER');assert.equal(result.code,'EXECUTION_ERA_LEDGER_RUNTIME_NOT_OPERATIONAL');
 assert.deepEqual(c.store.getEvent(old.id),old);assert.deepEqual(await protectedHashes(c),before);assert.deepEqual(await grants(c),beforeGrants);
 assert.equal(eraAdmits(c.era,identity),true);assert.equal(eraAdmits(c.era,identityForScheduledEvent(proposed)),false);
 assert.equal((await consume(c,identityForScheduledEvent(proposed))).status,'OLD_EXECUTION_DOMAIN_RETIRED');
 await c.owner.ledger.initialize();assert.equal(c.owner.ledger.status,'UNAVAILABLE');
}));

const fields=['startAt','endAt','sourceId','enable'];
for(const available of [true,false])for(const field of fields)test(`identity field ${field}: runtime ${available?'AVAILABLE':'UNAVAILABLE'}`,t=>ready(t,async c=>{
 const old=await insert(c,'era15-field');if(field==='enable')assert.equal((await c.store.setEnabled(old.id,false,c.store.state.revision)).ok,true);
 if(!available)await lose(c,old);
 const previous=c.store.getEvent(old.id),before=await protectedHashes(c),g=await grants(c);
 const patch=field==='startAt'?{startAt:'2030-01-01T12:01:00.000Z'}:field==='endAt'?{endAt:'2030-01-01T12:15:00.000Z'}:field==='sourceId'?{payload:{...old.payload,sourceId:'era15-other-source'}}:{enabled:true};
 const result=await c.store.update(old.id,patch,c.store.state.revision);
 assert.equal(result.ok,available,result.code);assert.deepEqual(await grants(c),g);
 if(!available){assert.deepEqual(await protectedHashes(c),before);assert.deepEqual(c.store.getEvent(old.id),previous);}
 else{const next=c.store.getEvent(old.id);assert.equal(next.incarnationId,previous.incarnationId);assert.equal(next.entryRevision,previous.entryRevision+(field==='enable'?0:1));assert.equal(eraAdmits(c.era,identityForScheduledEvent(next)),true);if(field!=='enable')assert.equal(eraAdmits(c.era,identityForScheduledEvent(previous)),false);}
}));

test('canonical predicate covers all identity fields and ignores non-key fields',t=>ready(t,async c=>{
 const old=await insert(c,'era15-predicate');
 for(const patch of [{id:'another-id'},{incarnationId:randomUUID()},{entryRevision:2},{executionEraId:randomUUID()},{entryGrantHash:'0'.repeat(64)},{startAt:'2030-01-01T12:01:00.000Z'},{endAt:'2030-01-01T12:11:00.000Z'},{payload:{...old.payload,sourceId:'another-source'}}])assert.equal(requiresLiveExecutionAuthority(old,{...old,...patch}),true);
 for(const patch of [{name:'editorial'},{priority:old.priority+1},{enabled:false},{updatedAt:'2030-01-01T11:51:00.000Z'},{payload:{...old.payload,precheckSeconds:0,endAction:'HOLD'}}])assert.equal(requiresLiveExecutionAuthority(old,{...old,...patch}),false);
 assert.equal(requiresLiveExecutionAuthority(old,null),false);assert.equal(requiresLiveExecutionAuthority(old,{type:'overlay.crawl'}),false);
}));

test('non-key edits and safety-only retirement remain available with a fenced writer',t=>ready(t,async c=>{
 const old=await insert(c,'era15-editorial');await lose(c,old);const originalKey=identityForScheduledEvent(old).entryKey;
 for(const patch of [{name:'editorial'}, {priority:old.priority+1}, {payload:{...old.payload,precheckSeconds:0,endAction:'HOLD'}}, {enabled:false}]){
  assert.equal((await c.store.update(old.id,patch,c.store.state.revision)).ok,true);assert.equal(identityForScheduledEvent(c.store.getEvent(old.id)).entryKey,originalKey);assert.equal(c.owner.ledger.status,'UNAVAILABLE');
 }
 assert.equal((await c.store.update(old.id,{type:'overlay.crawl',payload:{text:'safe',position:'bottom',direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true}},c.store.state.revision)).ok,true);
 assert.equal(eraAdmits(c.era,identityForScheduledEvent(old)),false);assert.equal((await c.store.delete(old.id,c.store.state.revision)).ok,true);
 const historical=c.store.listEvents().find(e=>e.type==='source.live');assert.equal((await c.store.update(historical.id,{name:'historical label'},c.store.state.revision)).ok,true);assert.equal((await c.store.delete(historical.id,c.store.state.revision)).ok,true);
}));

for(const available of [true,false])test(`creation and conversion runtime ${available?'AVAILABLE':'UNAVAILABLE'}`,t=>ready(t,async c=>{
 const seed=await insert(c,'era15-seed'),e=c.event('era15-created'),overlay={...c.event('era15-conversion'),type:'overlay.crawl',payload:{text:'safe',position:'bottom',direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true}};
 assert.equal((await c.store.insert(overlay,c.store.state.revision)).ok,true);if(!available)await lose(c,seed);
 const before=await protectedHashes(c),g=await grants(c);
 assert.equal((await c.store.insert(e,c.store.state.revision)).ok,available);assert.equal((await c.store.update(overlay.id,{type:'source.live',payload:e.payload},c.store.state.revision)).ok,available);
 if(!available){assert.deepEqual(await protectedHashes(c),before);assert.deepEqual(await grants(c),g);}else{assert.equal(eraAdmits(c.era,identityForScheduledEvent(c.store.getEvent(overlay.id))),true);assert.equal(Object.keys(await grants(c)).length,3);}
}));

test('caller cannot mint or preserve executable identity through metadata',t=>ready(t,async c=>{
 const old=await insert(c,'era15-owned');const before=await protectedHashes(c),g=await grants(c);
 for(const key of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash','entryKey','identitySchema']){
  assert.equal((await c.store.update(old.id,{[key]:old[key]??'foreign'},c.store.state.revision)).code,'SERVER_OWNED_IDENTITY');
  assert.equal((await c.store.insert({...c.event('era15-forged'),[key]:old[key]??'foreign'},c.store.state.revision)).code,'SERVER_OWNED_IDENTITY');
 }
 assert.deepEqual(await protectedHashes(c),before);assert.deepEqual(await grants(c),g);
}));

for(const available of [true,false])test('historical interval edit requires current authority: '+available,t=>ready(t,async c=>{
 const old=await insert(c,'era15-historical-interval');if(!available)await lose(c,old);const before=await protectedHashes(c);
 const result=await c.store.update(old.id,{startAt:'2029-01-01T12:00:00.000Z',endAt:'2029-01-01T12:10:00.000Z'},c.store.state.revision);
 assert.equal(result.ok,available);if(!available)assert.deepEqual(await protectedHashes(c),before);else assert.equal(c.store.getEvent(old.id).entryRevision,2);
}));

for(const mode of ['invalid-WAL','foreign-READY','foreign-era','changed-grant','unbound-historical'])test('existing identity authority rejects '+mode,t=>ready(t,async c=>{
 const old=await insert(c,'era15-binding'),wal=await readFile(c.f.paths.ledger+'.wal'),readyBytes=await readFile(c.readyPath),path=join(c.era.directory,'grant-'+old.incarnationId+'.json'),grant=await readFile(path);
 try{
  let id=old.id;
  if(mode==='invalid-WAL'){const last=JSON.parse(wal.toString().trimEnd().split('\n').at(-1));await writeFile(c.f.paths.ledger+'.wal',Buffer.concat([wal,Buffer.from(JSON.stringify(seal({schemaVersion:2,type:'ERA15_UNSUPPORTED',previous:last.checksum,data:{}}))+'\n')]));}
  if(mode==='foreign-READY')await writeFile(c.readyPath,eraRecordBytes(seal({...unsealEra(JSON.parse(readyBytes)),ledgerId:randomUUID()})));
  if(mode==='foreign-era')c.authority.executionEraId=randomUUID();
  if(mode==='changed-grant')await writeFile(path,Buffer.concat([grant,Buffer.from(' ')]));
  if(mode==='unbound-historical')id=c.store.listEvents().find(e=>e.type==='source.live'&&!e.executionEraId).id;
  const before=await protectedHashes(c);const result=await c.store.update(id,{startAt:'2030-01-01T12:20:00.000Z',endAt:'2030-01-01T12:30:00.000Z'},c.store.state.revision);
  assert.equal(result.ok,false);assert.deepEqual(await protectedHashes(c),before);
 }finally{await writeFile(c.f.paths.ledger+'.wal',wal);await writeFile(c.readyPath,readyBytes);await writeFile(path,grant);c.authority.executionEraId=c.era.executionEraId;}
}));

for(const point of ['before-open','opened','partial-written','file-flushed','namespace-flushed','before-install'])test('identity edit loses runtime authority at '+point,t=>ready(t,async c=>{
 const old=await insert(c,'era15-race'),zero=await image(c);assert.equal((await consume(c,identityForScheduledEvent(old))).status,'CONSUMED');const latest=await image(c),before=await protectedHashes(c);
 c.store.eraGrantHook=async p=>{if(p==='grant-schedule/'+point){await restore(c,zero);assert.equal((await c.owner.ledger.inspect(identityForScheduledEvent(old))).status,'UNAVAILABLE');await restore(c,latest);}};
 const result=await c.store.update(old.id,{startAt:'2030-01-01T12:20:00.000Z',endAt:'2030-01-01T12:30:00.000Z'},c.store.state.revision);c.store.eraGrantHook=undefined;
 assert.equal(result.ok,false);assert.deepEqual(await protectedHashes(c),before);assert.deepEqual(c.store.getEvent(old.id),old);assert.equal((await readdir(c.f.root)).some(n=>n.startsWith('.schedule-')),false);
}));

for(const terminal of ['TERMINAL','CLOSED'])test('lifecycle '+terminal+' fences identity edits but permits safety retirement',t=>ready(t,async c=>{
 const old=await insert(c,'era15-terminal');if(terminal==='TERMINAL')await c.owner.ledger.finalize();else await c.owner.ledger.close();
 const before=await protectedHashes(c).catch(async()=>({schedule:hash(await readFile(c.f.paths.schedule))}));
 assert.equal((await c.store.update(old.id,{startAt:'2030-01-01T12:01:00.000Z'},c.store.state.revision)).ok,false);
 assert.equal(hash(await readFile(c.f.paths.schedule)),before[c.f.paths.schedule]??before.schedule);
 assert.equal((await c.store.setEnabled(old.id,false,c.store.state.revision)).ok,true);assert.equal((await c.store.delete(old.id,c.store.state.revision)).ok,true);
}));

test('shutdown starts before replace and synchronously fences a derived revision',t=>ready(t,async c=>{
 const old=await insert(c,'era15-shutdown'),before=await readFile(c.f.paths.schedule);let shutdown;
 c.store.eraGrantHook=point=>{if(point==='grant-schedule/before-install'){shutdown=c.owner.ledger.finalize();assert.equal(c.owner.ledger.closed,true);}};
 const result=await c.store.update(old.id,{startAt:'2030-01-01T12:01:00.000Z'},c.store.state.revision);c.store.eraGrantHook=undefined;
 assert.equal(result.ok,false);assert.deepEqual(await readFile(c.f.paths.schedule),before);assert.deepEqual(c.store.getEvent(old.id),old);await shutdown;assert.equal(c.owner.ledger.status,'TERMINAL');
}));

test('healthy revised identity consumes before one capture, END, approved restart and no replay',t=>ready(t,async c=>{
 const old=await insert(c,'era15-execution'),g=await grants(c);
 assert.equal((await c.store.update(old.id,{startAt:'2030-01-01T12:01:00.000Z'},c.store.state.revision)).ok,true);const revised=c.store.getEvent(old.id);
 assert.equal(eraAdmits(c.era,identityForScheduledEvent(old)),false);assert.equal((await consume(c,identityForScheduledEvent(old))).status,'OLD_EXECUTION_DOMAIN_RETIRED');
 assert.equal(eraAdmits(c.era,identityForScheduledEvent(revised)),true);assert.deepEqual(await grants(c),g);
 const counter={captures:0};await grantFutureRuntime({app:c.owner,event:revised,clock:c.clock,setNow:c.setNow,counter});await c.runtime.close();assert.equal((await inspectV2(c.f.paths.ledger)).records.at(-1).type,'END');
 const workflow=await c.workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:(await c.workflow.recoveryReview()).hash,principal:'TEMP-era15-restart'}),runtime=componentLaunch(c.f,{clock:c.clock});
 try{const restarted=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});await grantFutureRuntime({app:restarted.owner,event:revised,clock:c.clock,setNow:c.setNow,counter,replay:true});assert.equal(counter.captures,1);assert.deepEqual(await grants(c),g);}finally{await runtime.close();}
}));

test('canonical recovery restores authority for a revised identity, consume/capture and no replay',async t=>{
 const f=await eraFixture(t);await f.writer.transition(f.authorization);let workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
 const old=JSON.parse(await readFile(f.paths.schedule)).events.find(e=>e.type==='source.live'),event={...old,id:'era15-recovery-revision',startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};
 for(const k of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete event[k];
 const input=join(f.root,'publication-input.json'),observation=join(f.root,'publication-observation.json');await writeFile(input,JSON.stringify({root:f.root,paths:f.paths,authorization:f.authorization,event,observation,native:false}));
 const env={...process.env,LIVEZONE_NATIVE_TEST_ROOTS:JSON.stringify([f.root])};delete env.NODE_TEST_CONTEXT;
 const child=await new Promise((ok,no)=>{const p=spawn(process.execPath,['test-support/era-publication-fenced-child.mjs',input],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',v=>stdout+=v);p.stderr.on('data',v=>stderr+=v);p.once('error',no);p.once('close',code=>ok({code,stdout,stderr}));});
 assert.equal(child.code,73,child.stderr);assert.ok(child.stdout.includes('"fenced":true'));const observed=JSON.parse(await readFile(observation));assert.equal(observed.runtimeStatus,'UNAVAILABLE');
 const era=executionEraStartup(f.paths.ledger),names=await grantNames(era),grantPath=join(era.directory,'grant-'+observed.grant.incarnationId+'.json'),bytes=await readFile(grantPath);
 f.writer.host.proveOffline=async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]});
 await workflow.recoverStart({authorizeRecovery:true,authorizeCompletedOwnerRecovery:true,expectedReviewHash:(await workflow.recoveryReview()).hash});
 workflow=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:(await workflow.recoveryReview()).hash,principal:'TEMP-era14-recovery'});
 let now=Date.parse('2030-01-01T11:50:00.000Z'),runtime=componentLaunch(f,{clock:()=>now});
 try{
  const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});assert.equal(owner.ledger.status,'READY');
  const store=owner.scheduler.store;assert.equal((await store.insert(event,store.state.revision)).ok,true);assert.equal(store.getEvent(event.id).incarnationId,observed.grant.incarnationId);
  assert.equal((await store.insert(event,store.state.revision)).alreadyPublished,true);assert.deepEqual(await grantNames(era),names);assert.deepEqual(await readFile(grantPath),bytes);
  assert.equal(await readFile(f.paths.program,'utf8'),observed.program);assert.equal(await readFile(f.paths.autoLive,'utf8'),observed.auto);
  const oldIdentity=identityForScheduledEvent(store.getEvent(event.id));assert.equal((await store.update(event.id,{startAt:'2030-01-01T12:01:00.000Z'},store.state.revision)).ok,true);event.startAt='2030-01-01T12:01:00.000Z';assert.equal(eraAdmits(era,oldIdentity),false);assert.equal(eraAdmits(era,identityForScheduledEvent(store.getEvent(event.id))),true);assert.deepEqual(await readFile(grantPath),bytes);const counter={captures:0};await grantFutureRuntime({app:owner,event,clock:()=>now,setNow:v=>now=v,counter});await runtime.close();
  assert.equal((await inspectV2(f.paths.ledger)).records.at(-1).type,'END');
  workflow=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:(await workflow.recoveryReview()).hash,principal:'TEMP-era14-after-END'});
  runtime=componentLaunch(f,{clock:()=>now});const restarted=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  await grantFutureRuntime({app:restarted.owner,event,clock:()=>now,setNow:v=>now=v,counter,replay:true});assert.equal(counter.captures,1);assert.deepEqual(await grantNames(era),names);assert.deepEqual(await readFile(grantPath),bytes);
 }finally{await runtime.close();}
});
