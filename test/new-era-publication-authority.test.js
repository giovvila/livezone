import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {executionEraStartup,issueEraEntry,eraAdmits,eraRecordBytes,unsealEra} from '../server/recovery/ExecutionEraContract.js';
import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';
import {seal,hash,inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
const results=[];
const grantNames=async era=>(await readdir(era.directory)).filter(n=>n.startsWith('grant-')).sort();
const save=()=>process.env.LIVEZONE_ERA14_OBSERVATIONS?writeFile(process.env.LIVEZONE_ERA14_OBSERVATIONS,JSON.stringify(results,null,2)+'\n'):Promise.resolve();
async function protectedHashes(f,readyPath){const paths=[f.paths.ledger,f.paths.ledger+'.wal',f.paths.bootstrap,f.paths.ledgerLock,f.paths.authority,f.paths.authorityLock,f.paths.schedule,f.paths.program,f.paths.autoLive,readyPath,readyPath.slice(0,-6)];for(const name of await readdir(f.writer.directory+'-recovery'))paths.push(join(f.writer.directory+'-recovery',name));return Object.fromEntries(await Promise.all(paths.map(async p=>[p,hash(await readFile(p))])));}

test('A5 publication authority after writer detects rollback and disk restoration',async t=>{
 const f=await eraFixture(t);await f.writer.transition(f.authorization);const runtime=componentLaunch(f);
 let latestWal,latestSnapshot;
 try{
  const {owner}=await controlledStart({workflow:new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization}),authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const authority=owner.executionOwnership,era=executionEraStartup(f.paths.ledger),store=owner.scheduler.store;
  const readyPath=join(era.directory,'start-'+authority.authorityProcessSession+'.json.ready');
  const zeroWal=await readFile(f.paths.ledger+'.wal'),zeroSnapshot=await readFile(f.paths.ledger);
  const old=store.listEvents().find(e=>e.type==='source.live');
  function event(id){const e={...old,id,startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};for(const k of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete e[k];return e;}
  assert.equal((await store.insert(event('a5-publication-consumed'),store.state.revision)).ok,true);
  const identity=identityForScheduledEvent(store.getEvent('a5-publication-consumed'));
  assert.equal((await owner.ledger.consume(identity,{authorityEpoch:authority.authorityEpoch,authorityProcessSession:authority.authorityProcessSession,consumedAt:'2030-01-01T12:00:00.000Z'})).status,'CONSUMED');
  latestWal=await readFile(f.paths.ledger+'.wal');latestSnapshot=await readFile(f.paths.ledger);
  const baseline=await protectedHashes(f,readyPath),beforeSchedule=await readFile(f.paths.schedule);let atBoundary=null;
  store.eraGrantHook=async point=>{if(point==='grant-schedule/namespace-flushed'){
   await writeFile(f.paths.ledger+'.wal',zeroWal);await writeFile(f.paths.ledger,zeroSnapshot);
   assert.equal((await inspectV2(f.paths.ledger)).current.generation,0);
   assert.equal((await owner.ledger.inspect(identity)).status,'UNAVAILABLE');
   await writeFile(f.paths.ledger+'.wal',latestWal);await writeFile(f.paths.ledger,latestSnapshot);
   assert.equal((await inspectV2(f.paths.ledger)).current.generation,1);
   atBoundary={status:owner.ledger.status,error:owner.ledger.error,diskGeneration:1,grants:await grantNames(era)};
  }};
  const result=await store.insert(event('a5-published-after-runtime-loss'),store.state.revision);store.eraGrantHook=undefined;
  const published=store.getEvent('a5-published-after-runtime-loss');
  const after=await protectedHashes(f,readyPath);
  const observation={probe:'publication after detected rollback with coherent restored disk',atBoundary,resultOk:result.ok,resultCode:result.code,published:!!published,admitted:published?eraAdmits(era,identityForScheduledEvent(published)):false,runtimeStatus:owner.ledger.status,scheduleChanged:!(await readFile(f.paths.schedule)).equals(beforeSchedule),protectedChanges:Object.keys(baseline).filter(k=>baseline[k]!==after[k]),captureDemonstrated:false};
  results.push(observation);await save();
  assert.ok(atBoundary);assert.equal(result.ok,false,'PUBLICATION_ACCEPTED_WITH_UNAVAILABLE_LEDGER_RUNTIME');assert.equal(published,null);assert.deepEqual(await readFile(f.paths.schedule),beforeSchedule);assert.deepEqual(after,baseline);assert.equal(owner.ledger.status,'UNAVAILABLE');
 }finally{if(latestWal){await writeFile(f.paths.ledger+'.wal',latestWal);await writeFile(f.paths.ledger,latestSnapshot);}await runtime.close();}
});

async function readyCase(t,fn){
 const f=await eraFixture(t);await f.writer.transition(f.authorization);const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization}),runtime=componentLaunch(f);
 try{const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const era=executionEraStartup(f.paths.ledger),authority=owner.executionOwnership,store=owner.scheduler.store;
  const readyPath=join(era.directory,'start-'+authority.authorityProcessSession+'.json.ready');
  const event=id=>{const e={...store.listEvents().find(e=>e.type==='source.live'),id,startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};for(const k of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete e[k];return e;};
  await fn({f,workflow,runtime,owner,era,authority,store,readyPath,event});
 }finally{await runtime.close();}
}
const image=async c=>({wal:await readFile(c.f.paths.ledger+'.wal'),snapshot:await readFile(c.f.paths.ledger)});
const restore=async(c,v)=>{await writeFile(c.f.paths.ledger+'.wal',v.wal);await writeFile(c.f.paths.ledger,v.snapshot);};
async function seed(c){assert.equal((await c.store.insert(c.event('era14-seed'),c.store.state.revision)).ok,true);return identityForScheduledEvent(c.store.getEvent('era14-seed'));}
const consume=(c,i)=>c.owner.ledger.consume(i,{authorityEpoch:c.authority.authorityEpoch,authorityProcessSession:c.authority.authorityProcessSession,consumedAt:'2030-01-01T12:00:00.000Z'});
async function lose(c,identity,zero){const latest=await image(c);await restore(c,zero);assert.equal((await inspectV2(c.f.paths.ledger)).current.generation,0);assert.equal((await c.owner.ledger.inspect(identity)).status,'UNAVAILABLE');await restore(c,latest);assert.equal(c.owner.ledger.status,'UNAVAILABLE');return latest;}

test('G1 precedes legitimate growth and sticky rollback; publication leaves all canonical files unchanged',t=>readyCase(t,async c=>{
 const identity=await seed(c),zero=await image(c),before=await protectedHashes(c.f,c.readyPath);let g1,path,bytes;
 // Capture the legitimate durable grant before advancing the actual writer.
 c.store.eraGrantHook=async point=>{if(point==='grant-schedule/before-open'){
  for(const name of await grantNames(c.era)){const b=await readFile(join(c.era.directory,name));const g=JSON.parse(b);if(g.eventId==='era14-exact-sequence'){g1=g;bytes=b;path=join(c.era.directory,name);}}
  assert.ok(g1);assert.equal(c.owner.ledger.snapshot.generation,0);
  assert.equal((await consume(c,identity)).status,'CONSUMED');await lose(c,identity,zero);
 }};
 const result=await c.store.insert(c.event('era14-exact-sequence'),c.store.state.revision);c.store.eraGrantHook=undefined;
 const published=c.store.getEvent('era14-exact-sequence');results.push({probe:'G1 before legitimate generation advancement and rollback fence',resultOk:result.ok,published:!!published,admitted:published?eraAdmits(c.era,identityForScheduledEvent(published)):false,grantBytesUnchanged:(await readFile(path)).equals(bytes),runtimeStatus:c.owner.ledger.status,scheduleChanged:hash(await readFile(c.f.paths.schedule))!==before[c.f.paths.schedule]});await save();
 assert.equal(result.ok,false);assert.equal(c.store.getEvent('era14-exact-sequence'),null);assert.deepEqual(await readFile(path),bytes);
 const after=await protectedHashes(c.f,c.readyPath);for(const p of Object.keys(before))if(![c.f.paths.ledger,c.f.paths.ledger+'.wal'].includes(p))assert.equal(after[p],before[p]);
 assert.equal(eraAdmits(c.era,{identitySchema:2,eventId:g1.eventId,incarnationId:g1.incarnationId,executionEraId:g1.executionEraId,entryGrantHash:hash(bytes)}),false);
 const pending=identityForScheduledEvent({...c.event(g1.eventId),incarnationId:g1.incarnationId,entryRevision:1,entryMigration:null,executionEraId:g1.executionEraId,entryGrantHash:hash(bytes)});
 assert.equal((await consume(c,pending)).status,'OLD_EXECUTION_DOMAIN_RETIRED');assert.equal(c.owner.ledger.snapshot.entries.length,1);
 await c.owner.ledger.initialize();assert.equal(c.owner.ledger.status,'UNAVAILABLE');
 await assert.rejects(issueEraEntry(c.era,'era14-new-after-fence',{authority:c.authority,durability:c.f.writer.durability}),/RUNTIME_NOT_OPERATIONAL/);
}));

for(const mode of ['healthy','invalid-WAL','foreign-READY-ledger','foreign-era','retired-identity','lost-browser-authority','lost-READY','changed-grant','uncertain-writer','terminal-writer'])test('publication authority matrix: '+mode,t=>readyCase(t,async c=>{
 const before=await protectedHashes(c.f,c.readyPath),originalReady=await readFile(c.readyPath),originalWal=await readFile(c.f.paths.ledger+'.wal');let grantPath,grantBytes;
 c.store.eraGrantHook=async point=>{if(point!=='grant-schedule/before-open')return;
  for(const name of await grantNames(c.era)){const p=join(c.era.directory,name),b=await readFile(p);if(JSON.parse(b).eventId==='era14-matrix'){grantPath=p;grantBytes=b;}}
  if(mode==='invalid-WAL'){const last=JSON.parse(originalWal.toString().trim().split('\n').at(-1));await writeFile(c.f.paths.ledger+'.wal',Buffer.concat([originalWal,Buffer.from(JSON.stringify(seal({schemaVersion:2,type:'ERA14_UNSUPPORTED',previous:last.checksum,data:{}}))+'\n')]));}
  if(mode==='foreign-READY-ledger')await writeFile(c.readyPath,eraRecordBytes(seal({...unsealEra(JSON.parse(originalReady)),ledgerId:randomUUID()})));
  if(mode==='foreign-era')c.authority.executionEraId=randomUUID();
  if(mode==='retired-identity')await writeFile(grantPath,eraRecordBytes(seal({...unsealEra(JSON.parse(grantBytes)),eventId:c.era.oldEventIds[0]})));
  if(mode==='lost-browser-authority')c.authority.available=false;
  if(mode==='lost-READY')c.authority.eraReady=false;
  if(mode==='changed-grant')await writeFile(grantPath,Buffer.concat([grantBytes,Buffer.from(' ')]));
  if(mode==='uncertain-writer')c.owner.ledger.status='DURABILITY_UNCERTAIN';
  if(mode==='terminal-writer')await c.owner.ledger.finalize();
 };
 try{const result=await c.store.insert(c.event('era14-matrix'),c.store.state.revision);
  if(mode==='healthy'){assert.equal(result.ok,true,result.code);assert.equal(eraAdmits(c.era,identityForScheduledEvent(c.store.getEvent('era14-matrix'))),true);}
  else{assert.equal(result.ok,false,mode);assert.equal(c.store.getEvent('era14-matrix'),null);assert.equal(hash(await readFile(c.f.paths.schedule)),before[c.f.paths.schedule]);assert.ok(grantPath);}
  if(mode==='uncertain-writer')assert.equal(c.owner.ledger.status,'DURABILITY_UNCERTAIN');
  for(const p of [c.f.paths.program,c.f.paths.autoLive,c.f.paths.authority,c.f.paths.authorityLock])assert.equal(hash(await readFile(p)),before[p]);
 }finally{c.store.eraGrantHook=undefined;await writeFile(c.readyPath,originalReady);if(mode!=='terminal-writer')await writeFile(c.f.paths.ledger+'.wal',originalWal);if(grantPath)await writeFile(grantPath,grantBytes);c.authority.executionEraId=c.era.executionEraId;c.authority.available=true;c.authority.eraReady=true;if(mode==='uncertain-writer')c.owner.ledger.status='READY';}
}));

for(const point of ['grant-schedule/before-open','grant-schedule/opened','grant-schedule/partial-written','grant-schedule/file-flushed','grant-schedule/namespace-flushed','grant-schedule/before-install'])test('known operational authority loss at '+point+' cannot install Schedule',t=>readyCase(t,async c=>{
 const identity=await seed(c),zero=await image(c);assert.equal((await consume(c,identity)).status,'CONSUMED');const before=await protectedHashes(c.f,c.readyPath);
 c.store.eraGrantHook=async p=>{if(p===point)await lose(c,identity,zero);};
 const result=await c.store.insert(c.event('era14-race'),c.store.state.revision);c.store.eraGrantHook=undefined;
 assert.equal(result.ok,false);assert.equal(c.store.getEvent('era14-race'),null);assert.deepEqual(await protectedHashes(c.f,c.readyPath),before);
 assert.equal((await readdir(c.f.root)).filter(n=>n.startsWith('.schedule-')).length,0);assert.equal(c.owner.ledger.status,'UNAVAILABLE');
}));

test('ordinary editorial Schedule edit retains its contract under sticky Ledger fence',t=>readyCase(t,async c=>{
 const identity=await seed(c),zero=await image(c);assert.equal((await consume(c,identity)).status,'CONSUMED');await lose(c,identity,zero);
 const old=c.store.listEvents()[0];assert.equal((await c.store.update(old.id,{name:'ERA14 editorial'},c.store.state.revision)).ok,true);assert.equal(c.owner.ledger.status,'UNAVAILABLE');
}));

test('pending grant is evidence, not admission; healthy publication enables one consumption',t=>readyCase(t,async c=>{
 const e=c.event('era14-pending'),requestHash=hash({type:e.type,sourceId:e.payload.sourceId,startAt:e.startAt,endAt:e.endAt});
 const grant=await issueEraEntry(c.era,e.id,{authority:c.authority,durability:c.f.writer.durability,requestHash});
 const identity=identityForScheduledEvent({...e,...grant});assert.equal(eraAdmits(c.era,identity,{requirePublished:false}),true);assert.equal(eraAdmits(c.era,identity),false);
 assert.equal((await consume(c,identity)).status,'OLD_EXECUTION_DOMAIN_RETIRED');assert.equal(c.owner.ledger.snapshot.generation,0);
 assert.equal((await c.store.insert(e,c.store.state.revision)).ok,true);assert.equal(eraAdmits(c.era,identity),true);assert.equal((await consume(c,identity)).status,'CONSUMED');assert.equal((await consume(c,identity)).status,'ALREADY_CONSUMED');
}));

for(const point of ['grant-schedule/before-open','grant-schedule/installed','grant-schedule/before-return'])test('publication retry converges after '+point,t=>readyCase(t,async c=>{
 const e=c.event('era14-retry'),revision=c.store.state.revision;c.store.eraGrantHook=p=>{if(p===point)throw Error('ERA14_UNOBSERVED');};
 assert.equal((await c.store.insert(e,revision)).ok,false);c.store.eraGrantHook=undefined;if(!c.store.state)await c.store.hydrate();
 const names=await grantNames(c.era),bytes=await readFile(join(c.era.directory,names[0]));
 assert.equal((await c.store.insert(e,c.store.state.revision)).ok,true);const retry=await c.store.insert(e,revision);assert.equal(retry.ok,true);assert.equal(retry.alreadyPublished,true);
 assert.deepEqual(await grantNames(c.era),names);assert.deepEqual(await readFile(join(c.era.directory,names[0])),bytes);assert.equal(c.store.listEvents().filter(v=>v.id===e.id).length,1);
}));

import {spawn} from 'node:child_process';
import {grantFutureRuntime} from '../test-support/EraGrantFutureRuntime.js';
test('dead fenced owner canonical recovery publishes identical G1 once, consume-before-capture, END, restart/no replay',async t=>{
 const f=await eraFixture(t);await f.writer.transition(f.authorization);let workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
 const old=JSON.parse(await readFile(f.paths.schedule)).events.find(e=>e.type==='source.live'),event={...old,id:'era14-recovery-pending',startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};
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
  const counter={captures:0};await grantFutureRuntime({app:owner,event,clock:()=>now,setNow:v=>now=v,counter});await runtime.close();
  assert.equal((await inspectV2(f.paths.ledger)).records.at(-1).type,'END');
  workflow=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:(await workflow.recoveryReview()).hash,principal:'TEMP-era14-after-END'});
  runtime=componentLaunch(f,{clock:()=>now});const restarted=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  await grantFutureRuntime({app:restarted.owner,event,clock:()=>now,setNow:v=>now=v,counter,replay:true});assert.equal(counter.captures,1);assert.deepEqual(await grantNames(era),names);assert.deepEqual(await readFile(grantPath),bytes);
 }finally{await runtime.close();}
});

