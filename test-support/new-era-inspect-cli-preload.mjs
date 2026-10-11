// Test-only adapters. Never infer a production authorization or expected HEAD.
import {readOnlyFilesystemObserver} from './ReadOnlyFilesystemObserver.js';
const observer=readOnlyFilesystemObserver();
const {readFileSync}=await import('node:fs');
const {registerNativeTestRoot}=await import('./NativeTempGuard.mjs');
const {WindowsRecoveryHost}=await import('../server/recovery/WindowsRecoveryHost.js');
const {NewExecutionEra}=await import('../server/recovery/NewExecutionEra.js');
const input=JSON.parse(readFileSync(process.env.LIVEZONE_INSPECT_CLI_FIXTURE,'utf8'));
registerNativeTestRoot(input.root);
WindowsRecoveryHost.prototype.inspect=async function(){
    if(this.root!==input.root)throw Error('INSPECT_CLI_FIXTURE_ROOT_MISMATCH');
    return {root:input.hostRoot??input.root,head:input.hostHead,branch:input.hostBranch,administrator:true,
        service:{Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',StartName:'LocalSystem'},
        media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},ports:[],bootstrapPermission:false,proof:{absent:true}};
};
WindowsRecoveryHost.prototype.reserve=async()=>{observer.event('runtime');throw Error('FORBIDDEN_INSPECT_RESERVATION');};
NewExecutionEra.prototype.currentRuntimeProof=async function(){
    if(this.root!==input.root)throw Error('INSPECT_CLI_FIXTURE_ROOT_MISMATCH');
    if(input.missingProof)throw Object.assign(Error('LOCALSYSTEM_CAPABILITY_PROOF_REQUIRED'),{code:'LOCALSYSTEM_CAPABILITY_PROOF_REQUIRED'});
    return {proofHash:input.proofHash,testDouble:true};
};
process.once('exit',()=>{observer.disable();process.stderr.write('\nINSPECT_OBSERVATION='+JSON.stringify(observer.counts)+'\n');});
observer.enable();
