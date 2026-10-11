import {readFile,writeFile} from 'node:fs/promises';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {componentLaunch} from './NewEraControlledRuntime.js';
import {HEAD,BRANCH,testDurability} from './NewExecutionEraFixture.js';
import {registerNativeTestRoot,assertNativeTestTarget} from './NativeTempGuard.mjs';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
registerNativeTestRoot(input.root);for(const path of Object.values(input.paths))assertNativeTestTarget(path);
const host={reserve:async()=>async()=>{},proveOffline:async()=>({absent:true}),inspect:async()=>({root:input.root,branch:BRANCH,head:HEAD,administrator:true,service:{Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',StartName:'LocalSystem'},media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},ports:[],proof:{absent:true},bootstrapPermission:false})};
const writer=new NewExecutionEra({root:input.root,paths:input.paths,host,runtimeCapabilityProof:process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY,...(input.native?{}:{durability:testDurability,native:{capability:()=>({testDouble:true})},verifyRuntimeCapability:()=>({testDouble:true,proofHash:'f'.repeat(64)})})});
const workflow=new NewEraRecoveryWorkflow({writer,authorization:input.authorization}),runtime=componentLaunch(input,{native:input.native});
const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
const store=owner.scheduler.store;
const inserted=await store.insert(input.event,store.state.revision);if(!inserted.ok)throw Error(inserted.code);
await writeFile(input.observation,JSON.stringify({ready:await workflow.completedStart(),event:store.getEvent(input.event.id),schedule:await readFile(input.paths.schedule,'utf8'),program:await readFile(input.paths.program,'utf8'),auto:await readFile(input.paths.autoLive,'utf8')}));
store.eraGrantHook=async(point,path)=>{
 if(['grant-schedule/before-cleanup','grant-schedule/stage-cleaned'].includes(input.boundary)&&point==='grant-schedule/written')throw Error('TEMP_IDENTITY_EDIT_FAILURE');
 if(point===input.boundary){process.stdout.write(JSON.stringify({abrupt:true,boundary:point,pid:process.pid,path,operation:'LIVE_IDENTITY_REVISION'})+'\n');process.exit(73);}
};
const result=await store.update(input.event.id,input.patch,store.state.revision);
throw Error(result.ok?'IDENTITY_ABRUPT_BOUNDARY_NOT_REACHED':result.code);
