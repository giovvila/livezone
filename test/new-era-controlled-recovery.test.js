import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {eraRecordBytes} from '../server/recovery/ExecutionEraContract.js';
import {seal,hash} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

for(const boundary of ['controlled-start/launch-reserved','authority/owner-lock-durable','runtime/ownership','READY/before-install'])test('real process loss resumes same canonical successor: '+boundary,async t=>{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);
    const input=join(f.root,'crash-input.json');
    await writeFile(input,JSON.stringify({root:f.root,paths:f.paths,authorization:f.authorization,native:false,operation:'start',boundary}));
    const env={...process.env,LIVEZONE_NATIVE_TEST_ROOTS:JSON.stringify([f.root])};delete env.NODE_TEST_CONTEXT;
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../test-support/new-era-abrupt-child.mjs',import.meta.url)),input],{env,encoding:'utf8',timeout:300000,windowsHide:true});
    assert.equal(child.status,73,child.stderr);assert.ok(child.stdout.includes('"abrupt":true'));
    const proof=async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]});
    const writer=new (f.writer.constructor)({...f.options,host:{...f.options.host,proveOffline:proof}});
    const workflow=new NewEraRecoveryWorkflow({writer,authorization:f.authorization}),before=await workflow.journal();
    const intent=before.records.find(r=>r.body.state==='AUTHORITY_INTENT');
    const review=await workflow.recoveryReview();await workflow.recoverStart({authorizeRecovery:true,expectedReviewHash:review.hash});
    const runtime=componentLaunch(f);
    try{
        const result=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
        assert.equal(result.result.ready,true);assert.equal(result.result.successorId,intent.body.successorId);
        assert.equal(result.result.epoch,23);assert.equal(result.result.executionEraId,f.authorization.executionEraId);
        assert.equal(result.result.ledgerId,f.authorization.ledgerId);
        assert.equal((await workflow.journal()).records.filter(r=>r.body.state==='AUTHORITY_SUCCESSOR').length,1);
    }finally{await runtime.close();}
});

test('canonical authority reservation retains one successor, epoch and Start identity across retries',async t=>{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);
    const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
    const first=await workflow.reserveStart({authorizeStart:true}),before=await workflow.journal();
    const again=await workflow.reserveStart({authorizeStart:true});assert.deepEqual(again,first);
    assert.equal(JSON.parse(await readFile(f.paths.authority)).epoch,23);
    assert.equal((await workflow.journal()).records.length,before.records.length);
    assert.equal(before.records.filter(r=>r.body.state==='AUTHORITY_SUCCESSOR').length,1);
});

test('production ControlledStart reaches era-bound READY, retains PROGRAM and AutoLive, then retries read-only',async t=>{
    const f=await eraFixture(t),program=await readFile(f.paths.program),auto=await readFile(f.paths.autoLive);
    await f.writer.transition(f.authorization);
    const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
    const runtime=componentLaunch(f);
    try{
        const result=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
        assert.equal(result.result.ready,true);assert.equal(result.result.executionEraId,f.authorization.executionEraId);
        assert.equal(result.owner.executionOwnership.authorityEpoch,23);
        assert.deepEqual(await readFile(f.paths.program),program);assert.deepEqual(await readFile(f.paths.autoLive),auto);
        const bytes=await workflow.recoveryReview();
        const retry=await controlledStart({workflow,authorizeStart:true,launch:()=>{throw Error('DUPLICATE_LAUNCH');}});
        assert.equal(retry.owner,null);assert.equal((await workflow.recoveryReview()).hash,bytes.hash);
    }finally{await runtime.close();}
});

test('durable launch uncertainty refuses an automatic second launch and refuses a living owner',async t=>{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);
    const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
    await workflow.reserveStart({authorizeStart:true});await workflow.beforeLaunch();
    await assert.rejects(workflow.reserveStart({authorizeStart:true}),{code:'NEW_ERA_LAUNCH_OUTCOME_REVIEW_REQUIRED'});
    const review=await workflow.recoveryReview();
    await assert.rejects(workflow.recoverStart({authorizeRecovery:true,expectedReviewHash:review.hash}),{code:'NEW_ERA_OWNER_ALIVE_OR_AMBIGUOUS'});
});

test('missing READY reconciliation authorization refuses before successor allocation or launch',async t=>{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);
    const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
    await assert.rejects(controlledStart({workflow,authorizeStart:true,launch:()=>{throw Error('UNAUTHORIZED_LAUNCH');}}),
        {code:'EXPLICIT_RESTART_RECONCILIATION_REQUIRED'});
    assert.equal(JSON.parse(await readFile(f.paths.authority)).epoch,22);
    assert.equal((await workflow.journal()).records.length,0);
    const h=await f.writer.host.inspect();h.ports=[{LocalPort:8080,OwningProcess:process.pid}];
    workflow.assertOfflineHost(h,{reserved:true});
    assert.throws(()=>workflow.assertOfflineHost(h),{code:'CANONICAL_OFFLINE_PROOF_REQUIRED'});
    h.ports[0].OwningProcess++;
    assert.throws(()=>workflow.assertOfflineHost(h,{reserved:true}),{code:'MIGRATION_RESERVATION_PORT_CONFLICT'});
});

for(const field of ['successorId','authorityEpoch','authorityProcessSession','predecessorAuthorityHash'])test('resealed foreign authority intent fails closed: '+field,async t=>{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);
    const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});await workflow.reserveStart({authorizeStart:true});
    const chain=await workflow.journal(),intent=chain.records[0];
    await writeFile(intent.path,eraRecordBytes(seal({...intent.body,[field]:field==='authorityEpoch'?24:'foreign'})));
    await assert.rejects(workflow.journal(),{code:'NEW_ERA_AUTHORITY_PROVENANCE'});
});
