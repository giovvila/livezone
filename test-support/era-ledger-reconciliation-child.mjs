import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {identityForScheduledEvent,ENTRY_METADATA,ERA_ENTRY_METADATA} from '../server/scheduler/ScheduledEventIdentity.js';
import {componentLaunch} from './NewEraControlledRuntime.js';
import {HEAD,BRANCH,testDurability} from './NewExecutionEraFixture.js';
import {registerNativeTestRoot,assertNativeTestTarget} from './NativeTempGuard.mjs';

const input=JSON.parse(await readFile(process.argv[2],'utf8'));
registerNativeTestRoot(input.root);
for(const path of Object.values(input.paths))assertNativeTestTarget(path);
const host={reserve:async()=>async()=>{},proveOffline:async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]}),
    inspect:async()=>({root:input.root,branch:BRANCH,head:HEAD,administrator:true,
        service:{Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',StartName:'LocalSystem'},
        media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},ports:[],proof:{absent:true},bootstrapPermission:false})};
const writer=new NewExecutionEra({root:input.root,paths:input.paths,host,expected:{head:HEAD,branch:BRANCH},
    runtimeCapabilityProof:process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY,
    ...(input.native?{}:{durability:testDurability,native:{capability:()=>({testDouble:true})},verifyRuntimeCapability:()=>({testDouble:true,proofHash:'f'.repeat(64)})})});
function interrupt(boundary){
    process.stdout.write(JSON.stringify({boundary,pid:process.pid,abrupt:true})+'\n');
    process.exit(73); // Intentionally bypass shutdown, finally and END emission.
}
const workflow=new NewEraRecoveryWorkflow({writer,authorization:input.authorization,
    hook:point=>{if(input.operation==='recover'&&point===input.boundary)interrupt(point);}});
if(input.operation==='seed'){
    const runtime=componentLaunch(input,{native:input.native});
    const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
    if(!input.boundary.startsWith('ledger-reconciliation/end-')){
        const store=owner.scheduler.store;
        const event={...store.listEvents().find(e=>e.type==='source.live'),id:'era16b-pending',
            startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:10:00.000Z'};
        for(const key of [...ENTRY_METADATA,...ERA_ENTRY_METADATA])delete event[key];
        const published=await store.insert(event,store.state.revision);assert.equal(published.ok,true,published.code);
        const identity=identityForScheduledEvent(store.getEvent(event.id));
        await writeFile(input.identityPath,JSON.stringify(identity));
        owner.ledger.hook=point=>{if(point==='intent-flushed')interrupt('seed/intent-flushed');};
        await owner.ledger.consume(identity,{authorityEpoch:owner.executionOwnership.authorityEpoch,
            authorityProcessSession:owner.executionOwnership.authorityProcessSession,consumedAt:'2030-01-01T12:00:00.000Z'});
    }else interrupt('seed/ready-owner');
}else{
    const review=await workflow.recoveryReview();
    await workflow.recoverStart({authorizeRecovery:true,authorizeCompletedOwnerRecovery:true,expectedReviewHash:review.hash});
}
throw Error('LEDGER_RECONCILIATION_BOUNDARY_NOT_REACHED: '+input.boundary);
