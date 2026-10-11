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
import {executionEraStartup,eraAdmits,issueEraEntry} from '../server/recovery/ExecutionEraContract.js';
import {identityForScheduledEvent,ENTRY_METADATA,ERA_ENTRY_METADATA} from '../server/scheduler/ScheduledEventIdentity.js';
import {inspectV2,hash} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {grantFutureRuntime} from '../test-support/EraGrantFutureRuntime.js';
import {assertNativeTestTarget} from '../test-support/NativeTempGuard.mjs';
const native=process.env.LIVEZONE_GRANT_NATIVE==='1';
const evidence=process.env.LIVEZONE_GRANT_EVIDENCE_DIRECTORY;
const selected=process.env.LIVEZONE_GRANT_BOUNDARIES?JSON.parse(process.env.LIVEZONE_GRANT_BOUNDARIES):grantBoundaries;
for(const boundary of selected)test('grant abrupt loss and canonical retry: '+boundary,async t=>{
 const f=await eraFixture(t,{native});for(const path of Object.values(f.paths))assertNativeTestTarget(path);await f.writer.transition(f.authorization);
 const schedule=JSON.parse(await readFile(f.paths.schedule));
 const event={...schedule.events.find(e=>e.type==='source.live'),id:'era09-new-future',startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:03:00.000Z'};
 for(const key of [...ENTRY_METADATA,...ERA_ENTRY_METADATA])delete event[key];
 const observation=join(f.root,'grant-observation.json'),input=join(f.root,'grant-input.json');
 await writeFile(input,JSON.stringify({root:f.root,paths:f.paths,authorization:f.authorization,native,boundary,event,observation}));
 const child=await new Promise((ok,no)=>{const env={...process.env,LIVEZONE_NATIVE_TEST_ROOTS:JSON.stringify([f.root])};delete env.NODE_TEST_CONTEXT;
  const p=spawn(process.execPath,['test-support/era-grant-abrupt-child.mjs',input],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',no);p.once('close',code=>ok({code,pid:p.pid,stdout,stderr}));});
 assert.equal(child.code,73,child.stderr);assert.ok(child.stdout.includes('"abrupt":true'));
 const era=executionEraStartup(f.paths.ledger),files=[];
 for(const name of await readdir(era.directory))if(name.startsWith('grant-')){const bytes=await readFile(join(era.directory,name));files.push({name,size:bytes.length,sha256:hash(bytes)});}
 const durable=files.filter(v=>v.name.endsWith('.json'));
 const sourceHashes=Object.fromEntries(await Promise.all(['server/recovery/ExecutionEraContract.js','server/scheduler/ScheduledEntryLedgerV2Repository.js','server/scheduler/ScheduleStore.js','server/scheduler/ScheduledEntryLedgerV2Protocol.js','server/recovery/PersistentEvidence.js','server/recovery/RecoveryNamespace.js'].map(async path=>[path,hash(await readFile(path))])));
 const result={boundary,native,tempVerified:true,sourceHashes,child,classification:durable.length?'GRANT_DURABLE':'NO_GRANT_DURABLE',durableArtifacts:files,status:'FAIL'};
 let runtime;
 try{
  const observed=JSON.parse(await readFile(observation));
  f.writer.host.proveOffline=async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]});
  let workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
  const completed=await workflow.completedStart();assert.deepEqual(completed,observed.ready);
  const review=await workflow.recoveryReview();await workflow.recoverStart({authorizeRecovery:true,authorizeCompletedOwnerRecovery:true,expectedReviewHash:review.hash});
  workflow=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:(await workflow.recoveryReview()).hash,principal:'TEMP-grant-restart'});
  let now=Date.parse('2030-01-01T11:50:00.000Z');
  runtime=componentLaunch(f,{native,clock:()=>now});const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
  Object.assign(result,{transitionId:era.transitionId,retirementHash:era.retirementHash,authorityEpoch:owner.executionOwnership.authorityEpoch,
   successorId:owner.executionOwnership.controlledStartBinding.successorId});
  assert.equal(owner.executionOwnership.executionEraId,era.executionEraId);
  assert.equal((await inspectV2(f.paths.ledger)).current.entries.length,0,'grant must not consume Ledger');
  const conditional=boundary==='grant/before-stage-cleanup'||boundary==='grant/stage-cleaned';
  let metadata;
  if(conditional)metadata=await issueEraEntry(era,event.id,{authority:owner.executionOwnership,durability:f.writer.durability});
  else{
   let saved=owner.scheduler.store.getEvent(event.id);
   if(!saved){const retry=await owner.scheduler.store.insert(event,owner.scheduler.store.getSnapshot().revision);assert.equal(retry.ok,true,retry.code);saved=owner.scheduler.store.getEvent(event.id);}
   assert.equal(eraAdmits(era,identityForScheduledEvent(saved)),true);metadata=saved;
   const duplicate=await owner.scheduler.store.insert(event,owner.scheduler.store.getSnapshot().revision);assert.equal(duplicate.ok,true);assert.equal(duplicate.alreadyPublished,true);
  }
  const final=(await readdir(era.directory)).filter(n=>/^grant-.*\.json$/.test(n));assert.equal(final.length,1);
  assert.equal(final[0],'grant-'+metadata.incarnationId+'.json');
  if(durable.length)assert.equal(final[0],durable[0].name);
  assert.equal(await readFile(f.paths.program,'utf8'),observed.program);assert.equal(await readFile(f.paths.autoLive,'utf8'),observed.auto);
  if(['grant/partial-written','grant/durable','grant-schedule/installed'].includes(boundary)){
   const counter={captures:0};await grantFutureRuntime({app:owner,event,clock:()=>now,setNow:value=>now=value,counter});
   await runtime.close();workflow=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:(await workflow.recoveryReview()).hash,principal:'TEMP-grant-after-END'});
   runtime=componentLaunch(f,{native,clock:()=>now});const restarted=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
   await grantFutureRuntime({app:restarted.owner,event,clock:()=>now,setNow:value=>now=value,counter,replay:true});
   assert.equal((await readdir(era.directory)).filter(n=>/^grant-.*\.json$/.test(n)).length,1);
   assert.equal(await readFile(f.paths.autoLive,'utf8'),observed.auto);result.futureLive={consumeBeforeCapture:true,captures:counter.captures,END:true,restartNoReplay:true};
  }
  result.finalIncarnationId=metadata.incarnationId;result.executionEraId=era.executionEraId;result.ledgerId=era.ledgerId;result.status='PASS';
 }finally{await runtime?.close();if(evidence)await writeFile(join(evidence,'grant-'+grantBoundaries.indexOf(boundary)+'.json'),JSON.stringify(result,null,2)+'\n');}
});
