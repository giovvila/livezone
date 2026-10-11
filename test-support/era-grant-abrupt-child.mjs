import {readFile,writeFile} from 'node:fs/promises';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {executionEraStartup,issueEraEntry} from '../server/recovery/ExecutionEraContract.js';
import {componentLaunch} from './NewEraControlledRuntime.js';
import {HEAD,BRANCH,testDurability} from './NewExecutionEraFixture.js';
import {registerNativeTestRoot,assertNativeTestTarget} from './NativeTempGuard.mjs';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
registerNativeTestRoot(input.root);for(const path of Object.values(input.paths))assertNativeTestTarget(path);
const host={reserve:async()=>async()=>{},proveOffline:async()=>({absent:true}),inspect:async()=>({root:input.root,branch:BRANCH,head:HEAD,administrator:true,service:{Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',StartName:'LocalSystem'},media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},ports:[],proof:{absent:true},bootstrapPermission:false})};
const writer=new NewExecutionEra({root:input.root,paths:input.paths,host,runtimeCapabilityProof:process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY,...(input.native?{}:{durability:testDurability,native:{capability:()=>({testDouble:true})},verifyRuntimeCapability:()=>({testDouble:true,proofHash:'f'.repeat(64)})})});
const workflow=new NewEraRecoveryWorkflow({writer,authorization:input.authorization});
const runtime=componentLaunch(input,{native:input.native});
const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
await writeFile(input.observation,JSON.stringify({ready:await workflow.completedStart(),authority:owner.executionOwnership.authorityEpoch,session:owner.executionOwnership.authorityProcessSession,ledger:await readFile(input.paths.ledger,'utf8'),program:await readFile(input.paths.program,'utf8'),auto:await readFile(input.paths.autoLive,'utf8')}));
const hook=async(point,path)=>{
 if(['grant-schedule/before-cleanup','grant-schedule/stage-cleaned'].includes(input.boundary)&&point==='grant-schedule/written')throw Error('TEMP_PUBLICATION_FAILURE');
 if(point===input.boundary){process.stdout.write(JSON.stringify({abrupt:true,boundary:point,pid:process.pid,path})+'\n');process.exit(73);}};
if(input.boundary==='grant/before-stage-cleanup'||input.boundary==='grant/stage-cleaned'){
 const era=executionEraStartup(input.paths.ledger),options={authority:owner.executionOwnership,durability:writer.durability};
 const first=await issueEraEntry(era,input.event.id,options);
 const path=era.directory+'/grant-'+first.incarnationId+'.json';assertNativeTestTarget(path+'.stage');
 await writeFile(path+'.stage',await readFile(path));await writer.durability.syncFile(path+'.stage');
 await issueEraEntry(era,input.event.id,{...options,hook});
}else{
 owner.scheduler.store.eraGrantHook=hook;
 const result=await owner.scheduler.store.insert(input.event,owner.scheduler.store.getSnapshot().revision);
 if(!result.ok)throw Error(result.code);
}
throw Error('GRANT_ABRUPT_BOUNDARY_NOT_REACHED');
