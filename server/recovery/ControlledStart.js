import {artifact,capture,writeOnce,runtimeStatus,verifyReadiness,same,fail} from './RecoveryContract.js';
import {assertHost} from './WindowsRecoveryHost.js';
import {ledgerAuthority} from './RestoreLedgerAuthority.js';
import {phaseChain,phaseRecord} from './RecoveryLineage.js';

export async function controlledStart({workflow,authorizeStart=false,authorizeBootstrap=false,authorizeReconciliation=false,launch,timeoutMs=60000}){
    if(!authorizeStart)fail('EXPLICIT_START_AUTHORIZATION_REQUIRED');
    if(workflow.newEra){await workflow.installRestartAuthorization({authorizeStart});const completed=await workflow.completedStart();if(completed)return completed;}
    else if(await artifact(workflow.audit+'.ready')){
        // Completed Start is read-only. An online owner still requires the
        // canonical offline/reconciliation path; it is never adopted by PID.
        const first=await workflow.restoreReview(),fresh=await workflow.restoreReview();
        if(!same(first.review,fresh.review)||!same(first.evidence,fresh.evidence)||!same(first.service,fresh.service)||!same(first.media,fresh.media))fail('START_EVIDENCE_CHANGED');
        const ready=fresh.review.ready?.value;
        if(!ready||fresh.review.restorePlan||fresh.review.completion||fresh.evidence.authority?.value.epoch!==ready.epoch||
            ['auto','schedule','program'].some(key=>fresh.evidence[key]?.hash!==ready[key+'Hash']))fail('RECOVERY_READY_CURRENT_STATE_CHANGED');
        return {owner:null,result:ready};
    }
    if(workflow.newEra&&!authorizeReconciliation)fail('EXPLICIT_RESTART_RECONCILIATION_REQUIRED');
    const start=await workflow.reserveStart({authorizeStart,authorizeBootstrap});
    // Last canonical census after releasing the maintenance gate; authority's
    // own exclusive lock still arbitrates startup. No service/manual overlap.
    const checked=await workflow.preflight();
    const readChain=()=>workflow.newEra?workflow.startChain():phaseChain(workflow,'start');
    const chain=await readChain();
    if(workflow.newEra)await workflow.validateStart(start,chain);
    else if(!same(chain.predecessor.value,start))fail('START_RESERVATION_CHANGED');
    const expectedEvidence=workflow.newEra?workflow.expectedEvidence(start,chain):start.before;
    if(!same(checked.evidence,expectedEvidence))fail('START_EVIDENCE_CHANGED');
    const release=await workflow.host.reserve();await release();
    const p=workflow.p;
    const options={studioStatePath:p.studio,schedulePath:p.schedule,autoLivePath:p.auto,mediaLibraryRoot:p.mediaRoot,
        scheduledLiveExecutionPath:p.scheduled,scheduledEntryLedgerPath:p.ledger,
        scheduledEntryLedgerBootstrap:start.bootstrap,
        ...(workflow.newEra?{executionOwnershipOptions:workflow.ownershipOptions()}: {})};
    if(start.ledgerProtocolVersion===2||start.before.ledger?.value.schemaVersion===2)options.scheduledEntryLedgerOptions={protocolVersion:2};
    if(!launch){
        const {startProgramOutputServer,createProgramOutputServer}=await import('../program-output-server.js');
        const {installGracefulShutdown}=await import('../GracefulShutdown.js');
        launch=options=>{const owner=startProgramOutputServer({serverFactory:()=>createProgramOutputServer(options)});installGracefulShutdown(owner);return owner;};
    }
    // Permission exists only as the boolean passed to this one server instance.
    // No environment variable, service setting or persistent enable flag is set.
    let timer;
    try{
        await workflow.hook('before-controlled-launch');
        if(!same(await readChain(),chain))fail('RECOVERY_PHASE_LINEAGE_CHANGED');
        const fresh=await workflow.preflight();
        if(!same(fresh.evidence,expectedEvidence)||!same(fresh.service,checked.service)||!same(fresh.media,checked.media))fail('START_EVIDENCE_CHANGED');
        if(workflow.newEra)await workflow.beforeLaunch();
        const owner=launch(options);
        await workflow.hook('server-started');
        await Promise.race([Promise.all([owner.executionOwnership.ready,owner.scheduler.ready,owner.scheduledLiveExecutionReady,
            owner.scheduledEntryReady,owner.programReady,owner.autoLive.ready]),new Promise((_,reject)=>{
                timer=setTimeout(()=>reject(Error('CONTROLLED_START_READINESS_TIMEOUT')),timeoutMs);
            })]);
        const h=await workflow.host.inspect();assertHost(h,p.root,{online:true,expected:workflow.expected});
        if(workflow.newEra){
            const result=await workflow.finishRuntime(owner,{authorizeReconciliation,hostSnapshot:h});
            return {owner,result};
        }
        const after=await capture(p);
        const result=verifyReadiness({before:start.before,after,runtime:runtimeStatus(owner),processes:h.proof.processes,
            ports:h.ports,service:h.service,startedAt:start.at,bootstrap:start.bootstrap});
        await workflow.hook('before-readiness-evidence');
        const ledgerEvidence=await ledgerAuthority(workflow,{allowOwner:true});
        const freshChain=await phaseChain(workflow,'start');
        if(!same(freshChain,chain))fail('RECOVERY_PHASE_LINEAGE_CHANGED');
        await writeOnce(workflow.audit+'.ready',phaseRecord(chain.context,'ready',chain.predecessor,{...result,head:h.head,bootstrapUsed:start.bootstrap,
            programHash:after.program.hash,scheduleHash:after.schedule.hash,ledgerHash:after.ledger.hash,autoHash:after.auto.hash,
            recoveryRunId:workflow.runId,root:p.root,ledgerAuthority:ledgerEvidence,ledgerProtocolVersion:ledgerEvidence.mode==='V2'?2:1,
            ...(after.migrationCompleted?{migrationTransactionId:after.migrationCompleted.value.transactionId,
                migratedGeneration:after.migrationCompleted.value.generation,ledgerProtocolVersion:2}:{})}));
        if(ledgerEvidence.mode==='V2')await workflow.migrationAuditBarrier([workflow.audit+'.ready']);
        return {owner,result};
    }catch(error){
        // Preserve durable state; never undo migration/epochs/consumption.
        error.manualServerMayBeRunning=true;throw error;
    }finally{clearTimeout(timer);}
}
