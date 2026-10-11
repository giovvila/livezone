import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {eraFixture} from './NewExecutionEraFixture.js';
import {assertNativeTestTarget} from './NativeTempGuard.mjs';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {componentLaunch} from './NewEraControlledRuntime.js';
import {hash,inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {executionEraStartup,eraAdmits} from '../server/recovery/ExecutionEraContract.js';
import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';

const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const productionSourceHashes=Object.fromEntries(await Promise.all(['../server/recovery/NewEraRecoveryWorkflow.js','../server/recovery/ControlledStart.js',
    '../server/recovery/RecoveryLineage.js','../server/recovery/ExecutionEraContract.js','../server/recovery/RestoreLedgerAuthority.js',
    '../server/autolive/BrowserExecutionOwnership.js','../server/autolive/AuthorityMaintenanceGate.js',
    '../server/scheduler/ReconcileScheduledEntryLedgerV2.js','../server/scheduler/ReconcileScheduledExecutionLock.js',
    '../server/scheduler/ScheduledLiveExecutionRepository.js'].map(async path=>[path,hash(await readFile(new URL(path,import.meta.url)))])));
async function snapshot(root,path=root){
    const values=[];
    for(const name of await readdir(path)){
        const full=join(path,name),stat=await lstat(full);assert.equal(stat.isSymbolicLink(),false);
        if(stat.isDirectory())values.push(...await snapshot(root,full));
        else values.push({path:relative(root,full),size:stat.size,sha256:hash(await readFile(full))});
    }
    return values.sort((a,b)=>a.path.localeCompare(b.path));
}
async function crash(f,operation,boundary,startAuthorization){
    const input=join(f.root,'crash-'+operation+'.json');
    await writeFile(input,JSON.stringify({root:f.root,paths:f.paths,authorization:f.authorization,startAuthorization,native:config.native,operation,boundary}));
    const env={...process.env,LIVEZONE_NATIVE_TEST_ROOTS:JSON.stringify([f.root])};delete env.NODE_TEST_CONTEXT;
    const result=await new Promise((ok,no)=>{
        const child=spawn(process.execPath,[fileURLToPath(new URL('./new-era-abrupt-child.mjs',import.meta.url)),input],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
        const timer=setTimeout(()=>{child.kill();no(Error('CONTROLLED_MATRIX_TIMEOUT'));},600000);
        child.once('error',no);child.once('close',(status,signal)=>{clearTimeout(timer);ok({status,signal,stdout,stderr});});
    });
    assert.equal(result.status,73,result.stderr);const marker=JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(marker.boundary,boundary);assert.equal(marker.abrupt,true);
    assert.throws(()=>process.kill(marker.pid,0),{code:'ESRCH'});return result;
}
async function reviewedRecovery(workflow,result,{completed=false}={}){
    for(let attempt=0;attempt<3;attempt++){
        const review=await workflow.recoveryReview();
        try{return await workflow.recoverStart({authorizeRecovery:true,authorizeCompletedOwnerRecovery:completed,expectedReviewHash:review.hash});}
        catch(error){
            if(!['NEW_ERA_OWNER_ALIVE_OR_AMBIGUOUS','LEDGER_V2_OWNER_ALIVE_OR_AMBIGUOUS','SCHEDULED_OWNER_ALIVE_OR_AMBIGUOUS'].includes(error.code)||attempt===2)throw error;
            const pids=[...new Set([result.setupChild,result.child].filter(Boolean).map(child=>JSON.parse(child.stdout.trim().split('\n').at(-1)).pid))];
            const refusal={code:error.code,reviewHash:review.hash,at:new Date().toISOString(),pids,observations:[]};
            (result.safeRefusals??=[]).push(refusal);
            if((await workflow.journal()).records.at(-1)?.body.recoveryPid===process.pid){
                refusal.resumptionNeedsFreshProcess=true;
                throw error;
            }
            // Windows can recycle a terminated child's PID into another test
            // process. Never override production isAlive or kill that process.
            // Wait only for the ordinary OS query to report every PID absent;
            // then obtain a fresh explicit review and retry the durable plan.
            const deadline=Date.now()+30000;
            for(;;){
                const observations=pids.map(pid=>{try{process.kill(pid,0);return {pid,status:'PRESENT'};}catch(e){return {pid,status:e.code};}});
                refusal.observations.push({at:new Date().toISOString(),values:observations});
                if(observations.every(value=>value.status==='ESRCH'))break;
                if(Date.now()>=deadline)throw error;
                await new Promise(resolve=>setTimeout(resolve,250));
            }
        }
    }
}
for(const item of config.rows){
    const callbacks=[],result={boundary:item.boundary,native:config.native,status:'FAIL',worker:config.worker,productionSourceHashes},started=Date.now();
    let runtime;
    try{
        const f=await eraFixture({after:fn=>callbacks.push(fn)},{native:config.native});result.tempRoot=f.root;
        for(const path of Object.values(f.paths))assertNativeTestTarget(path);result.nativeTargetsVerifiedTemp=true;
        const original={program:await readFile(f.paths.program),autoLive:await readFile(f.paths.autoLive)};
        await f.writer.transition(f.authorization);
        if(['recover','recover-completed','restart'].includes(item.operation))result.setupChild=await crash(f,'start',item.setupBoundary??
            (item.operation==='recover'?'runtime/ownership':'controlled-start/ready-durable'));
        let planned;
        if(item.operation==='restart'){
            f.writer.host.proveOffline=async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]});
            const originalWorkflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
            await reviewedRecovery(originalWorkflow,result,{completed:true});
            const after=await originalWorkflow.recoveryReview();
            planned=(await originalWorkflow.planRestart({authorizeRestart:true,expectedReviewHash:after.hash,principal:'TEMP-restart-matrix'})).startAuthorization;
        }
        result.child=await crash(f,item.operation??'start',item.boundary,planned);
        result.filesDurableBeforeRecovery=await snapshot(f.root);
        const proof=async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]});
        const writer=new f.writer.constructor({...f.options,host:{...f.options.host,proveOffline:proof}});
        let workflow=new NewEraRecoveryWorkflow({writer,authorization:f.authorization,startAuthorization:planned});
        if(planned){result.authorizationRecovery='SAME_EXTERNALLY_APPROVED_RESTART_REQUEST';await workflow.installRestartAuthorization({authorizeStart:true});}
        const chain=await workflow.journal();result.classificationAfterRestart=chain.records.at(-1)?.body.state??'ERA_ACTIVATED';
        const completed=await workflow.completedStart();
        if(item.operation==='recover-completed'){
            result.recoveryAction='EXPLICIT_COMPLETED_OWNER_RECONCILIATION_THEN_NEW_START';
            await reviewedRecovery(workflow,result,{completed:true});
            const after=await workflow.recoveryReview();workflow=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:after.hash,principal:'TEMP-post-ready-matrix'});
        }else if(completed)result.recoveryAction='READ_ONLY_ALREADY_COMPLETED';
        else if(['LAUNCH_RESERVED','OWNER_CLAIM','RUNTIME_OWNED','RECONCILIATION_PREPARED'].includes(result.classificationAfterRestart)||
            result.classificationAfterRestart==='START_RESERVED'&&(await readdir(workflow.directory)).some(n=>n.endsWith('.stage'))){
            result.recoveryAction='EXPLICIT_REVIEWED_CANONICAL_RECONCILIATION';
            await reviewedRecovery(workflow,result);
        }else result.recoveryAction='SAME_AUTHORIZATION_START_RETRY';
        runtime=componentLaunch(f,{native:config.native});
        const ready=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
        const expectedEpoch=['recover-completed','restart'].includes(item.operation)?24:23;
        assert.equal(ready.result.ready,true);assert.equal(ready.result.epoch,expectedEpoch);
        const final=await workflow.journal(),intent=final.records.find(r=>r.body.state==='AUTHORITY_INTENT');
        assert.equal(final.records.filter(r=>r.body.state==='AUTHORITY_SUCCESSOR').length,1);
        assert.equal(ready.result.successorId,intent.body.successorId);
        assert.equal(JSON.parse(await readFile(f.paths.authority)).epoch,expectedEpoch);
        for(const key of ['program','autoLive'])assert.deepEqual(await readFile(f.paths[key]),original[key]);
        const era=executionEraStartup(f.paths.ledger),ledger=await inspectV2(f.paths.ledger);
        assert.equal(ledger.records.filter(r=>r.type==='BASE').length,1);assert.equal(ledger.current.ledgerId,f.authorization.ledgerId);
        assert.equal(ledger.current.generation,0);assert.equal(ledger.pending,null);
        for(const event of JSON.parse(await readFile(f.paths.schedule)).events.filter(e=>e.type==='source.live'))assert.equal(eraAdmits(era,identityForScheduledEvent(event)),false);
        const readOnly=await workflow.recoveryReview();
        await controlledStart({workflow,authorizeStart:true,launch:()=>{throw Error('SECOND_LAUNCH');}});
        assert.equal((await workflow.recoveryReview()).hash,readOnly.hash);
        result.finalExecutionEraId=era.executionEraId;result.finalTransitionId=era.transitionId;result.finalLedgerId=era.ledgerId;
        result.finalAuthority=expectedEpoch;result.successorId=intent.body.successorId;result.authorityProcessSession=intent.body.authorityProcessSession;
        result.retirementHash=era.retirementHash;result.programGeneration=47;result.acceptedAuthorityEpoch=20;
        result.autoLiveEnabled=true;result.autoLiveArmed=false;result.status='PASS';
    }catch(error){result.error={code:error.code,message:error.message,stack:error.stack};}
    finally{
        try{await runtime?.close();}catch(error){result.cleanupError={code:error.code,message:error.message};result.status='FAIL';}
        result.elapsedMs=Date.now()-started;
        await writeFile(join(config.evidenceDirectory,'controlled-matrix-'+String(item.index).padStart(4,'0')+'.json'),JSON.stringify(result,null,2)+'\n');
        for(const fn of callbacks)await fn();
    }
    process.stdout.write(JSON.stringify({boundary:result.boundary,status:result.status,elapsedMs:result.elapsedMs})+'\n');
    if(result.status!=='PASS'){process.exitCode=1;break;}
}