test('current publication admission requires the installed target grant hash',t=>readyCase(t,async c=>{
 const event=c.event('era14-published-hash');assert.equal((await c.store.insert(event,c.store.state.revision)).ok,true);const identity=identityForScheduledEvent(c.store.getEvent(event.id)),bytes=await readFile(c.f.paths.schedule),schedule=JSON.parse(bytes);
 await writeFile(c.f.paths.schedule,JSON.stringify({...schedule,events:schedule.events.map(e=>e.id===event.id?{...e,entryGrantHash:'0'.repeat(64)}:e)})+'\n');
 try{assert.equal(eraAdmits(c.era,identity),false);assert.equal((await consume(c,identity)).status,'OLD_EXECUTION_DOMAIN_RETIRED');}finally{await writeFile(c.f.paths.schedule,bytes);}
}));

test('conversion publication is fenced without mutating the existing ordinary event',t=>readyCase(t,async c=>{
 const identity=await seed(c),zero=await image(c);assert.equal((await consume(c,identity)).status,'CONSUMED');
 const source=c.event('era14-conversion'),overlay={...source,type:'overlay.crawl',payload:{text:'TEMP',position:'bottom',direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true}};
 assert.equal((await c.store.insert(overlay,c.store.state.revision)).ok,true);const before=await readFile(c.f.paths.schedule);
 c.store.eraGrantHook=async point=>{if(point==='grant-schedule/before-install')await lose(c,identity,zero);};
 const result=await c.store.update(overlay.id,{type:'source.live',payload:source.payload},c.store.state.revision);c.store.eraGrantHook=undefined;
 assert.equal(result.ok,false);assert.equal(c.store.getEvent(overlay.id).type,'overlay.crawl');assert.deepEqual(await readFile(c.f.paths.schedule),before);assert.equal(c.owner.ledger.status,'UNAVAILABLE');
}));
test('real in-flight Ledger INTENT fences an earlier grant at the final publication hook',t=>readyCase(t,async c=>{
 const identity=await seed(c),before=await readFile(c.f.paths.schedule),repository=c.owner.ledger,original=repository.fs.open;let release,reached,pending;
 const barrier=new Promise(r=>release=r),opened=new Promise(r=>reached=r);
 c.store.eraGrantHook=async point=>{if(point!=='grant-schedule/before-install')return;
  repository.fs.open=async(...args)=>{if(args[0]===c.f.paths.ledger+'.wal'){repository.fs.open=original;reached();await barrier;}return original(...args);};
  pending=consume(c,identity);await opened;assert.equal(repository.status,'DURABILITY_UNCERTAIN');
 };
 try{const result=await c.store.insert(c.event('era14-during-INTENT'),c.store.state.revision);assert.equal(result.ok,false);assert.equal(c.store.getEvent('era14-during-INTENT'),null);assert.deepEqual(await readFile(c.f.paths.schedule),before);assert.equal(repository.status,'DURABILITY_UNCERTAIN');}
 finally{release();if(pending)assert.equal((await pending).status,'CONSUMED');repository.fs.open=original;c.store.eraGrantHook=undefined;}
 assert.equal(repository.status,'READY');const names=await grantNames(c.era);assert.equal((await c.store.insert(c.event('era14-during-INTENT'),c.store.state.revision)).ok,true);assert.deepEqual(await grantNames(c.era),names);
}));
