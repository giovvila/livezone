import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {grantBoundaries} from '../test-support/EraGrantBoundaries.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {executionEraStartup,eraAdmits} from '../server/recovery/ExecutionEraContract.js';
import {identityForScheduledEvent,ENTRY_METADATA,ERA_ENTRY_METADATA} from '../server/scheduler/ScheduledEventIdentity.js';
import {inspectV2,hash} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {grantFutureRuntime} from '../test-support/EraGrantFutureRuntime.js';
import {assertNativeTestTarget} from '../test-support/NativeTempGuard.mjs';
const native=process.env.LIVEZONE_GRANT_NATIVE==='1',evidence=process.env.LIVEZONE_GRANT_EVIDENCE_DIRECTORY;
const selected=process.env.LIVEZONE_GRANT_BOUNDARIES?JSON.parse(process.env.LIVEZONE_GRANT_BOUNDARIES):grantBoundaries.filter(b=>b.startsWith('grant-schedule/'));
for(const boundary of selected)test('LIVE identity revision abrupt loss and canonical retry: '+boundary,async t=>{
 const f=await eraFixture(t,{native});for(const path of Object.values(f.paths))assertNativeTestTarget(path);await f.writer.transition(f.authorization);
 const event={...JSON.parse(await readFile(f.paths.schedule)).events.find(e=>e.type==='source.live'),id:'era15-abrupt-revision',startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};
 for(const k of [...ENTRY_METADATA,...ERA_ENTRY_METADATA])delete event[k];
 const patch={startAt:'2030-01-01T12:01:00.000Z'},observation=join(f.root,'identity-observation.json'),input=join(f.root,'identity-input.json');
 await writeFile(input,JSON.stringify({root:f.root,paths:f.paths,authorization:f.authorization,native,boundary,event,patch,observation}));
 const child=await new Promise((ok,no)=>{const env={...process.env,LIVEZONE_NATIVE_TEST_ROOTS:JSON.stringify([f.root])};delete env.NODE_TEST_CONTEXT;const p=spawn(process.execPath,['test-support/era-live-identity-abrupt-child.mjs',input],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',no);p.once('close',code=>ok({code,pid:p.pid,stdout,stderr}));});
 assert.equal(child.code,73,child.stderr);assert.ok(child.stdout.includes('"operation":"LIVE_IDENTITY_REVISION"'));
 const era=executionEraStartup(f.paths.ledger),observed=JSON.parse(await readFile(observation));
 const grantPath=join(era.directory,'grant-'+observed.event.incarnationId+'.json'),grantBytes=await readFile(grantPath);
 const sourceHashes=Object.fromEntries(await Promise.all(['server/recovery/ExecutionEraContract.js','server/scheduler/ScheduledEventIdentity.js','server/scheduler/ScheduledEntryLedgerV2Repository.js','server/scheduler/ScheduleStore.js','server/scheduler/ScheduledEntryLedgerV2Protocol.js','server/recovery/PersistentEvidence.js','server/recovery/RecoveryNamespace.js'].map(async p=>[p,hash(await readFile(p))])));
 const result={boundary,operation:'LIVE_IDENTITY_REVISION',native,tempVerified:true,sourceHashes,child,status:'FAIL'};let runtime;
 try{
  const installed=JSON.parse(await readFile(f.paths.schedule)).events.find(e=>e.id===event.id);result.classification=installed.entryRevision===1?'OLD_IDENTITY_DURABLE':'REVISED_IDENTITY_DURABLE';assert.ok([1,2].includes(installed.entryRevision));
  f.writer.host.proveOffline=async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]});let workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
  await workflow.recoverStart({authorizeRecovery:true,authorizeCompletedOwnerRecovery:true,expectedReviewHash:(await workflow.recoveryReview()).hash});
  workflow=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:(await workflow.recoveryReview()).hash,principal:'TEMP-era15-crash'});
  let now=Date.parse('2030-01-01T11:50:00.000Z');runtime=componentLaunch(f,{native,clock:()=>now});const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000}),store=owner.scheduler.store;
  Object.assign(result,{transitionId:era.transitionId,executionEraId:era.executionEraId,ledgerId:era.ledgerId,retirementHash:era.retirementHash,
   authorityEpoch:owner.executionOwnership.authorityEpoch,successorId:owner.executionOwnership.controlledStartBinding.successorId});
  if(store.getEvent(event.id).entryRevision===1)assert.equal((await store.update(event.id,patch,store.state.revision)).ok,true);
  const revised=store.getEvent(event.id);assert.equal(revised.entryRevision,2);assert.equal(revised.incarnationId,observed.event.incarnationId);assert.equal(revised.startAt,patch.startAt);
  assert.equal(eraAdmits(era,identityForScheduledEvent(observed.event)),false);assert.equal(eraAdmits(era,identityForScheduledEvent(revised)),true);
  assert.deepEqual(await readFile(grantPath),grantBytes);assert.equal((await readdir(era.directory)).filter(n=>/^grant-.*\.json$/.test(n)).length,1);
  assert.equal((await inspectV2(f.paths.ledger)).current.entries.length,0);assert.equal(await readFile(f.paths.program,'utf8'),observed.program);assert.equal(await readFile(f.paths.autoLive,'utf8'),observed.auto);
  if(boundary==='grant-schedule/installed'){
   const counter={captures:0};await grantFutureRuntime({app:owner,event:revised,clock:()=>now,setNow:v=>now=v,counter});await runtime.close();assert.equal((await inspectV2(f.paths.ledger)).records.at(-1).type,'END');
   workflow=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:(await workflow.recoveryReview()).hash,principal:'TEMP-era15-crash-END'});runtime=componentLaunch(f,{native,clock:()=>now});const restarted=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
   await grantFutureRuntime({app:restarted.owner,event:revised,clock:()=>now,setNow:v=>now=v,counter,replay:true});result.futureLive={consumeBeforeCapture:true,captures:counter.captures,END:true,restartNoReplay:true};
  }
  result.sameGrantBytes=true;result.entryRevision=2;result.staleIdentityAdmitted=false;result.status='PASS';
 }finally{await runtime?.close();if(evidence)await writeFile(join(evidence,'identity-'+grantBoundaries.indexOf(boundary)+'.json'),JSON.stringify(result,null,2)+'\n');}
});
