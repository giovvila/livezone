import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {ledgerAuthority} from '../server/recovery/RestoreLedgerAuthority.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {executionEraStartup,issueEraEntry,eraAdmits,eraRecordBytes,unsealEra,assertEraAuthority} from '../server/recovery/ExecutionEraContract.js';
import {hash,seal,envelope,inspectV2,inspectV2Sync,equal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {grantFutureRuntime} from '../test-support/EraGrantFutureRuntime.js';
import {ledgerSnapshot,entryConsumption} from '../server/scheduler/ScheduledEntryLedgerContract.js';
import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';
const grantNames=async era=>(await readdir(era.directory)).filter(n=>n.startsWith('grant-')).sort();
async function readyFixture(t,run){
 const f=await eraFixture(t);await f.writer.transition(f.authorization);
 const runtime=componentLaunch(f),workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
 try{
  const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const era=executionEraStartup(f.paths.ledger),authority=owner.executionOwnership;
  const readyPath=join(era.directory,'start-'+authority.authorityProcessSession+'.json.ready');
  await run({f,runtime,workflow,owner,era,authority,readyPath,options:{authority,durability:f.writer.durability}});
 }finally{await runtime.close();}
}
async function protectedBytes(f,readyPath){
 const paths=[f.paths.ledger,f.paths.ledger+'.wal',f.paths.ledgerLock,f.paths.bootstrap,f.paths.authority,f.paths.authorityLock,f.paths.schedule,f.paths.program,f.paths.autoLive,readyPath];
 return Object.fromEntries(await Promise.all(paths.map(async path=>[path,hash(await readFile(path))])));
}
async function rejectWithoutMutation(c,eventId='era11-rejected'){
 const before=await protectedBytes(c.f,c.readyPath),names=await grantNames(c.era);
 const grantsBefore=await Promise.all(names.map(async name=>hash(await readFile(join(c.era.directory,name)))));let accepted=null,rejected=null;
 try{accepted=await issueEraEntry(c.era,eventId,c.options);}catch(error){rejected=error;}
 if(accepted)console.log(JSON.stringify({unexpectedAccepted:accepted,admitted:eraAdmits(c.era,{identitySchema:2,eventId,...accepted}),grantCountBefore:names.length,grantCountAfter:(await grantNames(c.era)).length}));
 assert.equal(accepted,null,'invalid READY authority installed a durable grant');assert.ok(rejected,'invalid READY authority must reject');
 assert.deepEqual(await grantNames(c.era),names,'no grant or stage may be created');assert.deepEqual(await protectedBytes(c.f,c.readyPath),before,'no dependent Ledger/Schedule/PROGRAM/AutoLive/authority mutation');
 assert.deepEqual(await Promise.all(names.map(async name=>hash(await readFile(join(c.era.directory,name))))),grantsBefore,'existing grant bytes remain unchanged');
 assert.equal(eraAdmits(c.era,{identitySchema:2,eventId,executionEraId:c.era.executionEraId,incarnationId:randomUUID(),entryGrantHash:'0'.repeat(64)}),false);
 return rejected;
}

test('A3 exact: unsupported sealed current WAL rejects before grant or stage',t=>readyFixture(t,async c=>{
 const path=c.f.paths.ledger+'.wal',bytes=await readFile(path),snapshot=await readFile(c.f.paths.ledger);
 const last=JSON.parse(bytes.toString().trimEnd().split('\n').at(-1));
 try{
  await writeFile(path,Buffer.concat([bytes,Buffer.from(JSON.stringify(seal({schemaVersion:2,type:'A3_UNSUPPORTED_RECORD',previous:last.checksum,data:{}}))+'\n')]));
  await assert.rejects(inspectV2(c.f.paths.ledger),{code:'LEDGER_V2_RECORD_UNSUPPORTED'});
  assert.deepEqual(await readFile(c.f.paths.ledger),snapshot);
  const error=await rejectWithoutMutation(c,'era12-exact');assert.equal(error.code,'LEDGER_V2_RECORD_UNSUPPORTED');
 }finally{await writeFile(path,bytes);}
}));

const line=record=>Buffer.from(JSON.stringify(record)+'\n');
function transaction(c,state){
 const identity={eventId:'era12-transaction',incarnationId:randomUUID(),entryRevision:1,type:'source.live',sourceId:'TEMP-source',
  startAt:'2030-01-01T12:00:00Z',endAt:'2030-01-01T12:10:00Z',executionEraId:c.era.executionEraId,entryGrantHash:hash('TEMP-grant')};
 const entry=entryConsumption(identity,{authorityEpoch:c.authority.authorityEpoch,authorityProcessSession:c.authority.authorityProcessSession,consumedAt:'2030-01-01T12:00:00Z'});
 const next=ledgerSnapshot({...state.current,generation:state.current.generation+1,entries:[...state.current.entries,entry]});
 return {transactionId:randomUUID(),entryKey:entry.identity.entryKey,owner:state.owner,previousGeneration:state.current.generation,
  previousHash:hash(state.current),nextGeneration:next.generation,nextHash:hash(next),next,createdAt:'2030-01-01T12:00:00Z'};
}
test('current WAL negative matrix shares canonical inspection and never mutates grants',t=>readyFixture(t,async c=>readyFixture(t,async foreign=>{
 const walPath=c.f.paths.ledger+'.wal',wal=await readFile(walPath),canonical=await readFile(c.f.paths.ledger),state=await inspectV2(c.f.paths.ledger);
 const intent=transaction(c,state),previous=state.records.at(-1).checksum;
 const forkRecords=state.records.map((r,i)=>seal({schemaVersion:2,type:r.type,previous:null,data:i===0?{...r.data,namespaceDurability:'FILE_SYNC_ONLY'}:r.data}));
 for(let i=1;i<forkRecords.length;i++)forkRecords[i]=seal({schemaVersion:2,type:forkRecords[i].type,previous:forkRecords[i-1].checksum,data:forkRecords[i].data});
 const record=(type,data,prev=previous)=>seal({schemaVersion:2,type,previous:prev,data});
 const intentRecord=record('INTENT',intent),completed=Buffer.concat([wal,line(intentRecord),line(record('COMMIT',{transactionId:intent.transactionId,nextHash:intent.nextHash},intentRecord.checksum))]);
 const end=record('END',{processSession:state.owner.processSession,snapshotHash:hash(state.current),recovered:false});
 const wrongBegin=seal({schemaVersion:2,type:'BEGIN',previous:end.checksum,data:{...state.owner,ledgerId:randomUUID(),processSession:randomUUID()}});
 const cases=[
  ['unsupported sealed record',Buffer.concat([wal,line(record('UNSUPPORTED',{}))])],
  ['truncated record',Buffer.concat([wal,Buffer.from('{"schemaVersion":2')])],
  ['malformed JSON',Buffer.concat([wal,Buffer.from('{bad}\n')])],
  ['invalid UTF8',Buffer.concat([wal,Buffer.from([0xff,0x0a])])],
  ['invalid seal',Buffer.concat([wal,line({...end,checksum:'0'.repeat(64)})])],
  ['wrong predecessor',Buffer.concat([wal,line(record('END',end.data,'0'.repeat(64)))])],
  ['wrong ledgerId',Buffer.concat([wal,line(end),line(wrongBegin)])],
  ['impossible generation',Buffer.concat([wal,line(record('INTENT',{...intent,nextGeneration:intent.nextGeneration+1}))])],
  ['unresolved transaction',Buffer.concat([wal,line(intentRecord)]),canonical,true],
  ['foreign WAL',await readFile(foreign.f.paths.ledger+'.wal')],
  ['stale WAL/newer snapshot',wal,line(envelope(c.f.paths.ledger,intent.next))],
  ['rollback before READY',line(state.records[0]),canonical,'historical'],
  ['valid structural fork with same Ledger identity',Buffer.concat(forkRecords.map(line)),canonical,'fork'],
  ['snapshot rollback after completed transaction',completed],
  ['foreign repository envelope',wal,line(envelope(foreign.f.paths.ledger,state.current))],
  ['unrecognized Ledger stage',wal,canonical,false,c.f.paths.ledger+'.foreign.stage'],
 ];
 for(const [name,badWal,badSnapshot=canonical,recoverable=false,stage] of cases)await t.test(name,async()=>{
  try{
   await writeFile(walPath,badWal);await writeFile(c.f.paths.ledger,badSnapshot);
   if(stage)await writeFile(stage,canonical);
   if(recoverable==='fork'){assert.deepEqual((await inspectV2(c.f.paths.ledger)).current,state.current);assert.deepEqual(inspectV2Sync(c.f.paths.ledger).current,state.current);}
   else if(recoverable==='historical'){assert.equal((await inspectV2(c.f.paths.ledger)).owner,null);assert.equal(inspectV2Sync(c.f.paths.ledger).owner,null);}
   else if(recoverable){assert.ok((await inspectV2(c.f.paths.ledger)).pending);assert.ok(inspectV2Sync(c.f.paths.ledger).pending);}
   else{let canonicalError;try{await inspectV2(c.f.paths.ledger);}catch(error){canonicalError=error;}assert.ok(canonicalError);assert.throws(()=>inspectV2Sync(c.f.paths.ledger),error=>error.code===canonicalError.code&&error.constructor===canonicalError.constructor);}
   const rejected=await rejectWithoutMutation(c);
   if(recoverable===true)assert.equal(rejected.code,'EXECUTION_ERA_CURRENT_LEDGER_NOT_OPERATIONAL');
   if(recoverable!=='historical')await assert.rejects(ledgerAuthority(c.workflow,{allowOwner:true}));
   if(recoverable!==true)await assert.rejects(c.workflow.completedStart());
  }finally{await writeFile(walPath,wal);await writeFile(c.f.paths.ledger,canonical);if(stage)await (await import('node:fs/promises')).unlink(stage);}
 });
})));
test('valid later generation extends READY and current inspection accepts complete transaction',t=>readyFixture(t,async c=>{
 const state=await inspectV2(c.f.paths.ledger),ready=await readFile(c.readyPath),store=c.owner.scheduler.store;
 const event={...store.listEvents().find(e=>e.type==='source.live'),id:'era12-real-transaction',startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};
 for(const key of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete event[key];
 assert.equal((await store.insert(event,store.state.revision)).ok,true);
 assert.equal((await c.owner.ledger.consume(identityForScheduledEvent(store.getEvent(event.id)),{authorityEpoch:c.authority.authorityEpoch,authorityProcessSession:c.authority.authorityProcessSession,consumedAt:'2030-01-01T12:00:00.000Z'})).status,'CONSUMED');
  const current=await inspectV2(c.f.paths.ledger);assert.deepEqual(inspectV2Sync(c.f.paths.ledger),current);assert.equal(current.current.generation,state.current.generation+1);
  assert.notEqual(hash(current.current),unsealEra(JSON.parse(ready)).snapshotHash);assert.deepEqual(await readFile(c.readyPath),ready);
  const before=await protectedBytes(c.f,c.readyPath),grant=await issueEraEntry(c.era,'era12-later-generation',c.options);
  assert.equal(eraAdmits(c.era,{identitySchema:2,eventId:'era12-later-generation',...grant},{requirePublished:false}),true);
  assert.deepEqual(await protectedBytes(c.f,c.readyPath),before);await c.workflow.completedStart();assert.equal((await ledgerAuthority(c.workflow,{allowOwner:true})).snapshot.generation,1);
}));
test('stale inspection invalidated at authorization and before open; existing grant admission remains historical',t=>readyFixture(t,async c=>{
 const grant=await issueEraEntry(c.era,'era12-existing',c.options),walPath=c.f.paths.ledger+'.wal',wal=await readFile(walPath),state=await inspectV2(c.f.paths.ledger);
 const bad=line(seal({schemaVersion:2,type:'UNSUPPORTED',previous:state.records.at(-1).checksum,data:{}}));
 for(const boundary of ['grant/authorized','grant/before-open'])await t.test(boundary,async()=>{
  const names=await grantNames(c.era);
  try{
   await assert.rejects(issueEraEntry(c.era,'era12-race',{...c.options,hook:async point=>{if(point===boundary)await writeFile(walPath,Buffer.concat([wal,bad]));}}),{code:'LEDGER_V2_RECORD_UNSUPPORTED'});
   assert.deepEqual(await grantNames(c.era),names);assert.equal(eraAdmits(c.era,{identitySchema:2,eventId:'era12-existing',...grant},{requirePublished:false}),true);
  }finally{await writeFile(walPath,wal);}
 });
}));
test('terminal END is structurally valid but rejects new issuance under still live READY authority',t=>readyFixture(t,async c=>{
 await c.owner.ledger.finalize();const terminal=await inspectV2(c.f.paths.ledger);assert.equal(terminal.owner,null);assert.equal(terminal.records.at(-1).type,'END');
 assert.deepEqual(inspectV2Sync(c.f.paths.ledger),terminal);assert.doesNotThrow(()=>assertEraAuthority(c.era,c.authority,{ready:true}));await c.workflow.completedStart();assert.equal((await ledgerAuthority(c.workflow)).mode,'V2');
 const error=await rejectWithoutMutation(c,'era12-terminal');assert.equal(error.code,'EXECUTION_ERA_CURRENT_LEDGER_NOT_OPERATIONAL');
}));

test('legitimate consumption around issuance advances generation; successor READY grants without replay',async t=>{
 const f=await eraFixture(t);await f.writer.transition(f.authorization);let workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
 let now=Date.parse('2030-01-01T11:50:00Z'),runtime=componentLaunch(f,{clock:()=>now});
 try{
  const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const store=owner.scheduler.store,era=executionEraStartup(f.paths.ledger),authority=owner.executionOwnership;
  const old=store.listEvents().find(e=>e.type==='source.live'),event={...old,id:'era12-future',name:'TEMP future',startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};
  for(const key of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete event[key];
  const inserted=await store.insert(event,store.getSnapshot().revision);assert.equal(inserted.ok,true,JSON.stringify(inserted));
  const readyPath=join(era.directory,'start-'+authority.authorityProcessSession+'.json.ready'),ready=await readFile(readyPath),counter={captures:0};
  const grant=await issueEraEntry(era,'era12-around-consumption',{authority,durability:f.writer.durability,hook:async point=>{
   if(point==='grant/authorized')await grantFutureRuntime({app:owner,event,clock:()=>now,setNow:value=>now=value,counter});
  }});
  assert.equal(counter.captures,1);assert.equal((await inspectV2(f.paths.ledger)).current.generation,1);
  assert.deepEqual(await readFile(readyPath),ready);assert.equal(eraAdmits(era,{identitySchema:2,eventId:'era12-around-consumption',...grant},{requirePublished:false}),true);
  await runtime.close();workflow=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:(await workflow.recoveryReview()).hash,principal:'TEMP-era12-restart'});
  runtime=componentLaunch(f,{clock:()=>now});const restarted=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const successor=await issueEraEntry(executionEraStartup(f.paths.ledger),'era12-successor',{authority:restarted.owner.executionOwnership,durability:f.writer.durability});
  assert.ok(successor.incarnationId);await grantFutureRuntime({app:restarted.owner,event,clock:()=>now,setNow:value=>now=value,counter,replay:true});
  assert.equal(counter.captures,1);assert.equal((await inspectV2(f.paths.ledger)).current.generation,1);
 }finally{await runtime.close();}
});
test('current Ledger owner and lock must match live READY authority',t=>readyFixture(t,async c=>{
 const lockPath=c.f.paths.ledgerLock,bytes=await readFile(lockPath),lock=JSON.parse(bytes);
 try{await writeFile(lockPath,JSON.stringify({...lock,processSession:randomUUID()}));const error=await rejectWithoutMutation(c);assert.equal(error.code,'EXECUTION_ERA_CURRENT_LEDGER_NOT_OPERATIONAL');}
 finally{await writeFile(lockPath,bytes);}
}));

test('invalidated tail after staging prevents durable grant installation and retains recovery evidence',t=>readyFixture(t,async c=>{
 const walPath=c.f.paths.ledger+'.wal',wal=await readFile(walPath),state=await inspectV2(c.f.paths.ledger);
 const protectedBefore=await protectedBytes(c.f,c.readyPath);
 try{
  await assert.rejects(issueEraEntry(c.era,'era12-install-fence',{...c.options,hook:async point=>{
   if(point==='grant/before-install')await writeFile(walPath,Buffer.concat([wal,line(seal({schemaVersion:2,type:'UNSUPPORTED',previous:state.records.at(-1).checksum,data:{}}))]));
  }}),{code:'LEDGER_V2_RECORD_UNSUPPORTED'});
  const names=await grantNames(c.era);assert.equal(names.length,1);assert.ok(names[0].endsWith('.json.stage'));
  assert.equal((await protectedBytes(c.f,c.readyPath))[c.f.paths.schedule],protectedBefore[c.f.paths.schedule]);
  const staged=JSON.parse(await readFile(join(c.era.directory,names[0])));
  assert.equal(eraAdmits(c.era,{identitySchema:2,eventId:staged.eventId,executionEraId:staged.executionEraId,incarnationId:staged.incarnationId,entryGrantHash:hash(await readFile(join(c.era.directory,names[0])))}),false);
 }finally{await writeFile(walPath,wal);}
 const retry=await issueEraEntry(c.era,'era12-install-fence',c.options);assert.equal((await grantNames(c.era)).length,1);assert.ok(retry.incarnationId);
 const after=await protectedBytes(c.f,c.readyPath);assert.deepEqual(after,protectedBefore);
}));
