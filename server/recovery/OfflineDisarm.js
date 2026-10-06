import {rename} from 'node:fs/promises';
import AutoLiveStore from '../autolive/AutoLiveStore.js';
import {normalizeConfig} from '../autolive/AutoLiveContract.js';
import {acquireMaintenanceGate} from '../autolive/AuthorityMaintenanceGate.js';
import {artifact,exclusive,writeOnce,same,fail} from './RecoveryContract.js';
import {digest} from '../scheduler/ScheduledExecutionProvenance.js';

// Explicit operation; no reconciler imports or calls it as a side effect.
export async function offlineDisarm({path,authorityPath,audit,expectedRevision,expectedHash,authorize,
    proveOffline,reserve,hook=()=>{},lineage}){
    if(authorize!==true)fail('EXPLICIT_DISARM_AUTHORIZATION_REQUIRED');
    const proof=async()=>{if((await proveOffline()).absent!==true)fail('CANONICAL_OFFLINE_PROOF_REQUIRED');};
    await proof();const gate=await acquireMaintenanceGate(authorityPath);let release,store;
    try{
        release=await reserve();await proof();
        if(lineage)await lineage.recheck();
        if(await artifact(authorityPath+'.lock'))fail('AUTHORITY_LOCK_REMAINS');
        let prepared=(await artifact(audit))?.value;
        const current=await artifact(path);
        if(!prepared){
            const before=normalizeConfig(current?.value);
            if(current.hash!==expectedHash||before.revision!==expectedRevision)fail('STALE_AUTOLIVE_EVIDENCE');
            const at=new Date().toISOString();
            const after=before.armed?normalizeConfig({...before,armed:false,revision:before.revision+1,updatedAt:at}):before;
            const plannedAfterHash=before.armed?digest(JSON.stringify(after)+'\n'):expectedHash;
            prepared={version:1,state:'PREPARED',action:'EXPLICIT_OFFLINE_DISARM',path,authorityPath,expectedRevision,expectedHash,plannedAfterHash,at,before,after};
            if(lineage)prepared=lineage.record('disarm',prepared);
            await exclusive(audit,prepared);
        }else if(prepared.state!=='PREPARED'||prepared.action!=='EXPLICIT_OFFLINE_DISARM'||prepared.path!==path||
            prepared.authorityPath!==authorityPath||prepared.expectedRevision!==expectedRevision||prepared.expectedHash!==expectedHash)
            fail('DISARM_AUDIT_CONFLICT');
        if(lineage)await lineage.validate('disarm');
        const planHash=(await artifact(audit)).hash;
        const recheck=async()=>{
            if((await artifact(audit))?.hash!==planHash)fail('DISARM_AUDIT_CONFLICT');
            if(lineage){await lineage.recheck();await lineage.validate('disarm');}
        };
        const original=normalizeConfig(prepared.before);
        const intended=original.armed?normalizeConfig({...original,armed:false,revision:original.revision+1,updatedAt:prepared.at}):original;
        if(original.revision!==expectedRevision||!same(intended,prepared.after)||
            prepared.plannedAfterHash!==(original.armed?digest(JSON.stringify(intended)+'\n'):expectedHash))fail('DISARM_AUDIT_CONFLICT');
        await hook('prepared');
        await recheck();
        const fresh=await artifact(path);
        if(fresh.hash===expectedHash){
            if(!same(fresh.value,prepared.before))fail('DISARM_AUDIT_CONFLICT');
            if(prepared.before.armed){
                store=new AutoLiveStore({path,clock:()=>Date.parse(prepared.at),fileOperations:{rename:async(from,to)=>{
                    await proof();if((await artifact(path))?.hash!==expectedHash||await artifact(authorityPath+'.lock'))fail('STALE_AUTOLIVE_EVIDENCE');
                    await recheck();
                    await rename(from,to);
                }}});
                await store.initialize();const after=await store.patch({armed:false},expectedRevision);
                if(!same(after,prepared.after))fail('DISARM_RESULT_MISMATCH');
            }
        }else if(fresh.hash!==prepared.plannedAfterHash||!same(fresh.value,prepared.after)||prepared.before.armed!==true)fail('STALE_AUTOLIVE_EVIDENCE');
        await hook('disarmed');await proof();
        const after=await artifact(path);
        if(after.hash!==prepared.plannedAfterHash||!same(after.value,prepared.after)||after.value.armed!==false||after.value.sourceId!==prepared.before.sourceId||
            after.value.enabled!==prepared.before.enabled)fail('DISARM_RESULT_MISMATCH');
        let result={state:'COMPLETED',beforeHash:expectedHash,afterHash:after.hash,beforeRevision:expectedRevision,afterRevision:after.value.revision,sourceId:after.value.sourceId};
        await recheck();
        if(lineage)result=await lineage.completion(result);
        await writeOnce(audit+'.completed',result);return result;
    }finally{if(store)await store.close();if(release)await release();await gate();}
}
