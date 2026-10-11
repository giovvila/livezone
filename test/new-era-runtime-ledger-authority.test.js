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
import {seal,hash,inspectV2,envelope} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {ledgerSnapshot} from '../server/scheduler/ScheduledEntryLedgerContract.js';
const results=[];
const grantNames=async era=>(await readdir(era.directory)).filter(n=>n.startsWith('grant-')).sort();
const save=()=>process.env.LIVEZONE_ERA13_OBSERVATIONS?writeFile(process.env.LIVEZONE_ERA13_OBSERVATIONS,JSON.stringify(results,null,2)+'\n'):Promise.resolve();
async function protectedHashes(f,readyPath){const paths=[f.paths.ledger,f.paths.ledger+'.wal',f.paths.bootstrap,f.paths.ledgerLock,f.paths.authority,f.paths.authorityLock,f.paths.schedule,f.paths.program,f.paths.autoLive,readyPath];return Object.fromEntries(await Promise.all(paths.map(async p=>[p,hash(await readFile(p))])));}
test('fresh independent NEW-ERA-11 and NEW-ERA-10 retests plus current WAL coherence',async t=>{
 const f=await eraFixture(t);await f.writer.transition(f.authorization);const runtime=componentLaunch(f),workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
 try{
  const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const authority=owner.executionOwnership,era=executionEraStartup(f.paths.ledger),store=owner.scheduler.store,options={authority,durability:f.writer.durability};
  const readyPath=join(era.directory,'start-'+authority.authorityProcessSession+'.json.ready'),readyBytes=await readFile(readyPath),ready=unsealEra(JSON.parse(readyBytes));
  const foreign=randomUUID();await writeFile(readyPath,eraRecordBytes(seal({...ready,ledgerId:foreign})));
  try{
   const before=await protectedHashes(f,readyPath);let error=null;try{await issueEraEntry(era,'a3-exact-era11',options);}catch(e){error=e;}
   assert.ok(error,'NEW-ERA-11 exact retest must reject');assert.deepEqual(await grantNames(era),[]);assert.deepEqual(await protectedHashes(f,readyPath),before);
   results.push({probe:'NEW-ERA-11 exact retest',pass:true,rejected:error.code,grantOrStageCount:0,protectedBytesUnchanged:true});await save();
  }finally{await writeFile(readyPath,readyBytes);}
  const old=store.listEvents().find(e=>e.type==='source.live'),event={...old,id:'a3-exact-era10',name:'independent future',startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};
  for(const key of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete event[key];
  const revision=store.state.revision;store.eraGrantHook=p=>{if(p==='grant-schedule/before-open')throw Error('A3_TEMP_PUBLICATION_FAILURE');};assert.equal((await store.insert(event,revision)).ok,false);store.eraGrantHook=undefined;
  const firstNames=await grantNames(era);assert.equal(firstNames.length,1);const grantPath=join(era.directory,firstNames[0]),g1bytes=await readFile(grantPath),g1=JSON.parse(g1bytes);
  assert.equal((await store.update(old.id,{name:'A3 compatible unrelated change'},revision)).ok,true);assert.equal((await store.insert(event,store.state.revision)).ok,true);
  const published=store.getEvent(event.id);assert.equal(published.incarnationId,g1.incarnationId);assert.equal(published.entryGrantHash,hash(g1bytes));assert.deepEqual(await readFile(grantPath),g1bytes);assert.deepEqual(await grantNames(era),firstNames);assert.equal(eraAdmits(era,identityForScheduledEvent(published)),true);assert.equal((await inspectV2(f.paths.ledger)).current.entries.length,0);
  results.push({probe:'NEW-ERA-10 exact retest',pass:true,grantCount:1,sameBytes:true,sameIncarnation:true,incarnationId:g1.incarnationId,entryGrantHash:hash(g1bytes),admitted:true,ledgerEntries:0});await save();
  const walPath=f.paths.ledger+'.wal',walBytes=await readFile(walPath),last=JSON.parse(walBytes.toString('utf8').trimEnd().split('\n').at(-1));
  const tail=seal({schemaVersion:2,type:'A3_UNSUPPORTED_RECORD',previous:last.checksum,data:{}});
  await writeFile(walPath,Buffer.concat([walBytes,Buffer.from(JSON.stringify(tail)+'\n')]));
  try{
   let inspectionError=null;try{await inspectV2(f.paths.ledger);}catch(e){inspectionError={code:e.code,message:e.message};}assert.equal(inspectionError?.code,'LEDGER_V2_RECORD_UNSUPPORTED');
   const before=await protectedHashes(f,readyPath),beforeNames=await grantNames(era);let accepted=null,rejected=null;
   try{accepted=await issueEraEntry(era,'a3-invalid-current-wal',options);}catch(e){rejected={code:e.code,message:e.message};}
   const afterNames=await grantNames(era),after=await protectedHashes(f,readyPath);
   results.push({probe:'current WAL invalid beyond intact READY prefix',inspectionError,accepted,rejected,beforeGrantCount:beforeNames.length,afterGrantCount:afterNames.length,addedGrants:afterNames.filter(n=>!beforeNames.includes(n)),admitted:accepted?eraAdmits(era,{identitySchema:2,eventId:'a3-invalid-current-wal',...accepted}):false,protectedBytesUnchanged:JSON.stringify(before)===JSON.stringify(after),readyUnchanged:(await readFile(readyPath)).equals(readyBytes),ledgerId:era.ledgerId,executionEraId:era.executionEraId,originalWalHash:hash(walBytes),injectedWalHash:hash(await readFile(walPath)),tail});await save();
   assert.ok(rejected,'INVALID_CURRENT_WAL_ACCEPTED: issuance installed a grant despite canonical Ledger inspection rejecting the current WAL');assert.deepEqual(afterNames,beforeNames);
  }finally{await writeFile(walPath,walBytes);}
 }finally{await runtime.close();}
});

test('A4 coherent post-READY rollback cannot authorize a grant after live writer rejects it',async t=>{
 const f=await eraFixture(t);await f.writer.transition(f.authorization);
 const runtime=componentLaunch(f),workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
 let latestWal,latestSnapshot;
 try{
  const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const authority=owner.executionOwnership,era=executionEraStartup(f.paths.ledger),store=owner.scheduler.store;
  const old=store.listEvents().find(e=>e.type==='source.live'),event={...old,id:'a4-consumed-future',name:'A4 fresh future',startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};
  for(const key of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete event[key];
  const inserted=await store.insert(event,store.getSnapshot().revision);assert.equal(inserted.ok,true,JSON.stringify(inserted));
  const identity=identityForScheduledEvent(store.getEvent(event.id));
  const walPath=f.paths.ledger+'.wal',beforeWal=await readFile(walPath),beforeSnapshot=await readFile(f.paths.ledger);
  const consumed=await owner.ledger.consume(identity,{authorityEpoch:authority.authorityEpoch,authorityProcessSession:authority.authorityProcessSession,consumedAt:'2030-01-01T12:00:00.000Z'});
  assert.equal(consumed.status,'CONSUMED');const current=await inspectV2(f.paths.ledger);assert.equal(current.current.generation,1);assert.equal(current.current.entries.length,1);
  latestWal=await readFile(walPath);latestSnapshot=await readFile(f.paths.ledger);
  assert.equal(owner.ledger.snapshot.generation,1);
  await writeFile(walPath,beforeWal);await writeFile(f.paths.ledger,beforeSnapshot);
  const rolled=await inspectV2(f.paths.ledger);assert.equal(rolled.current.generation,0);assert.equal(rolled.current.entries.length,0);
  let writerError=null;try{await owner.ledger.verifySnapshot();}catch(e){writerError={code:e.code,message:e.message};}
  assert.equal(writerError?.code,'LEDGER_V2_CHANGED_EXTERNALLY');
  const inspection=await owner.ledger.inspect(identity);assert.equal(inspection.status,'UNAVAILABLE');assert.equal(owner.ledger.status,'UNAVAILABLE');
  const readyPath=join(era.directory,'start-'+authority.authorityProcessSession+'.json.ready');
  const before=await protectedHashes(f,readyPath),beforeNames=await grantNames(era);
  let accepted=null,rejected=null;try{accepted=await issueEraEntry(era,'a4-after-coherent-rollback',{authority,durability:f.writer.durability});}catch(e){rejected={code:e.code,message:e.message};}
  const afterNames=await grantNames(era);
  const observation={probe:'A4 coherent post-READY rollback accepted at issuance',expected:'reject before new grant/stage',liveWriterGeneration:owner.ledger.snapshot.generation,
   canonicalGeneration:rolled.current.generation,canonicalInspectionAccepted:true,liveWriterVerification:writerError,liveWriterStatus:owner.ledger.status,liveWriterError:owner.ledger.error,
   accepted,rejected,admitted:accepted?eraAdmits(era,{identitySchema:2,eventId:'a4-after-coherent-rollback',...accepted}):false,
   beforeGrantCount:beforeNames.length,afterGrantCount:afterNames.length,addedGrants:afterNames.filter(n=>!beforeNames.includes(n)),
   protectedBytesUnchanged:JSON.stringify(await protectedHashes(f,readyPath))===JSON.stringify(before),ledgerId:era.ledgerId,executionEraId:era.executionEraId,
   consumedEntryKey:identity.entryKey,readyWalHash:hash(beforeWal),consumedWalHash:hash(latestWal),rolledSnapshotHash:hash(beforeSnapshot),consumedSnapshotHash:hash(latestSnapshot),captureDemonstrated:false};
  results.push(observation);await save();
  assert.ok(rejected,'LIVE_LEDGER_ROLLBACK_ACCEPTED: live Ledger writer refuses the rolled-back state but issuance installs a durable grant');
  assert.deepEqual(afterNames,beforeNames);
  assert.equal(observation.protectedBytesUnchanged,true);assert.equal(observation.admitted,false);
  const failedPublication=await store.insert({...event,id:'a4-unavailable-publication'},store.state.revision);
  assert.equal(failedPublication.ok,false);assert.equal(store.getEvent('a4-unavailable-publication'),null);
  assert.deepEqual(await grantNames(era),beforeNames);assert.deepEqual(await protectedHashes(f,readyPath),before);
 }finally{
  if(latestWal){await writeFile(f.paths.ledger+'.wal',latestWal);await writeFile(f.paths.ledger,latestSnapshot);}
  await runtime.close();
 }
});

async function readyRun(t,run){
 const f=await eraFixture(t);await f.writer.transition(f.authorization);const runtime=componentLaunch(f);
 try{const {owner}=await controlledStart({workflow:new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization}),authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const era=executionEraStartup(f.paths.ledger),authority=owner.executionOwnership;
  await run({f,runtime,owner,era,authority,options:{authority,durability:f.writer.durability},readyPath:join(era.directory,'start-'+authority.authorityProcessSession+'.json.ready')});
 }finally{await runtime.close();}
}
const image=async c=>({snapshot:await readFile(c.f.paths.ledger),wal:await readFile(c.f.paths.ledger+'.wal')});
const restore=async(c,v)=>{await writeFile(c.f.paths.ledger,v.snapshot);await writeFile(c.f.paths.ledger+'.wal',v.wal);};
async function consumeNew(c,id,beforeConsume=()=>{},expectedStatus='CONSUMED'){
 const store=c.owner.scheduler.store,old=store.listEvents().find(e=>e.type==='source.live'),event={...old,id,startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};
 for(const key of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete event[key];
 assert.equal((await store.insert(event,store.state.revision)).ok,true);
 const identity=identityForScheduledEvent(store.getEvent(id));
 beforeConsume();
 assert.equal((await c.owner.ledger.consume(identity,{authorityEpoch:c.authority.authorityEpoch,authorityProcessSession:c.authority.authorityProcessSession,consumedAt:'2030-01-01T12:00:00.000Z'})).status,expectedStatus);return identity;
}
async function noGrant(c,id,options=c.options){
 const before=await protectedHashes(c.f,c.readyPath),names=await grantNames(c.era);
 await assert.rejects(issueEraEntry(c.era,id,options));assert.deepEqual(await grantNames(c.era),names);
 assert.deepEqual(await protectedHashes(c.f,c.readyPath),before);
 assert.equal(eraAdmits(c.era,{identitySchema:2,eventId:id,executionEraId:c.era.executionEraId,incarnationId:randomUUID(),entryGrantHash:'0'.repeat(64)}),false);
}
for(const mode of ['1-to-0','2-to-1','same-generation-fork','snapshot-only','WAL-only','foreign-ledgerId','foreign-era','restored-after-unavailable'])test('runtime rollback fence: '+mode,t=>readyRun(t,async c=>{
 const zero=await image(c),identity=await consumeNew(c,'era13-first'),one=await image(c);
 if(mode==='2-to-1')await consumeNew(c,'era13-second');
 const latest=await image(c);
 try{
  if(mode==='1-to-0'||mode==='restored-after-unavailable')await restore(c,zero);
  else if(mode==='2-to-1')await restore(c,one);
  else if(mode==='snapshot-only')await writeFile(c.f.paths.ledger,zero.snapshot);
  else if(mode==='WAL-only')await writeFile(c.f.paths.ledger+'.wal',zero.wal);
  else if(mode==='same-generation-fork'){
   const records=one.wal.toString().trim().split('\n').map(JSON.parse),intent=records.at(-2);
   const next=ledgerSnapshot({...intent.data.next,entries:intent.data.next.entries.map(e=>({...e,consumedAt:'2030-01-01T12:01:00.000Z'}))});
   records[records.length-2]=seal({schemaVersion:2,type:'INTENT',previous:intent.previous,data:{...intent.data,next,nextHash:hash(next)}});
   const commit=records.at(-1);records[records.length-1]=seal({schemaVersion:2,type:'COMMIT',previous:records.at(-2).checksum,data:{...commit.data,nextHash:hash(next)}});
   await restore(c,{snapshot:Buffer.from(JSON.stringify(envelope(c.f.paths.ledger,next))+'\n'),wal:Buffer.from(records.map(JSON.stringify).join('\n')+'\n')});
   assert.equal((await inspectV2(c.f.paths.ledger)).current.generation,1);
  }else{
   const records=zero.wal.toString().trim().split('\n').map(JSON.parse),snapshot=ledgerSnapshot({...records[0].data.snapshot,...(mode==='foreign-ledgerId'?{ledgerId:randomUUID()}:{executionEraId:randomUUID()})});
   records[0]=seal({schemaVersion:2,type:'BASE',previous:null,data:{...records[0].data,snapshot}});
   records[1]=seal({schemaVersion:2,type:'BEGIN',previous:records[0].checksum,data:{...records[1].data,ledgerId:snapshot.ledgerId,executionEraId:snapshot.executionEraId,initialLedgerHash:hash(snapshot)}});
   await restore(c,{snapshot:Buffer.from(JSON.stringify(envelope(c.f.paths.ledger,snapshot))+'\n'),wal:Buffer.from(records.map(JSON.stringify).join('\n')+'\n')});
   await inspectV2(c.f.paths.ledger);
  }
  if(mode==='restored-after-unavailable'){
   assert.equal((await c.owner.ledger.inspect(identity)).status,'UNAVAILABLE');await restore(c,latest);
  }
  await noGrant(c,'era13-rejected-'+mode);
  if(['1-to-0','2-to-1','same-generation-fork','restored-after-unavailable'].includes(mode)){
   assert.equal(c.owner.ledger.status,'UNAVAILABLE');assert.equal(c.owner.ledger.error,'LEDGER_V2_CHANGED_EXTERNALLY');
   await restore(c,latest);await c.owner.ledger.initialize();await noGrant(c,'era13-sticky-'+mode);assert.equal(c.owner.ledger.status,'UNAVAILABLE');
  }
 }finally{await restore(c,latest);}
}));

test('real writer progression 0 to 1 to 2 authorizes grants with unchanged READY',t=>readyRun(t,async c=>{
 const ready=await readFile(c.readyPath);
 for(let generation=0;generation<=2;generation++){
  if(generation)await consumeNew(c,'era13-progression-'+generation);
  assert.equal(c.owner.ledger.snapshot.generation,generation);assert.equal((await inspectV2(c.f.paths.ledger)).current.generation,generation);
  const grant=await issueEraEntry(c.era,'era13-at-generation-'+generation,c.options);assert.equal(eraAdmits(c.era,{identitySchema:2,eventId:'era13-at-generation-'+generation,...grant},{requirePublished:false}),true);
  assert.deepEqual(await readFile(c.readyPath),ready);
 }
}));
test('offline authority copy cannot substitute for canonical initialized repository',t=>readyRun(t,async c=>{
 await noGrant(c,'era13-offline',{...c.options,authority:{...c.authority}});
 assert.equal(c.owner.ledger.status,'READY');await issueEraEntry(c.era,'era13-canonical',c.options);
}));
for(const point of ['grant/authorized','grant/before-open'])test('known runtime loss at '+point+' rejects before staging',t=>readyRun(t,async c=>{
 const zero=await image(c),identity=await consumeNew(c,'era13-race-consumed'),latest=await image(c),before=await protectedHashes(c.f,c.readyPath),names=await grantNames(c.era);
 try{
  await assert.rejects(issueEraEntry(c.era,'era13-race',{...c.options,hook:async p=>{if(p===point){await restore(c,zero);assert.equal((await c.owner.ledger.inspect(identity)).status,'UNAVAILABLE');await restore(c,latest);}}}));
  assert.deepEqual(await grantNames(c.era),names);assert.deepEqual(await protectedHashes(c.f,c.readyPath),before);assert.equal(c.owner.ledger.status,'UNAVAILABLE');
 }finally{await restore(c,latest);}
}));
test('shutdown freezes authority synchronously before END',t=>readyRun(t,async c=>{
 const pending=c.owner.ledger.finalize();assert.equal(c.owner.ledger.closed,true);
 await assert.rejects(issueEraEntry(c.era,'era13-shutdown',c.options));await pending;
 await noGrant(c,'era13-terminal');
}));
test('in-flight real INTENT cannot authorize issuance during durability uncertainty',t=>readyRun(t,async c=>{
 let release,reached;const barrier=new Promise(r=>release=r),opened=new Promise(r=>reached=r),original=c.owner.ledger.fs.open;
 const pending=consumeNew(c,'era13-in-flight',()=>{c.owner.ledger.fs.open=async(...args)=>{
  if(args[0]===c.f.paths.ledger+'.wal'){c.owner.ledger.fs.open=original;reached();await barrier;}
  return original(...args);
 };});
 try{await opened;assert.equal(c.owner.ledger.status,'DURABILITY_UNCERTAIN');await noGrant(c,'era13-during-intent');}
 finally{release();await pending;c.owner.ledger.fs.open=original;}
 assert.equal(c.owner.ledger.status,'READY');await issueEraEntry(c.era,'era13-after-commit',c.options);
}));
test('consume verified before issuance detects rollback cannot clear sticky runtime fence',t=>readyRun(t,async c=>{
 const zero=await image(c);await consumeNew(c,'era13-before-verification-race');const latest=await image(c),repository=c.owner.ledger,original=repository.verifySnapshot;
 let reached,release;const verified=new Promise(r=>reached=r),barrier=new Promise(r=>release=r);
 const pending=consumeNew(c,'era13-queued-after-verification',()=>{repository.verifySnapshot=async()=>{await original.call(repository);reached();await barrier;};},'UNAVAILABLE');
 try{
  await verified;await restore(c,zero);await noGrant(c,'era13-verification-race');assert.equal(repository.status,'UNAVAILABLE');
  await restore(c,latest);release();await pending;
  assert.equal(repository.status,'UNAVAILABLE');assert.equal(repository.error,'LEDGER_V2_CHANGED_EXTERNALLY');assert.equal(repository.snapshot.generation,1);assert.deepEqual(await image(c),latest);
  await noGrant(c,'era13-after-queued-fence');
 }finally{release();repository.verifySnapshot=original;await restore(c,latest);await pending;}
}));
