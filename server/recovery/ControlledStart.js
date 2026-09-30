import {capture,writeOnce,runtimeStatus,verifyReadiness,same,fail} from './RecoveryContract.js';
import {assertHost} from './WindowsRecoveryHost.js';

export async function controlledStart({workflow,authorizeStart=false,authorizeBootstrap=false,launch,timeoutMs=60000}){
    const start=await workflow.reserveStart({authorizeStart,authorizeBootstrap});
    // Last canonical census after releasing the maintenance gate; authority's
    // own exclusive lock still arbitrates startup. No service/manual overlap.
    const checked=await workflow.preflight();
    if(!same(checked.evidence,start.before))fail('START_EVIDENCE_CHANGED');
    const release=await workflow.host.reserve();await release();
    const p=workflow.p;
    const options={studioStatePath:p.studio,schedulePath:p.schedule,autoLivePath:p.auto,mediaLibraryRoot:p.mediaRoot,
        scheduledLiveExecutionPath:p.scheduled,scheduledEntryLedgerPath:p.ledger,
        scheduledEntryLedgerBootstrap:start.bootstrap};
    if(!launch){
        const {startProgramOutputServer,createProgramOutputServer}=await import('../program-output-server.js');
        const {installGracefulShutdown}=await import('../GracefulShutdown.js');
        launch=options=>{const owner=startProgramOutputServer({serverFactory:()=>createProgramOutputServer(options)});installGracefulShutdown(owner);return owner;};
    }
    // Permission exists only as the boolean passed to this one server instance.
    // No environment variable, service setting or persistent enable flag is set.
    let timer;
    try{
        const owner=launch(options);
        await workflow.hook('server-started');
        await Promise.race([Promise.all([owner.executionOwnership.ready,owner.scheduler.ready,owner.scheduledLiveExecutionReady,
            owner.scheduledEntryReady,owner.programReady,owner.autoLive.ready]),new Promise((_,reject)=>{
                timer=setTimeout(()=>reject(Error('CONTROLLED_START_READINESS_TIMEOUT')),timeoutMs);
            })]);
        const h=await workflow.host.inspect();assertHost(h,p.root,{online:true});
        const after=await capture(p);
        const result=verifyReadiness({before:start.before,after,runtime:runtimeStatus(owner),processes:h.proof.processes,
            ports:h.ports,service:h.service,startedAt:start.at,bootstrap:start.bootstrap});
        await workflow.hook('before-readiness-evidence');
        await writeOnce(workflow.audit+'.ready',{...result,head:h.head,bootstrapUsed:start.bootstrap,
            programHash:after.program.hash,scheduleHash:after.schedule.hash,ledgerHash:after.ledger.hash,autoHash:after.auto.hash});
        return {owner,result};
    }catch(error){
        // Preserve durable state; never undo migration/epochs/consumption.
        error.manualServerMayBeRunning=true;throw error;
    }finally{clearTimeout(timer);}
}
