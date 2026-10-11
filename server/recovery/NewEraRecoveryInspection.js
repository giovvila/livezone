import {readEvidence} from './PersistentEvidence.js';
import {ERA_PHASES,eraRecordBytes,unsealEra,executionEraStartup,assertEraAuthority} from './ExecutionEraContract.js';
import {seal,equal,fail,hash} from '../scheduler/ScheduledEntryLedgerV2Protocol.js';
import {assertRepository} from './RecoveryContract.js';
import {join} from 'node:path';
import {readdir} from 'node:fs/promises';
const states=['AUTHORIZED','FORENSIC_DURABLE','RETIREMENT_DURABLE','ERA_INTENT_DURABLE','LEGACY_ARCHIVED','LEDGER_INITIALIZED','SCHEDULE_BOUND','ERA_ACTIVATED'];

// Operator entry point: expected HEAD is supplied independently of saved phase
// bytes. Reuse the recovery identity, approved authorization and canonical status
// fence; inspection never issues a replacement authorization or exercises storage.
export async function inspectExpectedNewEraRecovery(writer,{authorization}={}){
    const host=await writer.host.inspect();
    assertRepository(host,writer.root,writer.expected);
    if(authorization){
        if(authorization.approvedHead!==writer.expected.head||authorization.approvedBranch!==writer.expected.branch)
            fail('NEW_ERA_RECOVERY_CONTEXT');
        writer.assertAuthorization(authorization);
    }
    const view=await writer.inspectRecovery({authorization});
    if(view.state==='NO_TRANSITION'||view.state==='STAGING_REVIEW_REQUIRED'){
        if(authorization)await writer.verifyAuthorizationProof(authorization);
        return {...view,completedPhase:null,nextPhase:'authorized',
            nextAction:view.state==='NO_TRANSITION'?'DRYRUN_AND_EXPLICIT_AUTHORIZATION':'CANONICAL_REVIEW',
            reviewRequired:view.state==='STAGING_REVIEW_REQUIRED'};
    }
    if(!authorization)fail('NEW_ERA_AUTHORIZATION_FILE_AND_HASH_REQUIRED');
    if(view.nextPhase){
        const checkpoint=await writer.transitionStatus(authorization);
        return {...view,...checkpoint,readOnly:true,proofHash:authorization.authorizedProofHash,
            nextAction:checkpoint.canonicalResumeRequired?'CANONICAL_REVIEW':'EXPLICIT_NEXT_PHASE'};
    }
    // Completed activation is historical transition authority. Current runtime
    // inspection accepts a separately approved current deployment proof (NEW21),
    // while the original authorization/proof binding remains reported unchanged.
    const proof=await writer.currentRuntimeProof();
    return {...view,completedPhase:'activated',nextPhase:null,proofHash:proof.proofHash,
        authorizedProofHash:authorization.authorizedProofHash,authorizationHash:hash(authorization),
        reviewRequired:view.state==='AUTHORITY_TRANSITIONING_REVIEW_REQUIRED',
        nextAction:view.state==='AUTHORITY_TRANSITIONING_REVIEW_REQUIRED'?'CANONICAL_REVIEW':'START_REVIEW'};
}

// Observation only. Never infer a dead owner or authorize lock deletion from
// PID/age. Offline reconciliation requires its own canonical durable decision.
export async function inspectNewEraRecovery(writer,{authorization}={}){
    let previous=null,found=null,gap=false,last=-1;const artifacts=[];
    for(let i=0;i<ERA_PHASES.length;i++){
        const phase=ERA_PHASES[i],path=join(writer.directory,phase+'.json');
        const saved=await readEvidence(path,{optional:true,text:false});
        if(!saved){gap=true;continue;}
        const record=JSON.parse(saved.bytes),body=unsealEra(record);
        if(gap||body.version!==1||body.phase!==phase||body.previous!==previous)fail('NEW_ERA_RECOVERY_LINEAGE');
        found??=body.authorization;
        if(!equal(found,body.authorization)||(authorization&&!equal(found,authorization))||found.repository!==writer.root||
            found.approvedHead!==writer.expected?.head||!equal(found.paths,writer.paths))fail('NEW_ERA_RECOVERY_CONTEXT');
        if(!saved.bytes.equals(eraRecordBytes(seal({version:1,phase,previous,authorization:found}))))fail('NEW_ERA_RECOVERY_BYTES');
        artifacts.push({phase,path,sha256:saved.sha256});previous=record.checksum;last=i;
    }
    if(last<0){let names=[];try{names=await readdir(writer.directory);}catch(e){if(e.code!=='ENOENT')throw e;}
        return {state:names.length?'STAGING_REVIEW_REQUIRED':'NO_TRANSITION',artifacts,readOnly:true};}
    const identity={transitionId:found.transitionId,executionEraId:found.executionEraId,ledgerId:found.ledgerId,retirementHash:found.retirementHash};
    if(last<ERA_PHASES.length-1){
        await writer.fence(found,{offline:false});
        return {state:states[last],...identity,artifacts,nextPhase:ERA_PHASES[last+1],readOnly:true};
    }
    const era=executionEraStartup(writer.paths.ledger),lock=await readEvidence(writer.paths.authorityLock,{optional:true,json:true});
    const epoch=await readEvidence(writer.paths.authority,{json:true});
    const starts=(await readdir(writer.directory)).filter(n=>/^start-[a-f0-9-]{36}\.json$/.test(n));
    if(!lock)return {state:'ERA_ACTIVATED',...identity,artifacts,historicalOwners:starts.length,readOnly:true};
    const path=join(writer.directory,'start-'+lock.value.authorityProcessSession+'.json');
    const owner=await readEvidence(path,{optional:true,json:true});
    if(!owner)return {state:'AUTHORITY_TRANSITIONING_REVIEW_REQUIRED',...identity,artifacts,authorityEpoch:epoch.value.epoch,
        reason:'NO_DURABLE_AUTHORITY_INTENT_OR_COMPLETE_SUCCESSOR',readOnly:true};
    const body=unsealEra(owner.value);
    if(body.activationHash!==era.activationHash||body.authorityEpoch!==epoch.value.epoch||body.lockBytesHash!==lock.sha256||
        body.authorityBytesHash!==epoch.sha256||body.authorityProcessSession!==lock.value.authorityProcessSession)fail('NEW_ERA_RECOVERY_OWNER_CHANGED');
    const ready=await readEvidence(path+'.ready',{optional:true,json:true});
    // Validate durable bindings only. This descriptor is not a live ownership
    // grant and must never be returned as one or passed to runtime operations.
    assertEraAuthority(era,{available:true,executionEraId:era.executionEraId,
        authorityEpoch:epoch.value.epoch,authorityProcessSession:lock.value.authorityProcessSession,
        eraReady:!!ready},{ready:!!ready});
    return {state:ready?'READY_ANCHOR_DURABLE':'OWNER_ANCHOR_DURABLE',...identity,artifacts,authorityEpoch:epoch.value.epoch,
        liveOwnerStatus:'NOT_PROVEN_BY_READ_ONLY_INSPECTION',reconciliation:'CANONICAL_OFFLINE_REVIEW_REQUIRED',readOnly:true};
}
