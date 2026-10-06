import {artifact,fail,same} from './RecoveryContract.js';

// The audit's byte digest binds its immutable identity and captured before-state.
export async function lineageContext(workflow){
    const value=await workflow.load();
    const audit=await artifact(workflow.audit);
    if(!audit||!same(audit.value,value))fail('RECOVERY_AUDIT_CHANGED');
    return {version:1,auditHash:audit.hash,runId:workflow.runId,head:workflow.expected.head,root:workflow.p.root};
}
export function phaseRecord(context,phase,predecessor,value){
    return {...value,lineage:{...context,phase,predecessorHash:predecessor?.hash??context.auditHash}};
}
export function validatePhase(record,context,phase,predecessor){
    if(!record)fail('RECOVERY_PHASE_REQUIRED');
    if(!record.value.lineage)fail('LEGACY_PHASE_RECORD_REVIEW_REQUIRED');
    const expected={...context,phase,predecessorHash:predecessor?.hash??context.auditHash};
    if(!same(record.value.lineage,expected))fail('RECOVERY_PHASE_LINEAGE_MISMATCH');
    return record;
}
export async function phaseChain(workflow,through,{optional=false}={}){
    const context=await lineageContext(workflow),records={};let predecessor;
    const phases=['prepared','disarm','disarm.completed','start','ready'];
    for(const phase of phases){
        const record=await artifact(workflow.audit+'.'+phase);
        if(!record&&optional){
            for(const later of phases.slice(phases.indexOf(phase)+1))if(await artifact(workflow.audit+'.'+later))fail('RECOVERY_PHASE_REQUIRED');
            break;
        }
        validatePhase(record,context,phase,predecessor);
        const v=record.value;
        if((phase==='prepared'&&(v.state!=='PREPARED_FOR_EXPLICIT_DISARM'||v.head!==context.head))||
            (phase==='disarm'&&(v.state!=='PREPARED'||v.action!=='EXPLICIT_OFFLINE_DISARM'))||
            (phase==='disarm.completed'&&(v.state!=='COMPLETED'||v.beforeHash!==predecessor.value.expectedHash||v.afterHash!==predecessor.value.plannedAfterHash))||
            (phase==='start'&&(v.state!=='START_RESERVED'||v.version!==1||v.head!==context.head||typeof v.bootstrap!=='boolean'||!v.before))||
            (phase==='ready'&&(v.ready!==true||v.head!==context.head||v.recoveryRunId!==context.runId||v.root!==context.root)))fail('RECOVERY_PHASE_SCHEMA_INVALID');
        records[phase]=record;predecessor=record;
        if(phase===through)break;
    }
    return {context,records,predecessor};
}
