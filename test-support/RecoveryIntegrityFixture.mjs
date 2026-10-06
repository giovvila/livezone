import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {seedMigration,HEAD} from './CleanLedgerMigrationFixture.mjs';
import {paths,capture} from '../server/recovery/RecoveryContract.js';
import {RecoveryWorkflow} from '../server/recovery/RecoveryWorkflow.js';
import {recordFor} from '../server/program-output/DurableProgramContract.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
import Repository from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import {ledgerAuthority} from '../server/recovery/RestoreLedgerAuthority.js';
import {lineageContext,phaseRecord} from '../server/recovery/RecoveryLineage.js';
import {artifact} from '../server/recovery/RecoveryContract.js';
export const save=(path,value)=>writeFile(path,JSON.stringify(value));
export async function recoveryIntegrityFixture(t,{unicode=''}={}){
    const root=await mkdtemp(join(tmpdir(),'lz-r10-integrity-'+unicode)),p=paths(root);
    t.after(async()=>{const child=relative(tmpdir(),root);if(!child.startsWith('lz-r10-integrity-')||child.startsWith('..')||isAbsolute(child))throw Error('UNSAFE_TEMP_CLEANUP');await rm(root,{recursive:true,force:true});});
    await mkdir(dirname(p.schedule),{recursive:true});
    await mkdir(p.mediaRoot,{recursive:true});
    const service={Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',PathName:join(root,'ops/LivezoneNode.exe'),StartName:'LocalSystem',DelayedPresent:true,DelayedValue:1};
    const original={...service,StartMode:'Auto'};let restoreCalls=0;
    const host={inspect:async()=>({root,head:HEAD,branch:'build/1003.9A1',administrator:true,service:{...service},media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},bootstrapPermission:false,proof:{absent:true},ports:[]}),
        proveOffline:async()=>({absent:true}),reserve:async()=>()=>{},restore:async value=>{restoreCalls++;Object.assign(service,value);}};
    const {migration,snapshot}=await seedMigration(root,{path:p.ledger,authorityPath:p.authority,scheduledPath:p.scheduled,host});
    await save(p.maintenance,{Version:1,Repository:root,Head:HEAD,CapturedAt:'2026-10-02T00:00:00.000Z',Original:original});
    await save(p.auto,{version:1,revision:7,enabled:true,armed:false,sourceId:'camera',updatedAt:'2026-10-02T00:00:00.000Z',migration:null});
    await save(p.schedule,{version:2,revision:1,events:[],programPlan:{version:1,timezone:'Europe/Rome',items:[]}});
    const envelope=createProgramOutputEnvelope({version:1,publisherSessionId:'fixture',revision:1,publishedAt:'2026-10-02T00:00:00.000Z',committedAt:'2026-10-02T00:00:00.000Z',scene:null,source:null,playback:{initialTime:0,duration:120,playing:false,ended:false,state:'paused',startedAt:'2026-10-02T00:00:00.000Z'},graphics:{items:[]},transition:{type:'cut',durationMs:0}});
    await save(p.program,recordFor({envelope,retiredPublisherSessions:[],identity:{sourceFingerprint:null,catalog:null,assets:[]},generation:8,authorityEpoch:20}));
    const w=new RecoveryWorkflow({root,runId:'integrity',host,expectedHead:HEAD});
    return {root,p,w,host,service,original,migration,snapshot,restoreCalls:()=>restoreCalls,
        async seedAudit(){await save(w.audit,{version:1,root,head:HEAD,branch:'build/1003.9A1',runId:w.runId,authorizeLegacy:false,original,before:await capture(p)});}};
}
export async function completedIntegrityFixture(t){
    const h=await recoveryIntegrityFixture(t);await h.migration.start();await h.seedAudit();
    const before=await capture(h.p);
    const context=await lineageContext(h.w);let predecessor;
    const phase=async(name,value)=>{await save(h.w.audit+'.'+name,phaseRecord(context,name,predecessor,value));predecessor=await artifact(h.w.audit+'.'+name);};
    await phase('prepared',{state:'PREPARED_FOR_EXPLICIT_DISARM',head:HEAD});
    await phase('disarm',{state:'PREPARED',action:'EXPLICIT_OFFLINE_DISARM',expectedHash:before.auto.hash,plannedAfterHash:before.auto.hash});
    await phase('disarm.completed',{state:'COMPLETED',beforeHash:before.auto.hash,afterHash:before.auto.hash});
    const repo=new Repository({path:h.p.ledger,authority:{authorityEpoch:21,authorityProcessSession:'r10-ready'}});
    await save(h.p.authority,{epoch:21});await repo.initialize();
    if(repo.status!=='READY')throw Error(repo.error);
    try{
        const anchor=await ledgerAuthority(h.w,{allowOwner:true});
        await phase('start',{version:1,state:'START_RESERVED',head:HEAD,bootstrap:false,ledgerProtocolVersion:2,migrationTransactionId:anchor.transactionId,before});
        await phase('ready',{ready:true,pid:process.pid,epoch:21,head:HEAD,root:h.root,recoveryRunId:h.w.runId,ledgerHash:anchor.canonicalHash,ledgerProtocolVersion:2,migrationTransactionId:anchor.transactionId,ledgerAuthority:anchor});
    }finally{await repo.close();}
    return h;
}
