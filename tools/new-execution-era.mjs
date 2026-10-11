import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {paths as recoveryPaths,recoveryIdentity} from '../server/recovery/RecoveryContract.js';
import {inspectExpectedNewEraRecovery} from '../server/recovery/NewEraRecoveryInspection.js';
import {WindowsRecoveryHost} from '../server/recovery/WindowsRecoveryHost.js';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {hash} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';

// Explicit offline operator tool. No default action and no startup invocation.
const [action,...args]=process.argv.slice(2);
const options={};
for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1]||Object.hasOwn(options,args[i]))throw Error('NEW_ERA_ARGUMENTS');options[args[i]]=args[i+1];}
const root=resolve(options['--root']??'.'),p=recoveryPaths(root);
const paths={ledger:p.ledger,ledgerLock:p.ledgerLock,bootstrap:p.marker,authority:p.authority,authorityLock:p.authorityLock,
    scheduledLock:p.scheduledLock,scheduledJournal:p.scheduled,schedule:p.schedule,program:p.program,autoLive:p.auto,
    studio:p.studio,mediaManifest:p.mediaManifest,configuration:join(root,'public/config/config.json')};
const writer=new NewExecutionEra({root,paths,host:new WindowsRecoveryHost(root),runtimeCapabilityProof:options['--runtime-capability-proof'],
    ...(action==='inspect'?{expected:recoveryIdentity(options['--expected-head'])}: {})});
let result;
if(action==='dryrun')result=await writer.dryRun({expectedInventoryHash:options['--expected-inventory-hash']});
else if(action==='inspect'){
    let authorization;
    if(options['--authorization-file']||options['--authorization-hash']){
        if(!options['--authorization-file']||!options['--authorization-hash'])throw Error('NEW_ERA_AUTHORIZATION_FILE_AND_HASH_REQUIRED');
        authorization=JSON.parse(await readFile(resolve(options['--authorization-file']),'utf8'));
        if(hash(authorization)!==options['--authorization-hash'])throw Error('NEW_ERA_AUTHORIZATION_DIGEST_MISMATCH');
    }
    result=await inspectExpectedNewEraRecovery(writer,{authorization});
}
else if(action==='authorize'){
    if(options['--authorize-new-era']!=='YES'||options['--retire-whole-legacy-domain']!=='YES')throw Error('NEW_ERA_EXPLICIT_AUTHORIZATION_REQUIRED');
    result=await writer.plan({principal:options['--principal'],approvedHead:options['--approved-head'],approvedBranch:options['--approved-branch'],
        expectedInventoryHash:options['--expected-inventory-hash'],authorizeNewEra:true,retireWholeLegacyDomain:true});
}else if(['transition','transition-status','start-review','controlled-start','recover-start','authorize-restart'].includes(action)){
    if(!options['--authorization-file']||!options['--authorization-hash'])throw Error('NEW_ERA_AUTHORIZATION_FILE_AND_HASH_REQUIRED');
    const authorization=JSON.parse(await readFile(resolve(options['--authorization-file']),'utf8'));
    if(hash(authorization)!==options['--authorization-hash'])throw Error('NEW_ERA_AUTHORIZATION_DIGEST_MISMATCH');
    if(action==='transition'){
        if(!options['--phase']||!options['--expected-checkpoint-hash'])throw Error('NEW_ERA_EXPLICIT_PHASE_AND_CHECKPOINT_REQUIRED');
        result=await writer.transition(authorization,{phase:options['--phase'],expectedCheckpointHash:options['--expected-checkpoint-hash']});
    }else if(action==='transition-status'){
        try{result={...await writer.transitionStatus(authorization),readOnly:true};}
        catch(error){process.exitCode=1;result={status:'REVIEW_REQUIRED',reviewRequired:true,
            continuationAuthorizationCurrent:false,readOnly:true,reason:error.code??error.message};}
    }
    else{
        let startAuthorization;
        if(options['--restart-authorization-file']){
            startAuthorization=JSON.parse(await readFile(resolve(options['--restart-authorization-file']),'utf8'));
            if(hash(startAuthorization)!==options['--restart-authorization-hash'])throw Error('NEW_ERA_RESTART_AUTHORIZATION_DIGEST_MISMATCH');
        }
        const workflow=new NewEraRecoveryWorkflow({writer,authorization,startAuthorization});
        if(action==='start-review')result=await workflow.startReview();
        else if(action==='controlled-start'){
            if(options['--authorize-start']!=='YES'||options['--authorize-reconciliation']!=='YES')throw Error('NEW_ERA_EXPLICIT_START_AND_RECONCILIATION_REQUIRED');
            result=(await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true})).result;
        }else if(action==='recover-start'){
            if(options['--authorize-recovery']!=='YES')throw Error('EXPLICIT_NEW_ERA_RECOVERY_REQUIRED');
            result=await workflow.recoverStart({authorizeRecovery:true,authorizeCompletedOwnerRecovery:options['--authorize-completed-owner-recovery']==='YES',
                expectedReviewHash:options['--expected-review-hash']});
        }else{
            if(options['--authorize-restart']!=='YES')throw Error('EXPLICIT_NEW_ERA_RESTART_REQUIRED');
            result=(await workflow.planRestart({authorizeRestart:true,expectedReviewHash:options['--expected-review-hash'],principal:options['--principal']})).startAuthorization;
        }
    }
}else throw Error('NEW_ERA_EXPLICIT_ACTION_REQUIRED: dryrun | inspect | authorize | transition-status | transition | start-review | controlled-start | recover-start | authorize-restart');
process.stdout.write(JSON.stringify(result,null,2)+'\n');
