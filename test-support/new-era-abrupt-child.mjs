import {readFile} from 'node:fs/promises';
import {registerNativeTestRoot} from './NativeTempGuard.mjs';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {testDurability,HEAD,BRANCH} from './NewExecutionEraFixture.js';
import {componentLaunch} from './NewEraControlledRuntime.js';
import {basename} from 'node:path';

const input=JSON.parse(await readFile(process.argv[2],'utf8'));
registerNativeTestRoot(input.root);
const host={inspect:async()=>({root:input.root,head:HEAD,branch:BRANCH,administrator:true,
    service:{Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',StartName:'LocalSystem'},
    media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},proof:{absent:true},ports:[],bootstrapPermission:false}),
    proveOffline:async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]}),reserve:async()=>async()=>{}};
function offlineId(point,path){
    if(point.startsWith('phase:'))return 'phase-completed/'+point.slice(6);
    if(!path)return point;
    const name=basename(path),key=Object.entries(input.paths).find(([,p])=>p===path)?.[0];
    if(point==='before-archive'||point==='archived')return 'archive/'+key+'/'+point;
    if(['before-schedule-replace','schedule-replaced'].includes(point))return point;
    let artifact;
    if(/^(authorized|forensic|retired|intent|archived|ledger|schedule|activated)\.json$/.test(name)&&path.includes('execution-era'))artifact='phase/'+name.slice(0,-5);
    else if(name==='blob-'+input.scheduledJournalHash)artifact='forensic/scheduledJournal';
    else if(name.startsWith('blob-'))artifact='forensic/'+name;
    else if(name==='manifest.json')artifact='forensic/manifest';
    else if(path===input.paths.ledger)artifact='ledger/BASE';
    else if(path===input.paths.ledger+'.wal')artifact='ledger/WAL';
    else if(path===input.paths.bootstrap)artifact='ledger/bootstrap';
    else if(name.startsWith(basename(input.paths.schedule)+'.era-'))artifact='schedule/stage';
    return artifact?artifact+'/'+point:null;
}
function interrupt(id){if(id===input.boundary){
    process.stdout.write(JSON.stringify({boundary:id,pid:process.pid,abrupt:true})+'\n');
    // Deliberately bypass every finally, close(), owner shutdown and fixture hook.
    process.exit(73);
}}
const writer=new NewExecutionEra({root:input.root,paths:input.paths,host,expected:{head:HEAD,branch:BRANCH},
    runtimeCapabilityProof:process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY,
    ...(input.native?{}:{durability:testDurability,native:{capability:()=>({testDouble:true})},verifyRuntimeCapability:()=>({testDouble:true,proofHash:'f'.repeat(64)})}),
    hook:(point,path)=>interrupt(offlineId(point,path))});
if(input.operation==='offline'){await writer.transition(input.authorization);}
else{
    if(input.transitionFirst)await writer.transition(input.authorization);
    const workflow=new NewEraRecoveryWorkflow({writer,authorization:input.authorization,startAuthorization:input.startAuthorization,
        hook:async(point,path,state)=>{
            let id=point;
            if(point==='ledger-reconciliation/completed')interrupt('restart/terminal-ledger-recovery');
            if(point.startsWith('recovery/')){
                const phase={AUTHORITY_INTENT:'authority-intent',AUTHORITY_SUCCESSOR:'authority-successor',START_RESERVED:'start',LAUNCH_RESERVED:'launch',OWNER_CLAIM:'claim',RUNTIME_OWNED:'owned',READY:'ready',RECONCILIATION_PREPARED:'reconciliation-prepared',RECONCILED:'reconciled'}[state];
                const name=basename(path);
                if(name==='restart-authorization.json')id='restart-authorization/'+point.slice(9);
                else if(/^start-.*\.json\.ready$/.test(name))id='ready-anchor/'+point.slice(9);
                else if(/^start-.*\.json$/.test(name))id='owner-anchor/'+point.slice(9);
                else if(phase)id='controlled/'+phase+'/'+point.slice(9);
            }
            if(input.operation==='recover-completed')id='completed-owner-recovery/'+id;
            interrupt(id);
        }});
    if(['recover','recover-completed'].includes(input.operation)){
        const review=await workflow.recoveryReview();await workflow.recoverStart({authorizeRecovery:true,
            authorizeCompletedOwnerRecovery:input.operation==='recover-completed',expectedReviewHash:review.hash});
    }else{
        const runtime=componentLaunch({root:input.root,paths:input.paths},{native:input.native});
        await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
        await runtime.close();
    }
}
throw Error('ABRUPT_BOUNDARY_NOT_REACHED: '+input.boundary);
