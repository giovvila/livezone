// Explicit test preload, never imported by production. Only guarded TEMP roots.
import {readOnlyFilesystemObserver} from './ReadOnlyFilesystemObserver.js';
const observer=readOnlyFilesystemObserver();
const {readFileSync}=await import('node:fs');
const {join}=await import('node:path');
const {registerNativeTestRoot}=await import('./NativeTempGuard.mjs');
const {NewEraRecoveryWorkflow}=await import('../server/recovery/NewEraRecoveryWorkflow.js');
const {verifyPermanentCapability}=await import('../server/recovery/PermanentCapabilityContract.js');
const {approvedPermanentProofHash}=await import('../server/recovery/PermanentCapabilityApproval.js');
const input=JSON.parse(readFileSync(process.env.LIVEZONE_READ_ONLY_CLI_FIXTURE));
registerNativeTestRoot(input.root);
const manifest=JSON.parse(readFileSync(join(input.proof,'manifest.json')));
const original=NewEraRecoveryWorkflow.prototype.startReview;
NewEraRecoveryWorkflow.prototype.startReview=async function(){
    if(this.writer.root!==input.root)throw Error('READ_ONLY_CLI_FIXTURE_ROOT_MISMATCH');
    this.writer.host={inspect:async()=>({service:{StartName:'LocalSystem'}})};
    this.writer.verifyRuntimeCapability=(directory,options)=>verifyPermanentCapability(directory,{...options,approvalHash:approvedPermanentProofHash,
        compatibility:{machine:manifest.machine,volume:{volume:manifest.volume,volumeSerial:manifest.volumeSerial,filesystem:'NTFS',local:true}}});
    this.writer.native={capability:()=>{observer.event('native');observer.event('directorySync');throw Error('FORBIDDEN_CLI_NATIVE_EXERCISE');}};
    this.verifyCapabilityStorage=()=>({testDouble:true,volume:manifest.volume});
    observer.enable();try{const result=await original.call(this);return {...result,testObservation:{...observer.counts}};}
    finally{observer.disable();observer.restore();}
};
