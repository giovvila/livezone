import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {assertNativeTestTarget} from '../test-support/NativeTempGuard.mjs';

test('pinned native abrupt owner loss reconciles and enters ControlledStart READY with one successor',
    {skip:process.platform!=='win32'},async t=>{
    const f=await eraFixture(t,{native:true}),program=await readFile(f.paths.program),auto=await readFile(f.paths.autoLive);
    for(const path of Object.values(f.paths))assertNativeTestTarget(path);
    const input=join(f.root,'crash-input.json');
    await writeFile(input,JSON.stringify({root:f.root,paths:f.paths,authorization:f.authorization,native:true,
        operation:'start',transitionFirst:true,boundary:'authority/owner-lock-durable'}));
    const env={...process.env,LIVEZONE_NATIVE_TEST_ROOTS:JSON.stringify([f.root])};delete env.NODE_TEST_CONTEXT;
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../test-support/new-era-abrupt-child.mjs',import.meta.url)),input],
        {env,encoding:'utf8',timeout:300000,windowsHide:true});
    assert.equal(child.status,73,child.stderr);assert.ok(child.stdout.includes('"abrupt":true'));
    const writer=new f.writer.constructor({...f.options,host:{...f.options.host,proveOffline:async()=>({absent:true,
        services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]})}});
    const workflow=new NewEraRecoveryWorkflow({writer,authorization:f.authorization});
    const intent=(await workflow.journal()).records[0],review=await workflow.recoveryReview();
    await workflow.recoverStart({authorizeRecovery:true,expectedReviewHash:review.hash});
    const runtime=componentLaunch(f,{native:true});
    try{
        const {owner,result}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
        assert.equal(result.ready,true);assert.equal(result.successorId,intent.body.successorId);assert.equal(result.epoch,23);
        assert.equal(owner.executionOwnership.authorityProcessSession,intent.body.authorityProcessSession);
        assert.deepEqual(await readFile(f.paths.program),program);assert.deepEqual(await readFile(f.paths.autoLive),auto);
    }finally{await runtime.close();}
});
