import {writeFile} from 'node:fs/promises';
import {recoveryIntegrityFixture,save} from './RecoveryIntegrityFixture.mjs';
import {envelope,seal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {repositoryIdentity} from '../server/scheduler/ScheduledExecutionProvenance.js';
import {createInitializedState} from '../server/studio/AuthoritativeStateContract.js';
import {createProgramOutputServer} from '../server/program-output-server.js';
import {RecoveryWorkflow} from '../server/recovery/RecoveryWorkflow.js';
import {HEAD} from './CleanLedgerMigrationFixture.mjs';

export function offlineWorkflow(root,p){
    let calls=0;const service={Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',PathName:p.servicePath??root+'\\ops\\LivezoneNode.exe',StartName:'LocalSystem',DelayedPresent:true,DelayedValue:1};
    const host={inspect:async()=>({root,head:HEAD,branch:'build/1003.9A1',administrator:true,service:{...service},media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},bootstrapPermission:false,proof:{absent:true},ports:[]}),proveOffline:async()=>({absent:true}),reserve:async()=>()=>{},restore:async original=>{calls++;Object.assign(service,original);}};
    return {workflow:new RecoveryWorkflow({root,runId:'integrity',host,expectedHead:HEAD}),calls:()=>calls};
}
export async function terminalShutdownFixture(t){
    const h=await recoveryIntegrityFixture(t);
    await save(h.p.ledger,envelope(h.p.ledger,h.snapshot));
    await writeFile(h.p.ledgerWal,JSON.stringify(seal({schemaVersion:2,type:'BASE',previous:null,data:{repositoryId:repositoryIdentity(h.p.ledger),snapshot:h.snapshot,namespaceDurability:'DIRECTORY_SYNCED'}}))+'\n');
    for(const key of ['ledger','ledgerWal','marker','authority'])await h.migration.durability.syncFile(h.p[key]);
    await save(h.p.studio,createInitializedState({sources:[],scenes:[],scheduler:{version:1,timezone:'Europe/Rome',items:[],enabled:false},globalOverlays:{textCrawl:null},dominantLive:{armed:false,authorizedSourceId:null}},{stateId:'r17',updatedAt:new Date().toISOString()}));
    let online=false,launches=0;const inspect=h.host.inspect;
    h.host.inspect=async()=>({...await inspect(),proof:{absent:!online,processes:[{pid:process.pid,kind:'MAINTENANCE_SELF'}]},ports:online?[{LocalPort:8080,OwningProcess:process.pid}]:[]});h.host.proveOffline=async()=>({absent:!online});
    h.launch=options=>{online=true;launches++;h.owner=createProgramOutputServer({...options,publisherToken:'r17-temp-only-publisher-token',scheduledEntryLogger:()=>{},scheduleSetTimer:()=>1,scheduleClearTimer:()=>{},mediaAssetRepository:{initialize:async()=>{},list:()=>[],get:()=>null}});return h.owner;};
    h.offline=()=>{online=false;};h.launches=()=>launches;
    await h.w.begin();await h.w.prepared();const a=await h.w.load();await h.w.disarm({authorize:true,expectedRevision:a.before.auto.value.revision,expectedHash:a.before.auto.hash});
    return h;
}
