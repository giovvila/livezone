import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';

for(const boundary of ['READY/durable','controlled-start/ready-durable'])test('completed START stays read-only; explicit dead-owner recovery permits a new authorized START: '+boundary,async t=>{
    try{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);
    const input=join(f.root,'completed-crash.json');
    await writeFile(input,JSON.stringify({root:f.root,paths:f.paths,authorization:f.authorization,native:false,operation:'start',boundary}));
    const env={...process.env,LIVEZONE_NATIVE_TEST_ROOTS:JSON.stringify([f.root])};delete env.NODE_TEST_CONTEXT;
    const child=await new Promise((ok,no)=>{
        const processChild=spawn(process.execPath,[fileURLToPath(new URL('../test-support/new-era-abrupt-child.mjs',import.meta.url)),input],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';processChild.stdout.on('data',b=>stdout+=b);processChild.stderr.on('data',b=>stderr+=b);
        processChild.once('error',no);processChild.once('close',status=>ok({status,stdout,stderr}));
    });
    assert.equal(child.status,73,child.stderr);assert.ok(child.stdout.includes('"abrupt":true'));
    f.writer.host.proveOffline=async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]});
    const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
    const initial=await workflow.recoveryReview(),completed=await controlledStart({workflow,authorizeStart:true,launch:()=>{throw Error('SECOND_LAUNCH');}});
    assert.equal(completed.owner,null);assert.equal(completed.result.epoch,23);
    assert.equal((await workflow.recoveryReview()).hash,initial.hash);
    assert.equal((await workflow.recoverStart({authorizeRecovery:true,expectedReviewHash:initial.hash})).state,'ALREADY_COMPLETED');
    assert.equal((await workflow.recoveryReview()).hash,initial.hash);
    const chain=await workflow.journal(),start=chain.records.find(r=>r.body.state==='START_RESERVED');
    const anchorPath=join(f.writer.directory,'start-'+start.body.authorityProcessSession+'.json.ready'),anchor=await readFile(anchorPath);
    await workflow.recoverStart({authorizeRecovery:true,authorizeCompletedOwnerRecovery:true,expectedReviewHash:initial.hash});
    assert.deepEqual(await readFile(anchorPath),anchor);
    assert.equal((await workflow.completedStart()).result.epoch,23);
    const review=await workflow.recoveryReview(),next=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:review.hash,principal:'TEMP-next-start'});
    const reservation=await next.reserveStart({authorizeStart:true});assert.equal(reservation.authorityEpoch,24);
    assert.deepEqual(await next.reserveStart({authorizeStart:true}),reservation);
    const runtime=componentLaunch(f);
    try{
        const result=await controlledStart({workflow:next,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
        assert.equal(result.result.epoch,24);assert.equal(result.result.ready,true);
        assert.equal((await next.journal()).records.filter(r=>r.body.state==='AUTHORITY_SUCCESSOR').length,1);
        assert.deepEqual(await readFile(anchorPath),anchor);
    }finally{await runtime.close();}
    }catch(error){process.stderr.write(error.stack+'\n');throw error;}
});
