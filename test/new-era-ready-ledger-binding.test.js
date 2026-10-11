import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {executionEraStartup,issueEraEntry,eraAdmits,eraRecordBytes,unsealEra,assertEraAuthority} from '../server/recovery/ExecutionEraContract.js';
import {hash,seal,envelope,inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {ledgerSnapshot} from '../server/scheduler/ScheduledEntryLedgerContract.js';
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
test('foreign sealed READY ledgerId rejects issuance before grant mutation',t=>readyFixture(t,async c=>{
 const bytes=await readFile(c.readyPath),body=unsealEra(JSON.parse(bytes));
 assert.equal(body.ledgerId,c.era.ledgerId);assert.equal((await inspectV2(c.f.paths.ledger)).current.ledgerId,c.era.ledgerId);
 try{await writeFile(c.readyPath,eraRecordBytes(seal({...body,ledgerId:randomUUID()})));await rejectWithoutMutation(c);}
 finally{await writeFile(c.readyPath,bytes);}
}));

test('READY Ledger mismatch matrix and cross-bindings reject before dependent mutation',t=>readyFixture(t,async c=>readyFixture(t,async foreign=>{
 const readyBytes=await readFile(c.readyPath),body=unsealEra(JSON.parse(readyBytes));
 const foreignReady=unsealEra(JSON.parse(await readFile(foreign.readyPath))),foreignLedger=(await inspectV2(foreign.f.paths.ledger)).current;
 const readyCases=[
  ['B Ledger ID from another valid TEMP era',{ledgerId:foreignReady.ledgerId}],
  ['D correct READY executionEraId with foreign Ledger binding',{ledgerId:randomUUID()}],
  ['E correct Ledger ID with foreign READY executionEraId',{executionEraId:foreign.era.executionEraId}],
  ['foreign transition',{transitionId:foreign.era.transitionId}],
  ['foreign authority epoch',{authorityEpoch:body.authorityEpoch+1}],
  ['foreign authority session',{authorityProcessSession:foreign.authority.authorityProcessSession}],
  ['foreign authority owner predecessor',{ownerHash:hash('foreign owner')}],
  ['stale Start reservation',{startReservationHash:hash('stale reservation')}],
  ['foreign ControlledStart claim',{recoveryClaimHash:hash('foreign claim')}],
  ['foreign runtime-owned predecessor',{runtimeOwnedHash:hash('foreign runtime')}],
  ['stale READY RecoveryLineage predecessor',{recoveryLineage:{...body.recoveryLineage,predecessorHash:hash('stale predecessor')}}],
  ['owner anchor cannot substitute for READY',{phase:'NEW_AUTHORITY_READY'}],
  ['foreign READY version',{version:2}],
 ];
 for(const [name,patch] of readyCases)await t.test(name,async()=>{
  try{await writeFile(c.readyPath,eraRecordBytes(seal({...body,...patch})));await rejectWithoutMutation(c);await assert.rejects(c.workflow.completedStart());}
  finally{await writeFile(c.readyPath,readyBytes);}
 });
 await t.test('copied completed READY from another valid TEMP era',async()=>{
  try{await writeFile(c.readyPath,await readFile(foreign.readyPath));await rejectWithoutMutation(c);await assert.rejects(c.workflow.completedStart());}
  finally{await writeFile(c.readyPath,readyBytes);}
 });
 const ledgerBytes=await readFile(c.f.paths.ledger),snapshot=(await inspectV2(c.f.paths.ledger)).current;
 for(const [name,value] of [
  ['C active Ledger replaced by valid foreign Ledger while READY remains old',envelope(c.f.paths.ledger,foreignLedger)],
  ['E active Ledger keeps ledgerId but executionEraId changes',envelope(c.f.paths.ledger,ledgerSnapshot({...snapshot,executionEraId:foreign.era.executionEraId}))],
  ['active Ledger retirement binding changed',envelope(c.f.paths.ledger,ledgerSnapshot({...snapshot,retirementHash:hash('foreign retirement')}))],
  ['active Ledger envelope checksum corrupted',{...JSON.parse(ledgerBytes),checksum:'0'.repeat(64)}],
 ])await t.test(name,async()=>{
  try{await writeFile(c.f.paths.ledger,JSON.stringify(value)+'\n');await rejectWithoutMutation(c);await assert.rejects(c.workflow.completedStart());}
  finally{await writeFile(c.f.paths.ledger,ledgerBytes);}
 });
 const scheduleBytes=await readFile(c.f.paths.schedule),schedule=JSON.parse(scheduleBytes);
 await t.test('foreign Schedule era rejects issuance',async()=>{
  try{await writeFile(c.f.paths.schedule,JSON.stringify({...schedule,executionEra:foreign.era.scheduleEra})+'\n');await rejectWithoutMutation(c);}
  finally{await writeFile(c.f.paths.schedule,scheduleBytes);}
 });
 await t.test('stale READY WAL prefix without its authority BEGIN rejects',async()=>{
  const wal=await readFile(c.f.paths.ledger+'.wal','utf8'),prefix=Buffer.from(wal.split('\n')[0]+'\n');
  try{await writeFile(c.readyPath,eraRecordBytes(seal({...body,walBytes:prefix.toString('base64'),walHash:hash(prefix)})));await rejectWithoutMutation(c);}
  finally{await writeFile(c.readyPath,readyBytes);}
 });
 await t.test('F correct READY and active Ledger succeed and direct retries converge',async()=>{
  const before=await protectedBytes(c.f,c.readyPath);const first=await issueEraEntry(c.era,'era11-valid',c.options),grantPath=join(c.era.directory,'grant-'+first.incarnationId+'.json'),bytes=await readFile(grantPath);
  const pair=await Promise.all([issueEraEntry(c.era,'era11-valid',c.options),issueEraEntry(c.era,'era11-valid',c.options)]);
  assert.deepEqual(pair,[first,first]);assert.deepEqual(await readFile(grantPath),bytes);assert.equal((await grantNames(c.era)).length,1);
  assert.equal(eraAdmits(c.era,{identitySchema:2,eventId:'era11-valid',...first},{requirePublished:false}),true);assert.deepEqual(await protectedBytes(c.f,c.readyPath),before);
  assert.equal((await inspectV2(c.f.paths.ledger)).current.entries.length,0);
  const auto=JSON.parse(await readFile(c.f.paths.autoLive));assert.equal(auto.enabled,true);assert.equal(auto.armed,false);assert.equal(auto.sourceId,c.f.view.inventory.find(i=>i.key==='autoLive')&&JSON.parse(Buffer.from(c.f.view.inventory.find(i=>i.key==='autoLive').bytes,'base64')).sourceId);
  const completedBefore=await c.workflow.completedStart();let launches=0;
  const retried=await controlledStart({workflow:c.workflow,authorizeStart:true,launch:()=>{launches++;throw Error('NO_SECOND_LAUNCH');}});
  assert.deepEqual(retried,completedBefore);assert.equal(launches,0);assert.deepEqual(await protectedBytes(c.f,c.readyPath),before);
 });
})));

test('READY Ledger validation preserves pre-READY authority callers',async t=>{
 const f=await eraFixture(t);await f.writer.transition(f.authorization);const runtime=componentLaunch(f);
 const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
 try{
  await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const authority=runtime.owners[0].executionOwnership,era=executionEraStartup(f.paths.ledger);
  const path=join(era.directory,'start-'+authority.authorityProcessSession+'.json.ready'),bytes=await readFile(path);
  try{
   await writeFile(path,eraRecordBytes(seal({...unsealEra(JSON.parse(bytes)),ledgerId:randomUUID()})));
   assert.doesNotThrow(()=>assertEraAuthority(era,authority));assert.throws(()=>assertEraAuthority(era,authority,{ready:true}),{code:'EXECUTION_ERA_READY_LEDGER_CHANGED'});
  }finally{await writeFile(path,bytes);}
 }finally{await runtime.close();}
});

test('invalid READY rejects retry of an existing durable valid grant without rewriting it',t=>readyFixture(t,async c=>{
 const first=await issueEraEntry(c.era,'era11-pending-valid',c.options),readyBytes=await readFile(c.readyPath);
 try{await writeFile(c.readyPath,eraRecordBytes(seal({...unsealEra(JSON.parse(readyBytes)),ledgerId:randomUUID()})));await rejectWithoutMutation(c,'era11-pending-valid');}
 finally{await writeFile(c.readyPath,readyBytes);}
 assert.deepEqual(await issueEraEntry(c.era,'era11-pending-valid',c.options),first);assert.equal((await grantNames(c.era)).length,1);
 assert.equal(eraAdmits(c.era,{identitySchema:2,eventId:'era11-pending-valid',...first},{requirePublished:false}),true);
}));
test('authority revalidation catches a READY Ledger mismatch before grant open',t=>readyFixture(t,async c=>{
 const readyBytes=await readFile(c.readyPath),body=unsealEra(JSON.parse(readyBytes)),before=await protectedBytes(c.f,c.readyPath),points=[];
 try{
  await assert.rejects(issueEraEntry(c.era,'era11-fence',{...c.options,hook:async point=>{
   points.push(point);if(point==='grant/authorized')await writeFile(c.readyPath,eraRecordBytes(seal({...body,ledgerId:randomUUID()})));
  }}),{code:'EXECUTION_ERA_READY_LEDGER_CHANGED'});
  assert.deepEqual(points,['grant/authorized']);assert.deepEqual(await grantNames(c.era),[]);
 }finally{await writeFile(c.readyPath,readyBytes);}
 assert.deepEqual(await protectedBytes(c.f,c.readyPath),before);
}));
