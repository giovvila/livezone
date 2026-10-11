import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {eraFixture} from './NewExecutionEraFixture.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {inspectV2,hash,envelope} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';

export const ledgerReconciliationBoundaries=['opened','written','flushed','staged','before-replace','replaced','durable',
    'commit-opened','commit-written','commit-flushed','end-opened','end-written','end-flushed'].map(p=>'ledger-reconciliation/'+p);
async function files(root,path=root){
    const result=[];
    for(const name of await readdir(path)){
        const full=join(path,name),stat=await lstat(full);assert.equal(stat.isSymbolicLink(),false);
        if(stat.isDirectory())result.push(...await files(root,full));
        else result.push({path:relative(root,full),size:stat.size,sha256:hash(await readFile(full))});
    }
    return result.sort((a,b)=>a.path.localeCompare(b.path));
}
async function crash(f,boundary,operation,native){
    const input=join(f.root,operation+'-input.json');
    await writeFile(input,JSON.stringify({root:f.root,paths:f.paths,authorization:f.authorization,native,boundary,operation,identityPath:join(f.root,'identity.json')}));
    const result=await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[fileURLToPath(new URL('./era-ledger-reconciliation-child.mjs',import.meta.url)),input],
            {env:{...process.env,LIVEZONE_NATIVE_TEST_ROOTS:JSON.stringify([f.root])},windowsHide:true,stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
        const timer=setTimeout(()=>{child.kill();reject(Error('LEDGER_RECONCILIATION_CASE_TIMEOUT'));},600000);
        child.once('error',reject);child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
    });
    assert.equal(result.code,73,result.stderr);
    result.marker=JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(result.marker.abrupt,true);
    assert.equal(result.marker.boundary,operation==='recover'?boundary:boundary.includes('/end-')?'seed/ready-owner':'seed/intent-flushed');
    assert.throws(()=>process.kill(result.marker.pid,0),{code:'ESRCH'});
    return result;
}
export async function verifyLedgerReconciliationCase(boundary,{native=false,evidenceDirectory}={}){
    assert.ok(ledgerReconciliationBoundaries.includes(boundary));
    const callbacks=[],result={boundary,native,status:'RUNNING',startedAt:new Date().toISOString()};
    const save=async()=>{if(evidenceDirectory)await writeFile(join(evidenceDirectory,boundary.split('/')[1]+'.json'),JSON.stringify(result,null,2)+'\n');};
    const f=await eraFixture({after:fn=>callbacks.push(fn)},{native});result.tempRoot=f.root;await save();
    try{
        const original={program:await readFile(f.paths.program),autoLive:await readFile(f.paths.autoLive)};
        await f.writer.transition(f.authorization);
        result.seed=await crash(f,boundary,'seed',native);await save();
        const before=await inspectV2(f.paths.ledger);result.ledgerId=before.current.ledgerId;
        result.originalWalHash=hash(before.walBytes);
        result.interruption=await crash(f,boundary,'recover',native);await save();
        result.persistentFiles=await files(f.root);
        const wal=await readFile(f.paths.ledger+'.wal','utf8');
        result.observableRecords=wal.trimEnd().split('\n').map(JSON.parse).map(r=>({type:r.type,data:r.data}));
        result.observedCommitCount=result.observableRecords.filter(r=>r.type==='COMMIT').length;
        result.observedEndCount=result.observableRecords.filter(r=>r.type==='END').length;
        const point=boundary.split('/')[1],walPoint=point.startsWith('commit-')||point.startsWith('end-');
        result.stageFileSyncReturned=walPoint?null:!['opened','written'].includes(point);
        result.canonicalFileSyncReturned=point==='durable'||walPoint&&!point.startsWith('end-');
        result.walAppendSyncReturned=walPoint?point.endsWith('-flushed'):null;
        result.endBytesObserved=result.observedEndCount>0;
        result.commitBytesObserved=result.observedCommitCount>0;
        assert.equal(result.observedEndCount,point==='end-written'||point==='end-flushed'?1:0);
        assert.equal(result.observedCommitCount,point==='commit-written'||point==='commit-flushed'?1:0);
        const writer=new f.writer.constructor({...f.options,host:{...f.options.host,
            proveOffline:async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]})}});
        const workflow=new NewEraRecoveryWorkflow({writer,authorization:f.authorization});
        result.classification=(await workflow.journal()).records.at(-1).body.state;
        assert.equal(result.classification,'RECONCILIATION_PREPARED');
        result.operatorReviewRequired=true;
        const recover=async()=>{
            for(let attempt=0;attempt<3;attempt++){
                const review=await workflow.recoveryReview();
                try{return await workflow.recoverStart({authorizeRecovery:true,authorizeCompletedOwnerRecovery:true,expectedReviewHash:review.hash});}
                catch(error){
                    if(!['NEW_ERA_OWNER_ALIVE_OR_AMBIGUOUS','LEDGER_V2_OWNER_ALIVE_OR_AMBIGUOUS','SCHEDULED_OWNER_ALIVE_OR_AMBIGUOUS'].includes(error.code)||attempt===2)throw error;
                    const pids=[...new Set([result.seed.marker.pid,result.interruption.marker.pid])];
                    const refusal={code:error.code,reviewHash:review.hash,at:new Date().toISOString(),pids,observations:[]};
                    (result.safeRefusals??=[]).push(refusal);
                    if((await workflow.journal()).records.at(-1)?.body.recoveryPid===process.pid){
                        refusal.resumptionNeedsFreshProcess=true;await save();throw error;
                    }
                    // Same bounded OS-only wait as the canonical matrix worker.
                    // Never override liveness or kill a possibly reused PID.
                    const deadline=Date.now()+30000;
                    for(;;){
                        const values=pids.map(pid=>{try{process.kill(pid,0);return {pid,status:'PRESENT'};}catch(e){return {pid,status:e.code};}});
                        refusal.observations.push({at:new Date().toISOString(),values});
                        if(values.every(v=>v.status==='ESRCH'))break;
                        if(Date.now()>=deadline){await save();throw error;}
                        await new Promise(resolve=>setTimeout(resolve,250));
                    }
                    await save();
                }
            }
        };
        await save();
        {

            result.expectedCanonicalBytes=before.pending?JSON.stringify(envelope(f.paths.ledger,before.pending.next))+'\n':before.canonicalBytes;
            result.firstRetry=await recover();
            assert.equal(await readFile(f.paths.ledger,'utf8'),result.expectedCanonicalBytes);
            const after=await inspectV2(f.paths.ledger),image=JSON.stringify(await files(f.root));
            result.secondRetry=await recover();assert.equal(JSON.stringify(await files(f.root)),image);
            assert.equal(after.pending,null);assert.equal(after.owner,null);assert.equal(after.current.ledgerId,result.ledgerId);
            assert.equal(after.records.filter(r=>r.type==='BEGIN').length,1);
            result.finalCommitCount=after.records.filter(r=>r.type==='COMMIT').length;
            result.finalEndCount=after.records.filter(r=>r.type==='END').length;
            assert.equal(result.finalCommitCount,boundary.includes('/end-')?0:1);assert.equal(result.finalEndCount,1);
            assert.equal(after.current.generation,boundary.includes('/end-')?0:1);
            if(before.pending){
                assert.deepEqual(after.current,before.pending.next);
                const identity=JSON.parse(await readFile(join(f.root,'identity.json')));
                assert.equal(after.current.entries.filter(r=>r.identity.entryKey===identity.entryKey).length,1);
                result.entryRetryClassification='ALREADY_CONSUMED';result.identity=identity;
            }
            result.finalLedgerId=after.current.ledgerId;result.finalGeneration=after.current.generation;
            result.finalSnapshot=after.current;result.finalWalHash=hash(after.walBytes);
            result.retryResult='RECONCILED_IDEMPOTENT';result.recoveryClassification=(await workflow.journal()).records.at(-1).body.state;
            assert.equal(result.recoveryClassification,'RECONCILED');
        }
        const names=await readdir(f.root);
        result.lockState={ledger:names.includes('ledger.json.lock'),authority:names.includes('authority.json.lock'),scheduled:names.includes('scheduled.json.lock'),
            maintenance:names.includes('authority.json.maintenance'),
            ledgerArchives:names.filter(n=>n.startsWith('ledger.json.lock.reconciled-'))};
        assert.equal(result.lockState.ledger,false);
        assert.equal(result.lockState.ledgerArchives.length,1);
        assert.equal(result.lockState.authority,false);
        assert.equal(result.lockState.scheduled,false);
        assert.equal(result.lockState.maintenance,false);
        const audit=names.find(n=>n.startsWith('ledger.json.recovery-')&&n.endsWith('.json'));
        result.ledgerAudit=JSON.parse(await readFile(join(f.root,audit)));
        result.ledgerCompletion=JSON.parse(await readFile(join(f.root,audit+'.completed')));
        result.finalPersistentFiles=await files(f.root);
        assert.equal(result.finalLedgerId,result.ledgerId);
        for(const key of ['program','autoLive'])assert.deepEqual(await readFile(f.paths[key]),original[key]);
        result.authorization=f.authorization;result.status='PASS';await save();
        for(const fn of callbacks)await fn();return result;
    }catch(error){
        result.status='FAIL';result.error={code:error.code,message:error.message,stack:error.stack};
        result.fixtureRetained=true;await save();throw Object.assign(error,{receipt:result});
    }
}
