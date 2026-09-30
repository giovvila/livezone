import {readFile,lstat,open} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {digest,repositoryIdentity,validateLock} from '../scheduler/ScheduledExecutionProvenance.js';
import {normalizeConfig} from '../autolive/AutoLiveContract.js';
import {normalizeSchedule} from '../scheduler/ScheduleContract.js';
import {identityForScheduledEvent} from '../scheduler/ScheduledEventIdentity.js';
import {validateLedgerSnapshot} from '../scheduler/ScheduledEntryLedgerContract.js';
import {validateRecord,canonical} from '../program-output/DurableProgramContract.js';

export const BRANCH='build/1003.9A1';
export const fail=code=>{throw Object.assign(Error(code),{code});};
// Explicit operator approval, never inferred from observed Git or maintenance history.
export function recoveryIdentity(expectedHead){
    if(typeof expectedHead!=='string'||!/^[a-f0-9]{40}$/i.test(expectedHead))fail('EXPLICIT_RECOVERY_HEAD_REQUIRED');
    return Object.freeze({branch:BRANCH,head:expectedHead.toLowerCase()});
}
export function assertRepository(h,root,expected){
    if(!expected||expected.branch!==BRANCH||!/^[a-f0-9]{40}$/.test(expected.head||''))fail('EXPLICIT_RECOVERY_HEAD_REQUIRED');
    if(h.branch!==expected.branch||h.head!==expected.head||
        typeof h.root!=='string'||!isAbsolute(h.root)||repositoryIdentity(h.root)!==repositoryIdentity(root))fail('REPOSITORY_BRANCH_HEAD_MISMATCH');
}
export const same=(a,b)=>canonical(a)===canonical(b);
export function paths(root){
    root=resolve(root);const studio=join(root,'var/studio-state/state.json');
    const auto=studio+'.autolive.json',authority=auto+'.execution',scheduled=studio+'.scheduled-live-execution.json',ledger=studio+'.scheduled-entry-ledger.json';
    return {root,studio,auto,authority,authorityLock:authority+'.lock',gate:authority+'.maintenance',
        scheduled,scheduledLock:scheduled+'.lock',ledger,ledgerLock:ledger+'.lock',marker:ledger+'.bootstrap',
        schedule:join(root,'var/scheduler/schedule.json'),program:studio+'.program-output.json',
        maintenance:join(root,'var/authority-maintenance-service.json'),mediaRoot:join(root,'var/media-library'),
        mediaManifest:join(root,'var/media-library/assets.json'),mediaDelete:join(root,'var/media-library/delete-journal.json')};
}
export async function artifact(path){
    try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)fail('ORDINARY_RECOVERY_FILE_REQUIRED');
        const bytes=await readFile(path);let value;try{value=JSON.parse(bytes);}catch{value={invalidJSON:true};}
        return {hash:digest(bytes),value};
    }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export const evidenceKeys=['auto','authority','authorityLock','gate','scheduled','scheduledLock','schedule','ledger','ledgerLock','marker','program','maintenance','mediaManifest','mediaDelete'];
export async function capture(p){return Object.fromEntries(await Promise.all(evidenceKeys.map(async key=>[key,await artifact(p[key])])));}
export async function exclusive(path,value){const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}}
export async function writeOnce(path,value){const saved=await artifact(path);if(saved){if(!same(saved.value,value))fail('AUDIT_CONFLICT');return;}await exclusive(path,value);}
const repoEqual=(a,b)=>typeof a==='string'&&isAbsolute(a)&&repositoryIdentity(a)===repositoryIdentity(b);
export function classifyMaintenance(record,service,root){
    const valid=s=>s?.Name==='LivezoneNode'&&s.State==='Stopped'&&['Auto','Manual','Disabled'].includes(s.StartMode)&&
        typeof s.PathName==='string'&&s.PathName.length>0&&typeof s.StartName==='string'&&s.StartName.length>0&&
        typeof s.DelayedPresent==='boolean'&&[0,1].includes(s.DelayedValue)&&(!s.DelayedPresent?s.DelayedValue===0:true);
    if(!valid(service)||service.StartMode!=='Disabled')return 'CONFLICT';
    if(!record)return 'NEW_MAINTENANCE';
    if(record.Version!==1||!repoEqual(record.Repository,root)||!valid(record.Original)||
        !/^[a-f0-9]{40}$/i.test(record.Head||'')||!Number.isFinite(Date.parse(record.CapturedAt))||
        record.Original.PathName!==service.PathName||record.Original.StartName!==service.StartName)return 'CONFLICT';
    return 'ADOPTED_MAINTENANCE';
}
export function scheduledClassification(e,p){
    if(!e.scheduledLock)return 'ABSENT';
    try{const result=validateLock(e.scheduledLock.value,repositoryIdentity(p.scheduled));
        return result==='LEGACY_UNVERIFIABLE'&&e.scheduled?'LEGACY_JOURNAL_REVIEW_REQUIRED':result;
    }catch(error){return error.code||'INVALID_LOCK';}
}
export function bootstrapPlan(e,authorize=false){
    if(e.ledgerLock)fail('LEDGER_LOCK_REQUIRES_REVIEW');
    if(!e.ledger&&e.marker)fail('MARKER_ONLY_BOOTSTRAP_REVIEW_REQUIRED');
    if(e.ledger){validateLedgerSnapshot(e.ledger.value);if(!e.marker)fail('BOOTSTRAP_MARKER_MISSING');
        if(e.marker.value.version!==1||!Number.isSafeInteger(e.marker.value.authorityEpoch)||e.marker.value.authorityEpoch<1||e.marker.value.authorityEpoch>e.authority.value.epoch)fail('BOOTSTRAP_MARKER_INCONSISTENT');
        return false;
    }
    if(e.scheduled)fail('EXECUTION_JOURNAL_BOOTSTRAP_CONFLICT');
    if(e.schedule?.value.version===3&&e.schedule.value.events.some(e=>e.type==='source.live'&&!e.entryMigration))fail('BOOTSTRAP_MIGRATION_METADATA_REQUIRED');
    if(!authorize)fail('EXPLICIT_BOOTSTRAP_AUTHORIZATION_REQUIRED');
    return true;
}
export function verifyMigration(before,after,{earliest,latest}={}){
    before=normalizeSchedule(before);after=normalizeSchedule(after);
    if(after.version!==3)fail('SCHEDULE_V3_REQUIRED');
    if(before.version===3){if(!same(before,after))fail('SCHEDULE_CHANGED_DURING_START');return true;}
    if(before.version!==2||after.revision!==before.revision+1||after.events.length!==before.events.length)fail('MIGRATION_REVISION_MISMATCH');
    const cutoff=after.liveIdentityMigration?.cutoffAt;
    if(after.liveIdentityMigration?.version!==1||!Number.isFinite(Date.parse(cutoff))||
        (earliest&&cutoff<earliest)||(latest&&cutoff>latest))fail('MIGRATION_CUTOFF_INVALID');
    for(const old of before.events){const event=after.events.find(e=>e.id===old.id);if(!event)fail('MIGRATION_EVENT_MISSING');
        if(old.type==='source.live'){
            identityForScheduledEvent(event);const m=event.entryMigration;
            if(event.entryRevision!==1||m?.cutoffAt!==cutoff||m.originalStartAt!==old.startAt||m.originalEndAt!==old.endAt||
                m.disposition!==(Date.parse(old.startAt)<=Date.parse(cutoff)?'EXCLUDED':'FUTURE'))fail('MIGRATION_CLASSIFICATION_INVALID');
            const {incarnationId,entryRevision,entryMigration,...rest}=event;if(!same(rest,old))fail('MIGRATION_EVENT_CHANGED');
        }else if(!same(old,event))fail('MIGRATION_EVENT_CHANGED');
    }
    if(!same(before.programPlan,after.programPlan))fail('MIGRATION_PROGRAM_PLAN_CHANGED');
    return true;
}
// Read-only in-process surface. No HTTP endpoint, credentials or status-file trust.
export function runtimeStatus(owner){
    const a=owner.executionOwnership,l=owner.scheduledEntry?.ledger;
    return {pid:process.pid,authority:a?.snapshot(),restartBlocked:a?.restartBlocked,
        scheduled:{status:owner.scheduledLiveExecutionRepository?.status,owner:owner.scheduledLiveExecutionRepository?.owner},
        schedule:{status:owner.scheduler?.store.status,value:owner.scheduler?.store.getSnapshot()},
        ledger:{status:l?.status,snapshot:l?.snapshot,lockOwner:l?.lockOwner},
        auto:owner.autoLive?.store.getSnapshot(),program:{status:owner.durableProgram?.status,record:owner.durableProgram?.record,current:owner.store?.getCurrent()},
        diagnostics:owner.scheduledEntry?.diagnostics()};
}
export function verifyReadiness({before,after,runtime,processes,ports,service,startedAt,now=new Date().toISOString(),bootstrap}){
    const a=runtime?.authority,lock=after.authorityLock?.value;
    if(!a?.available||service?.State!=='Stopped'||service.StartMode!=='Disabled'||
        !Array.isArray(processes)||processes.filter(p=>p.pid===runtime.pid).length!==1||processes.some(p=>p.blocks&&p.pid!==runtime.pid)||
        !Array.isArray(ports)||!ports.length||ports.some(p=>p.OwningProcess!==runtime.pid)||
        lock?.pid!==runtime.pid||lock.authorityProcessSession!==a.authorityProcessSession||
        after.authority?.value.epoch!==a.authorityEpoch||a.authorityEpoch!==before.authority.value.epoch+1)fail('CURRENT_UNIQUE_AUTHORITY_REQUIRED');
    const sl=after.scheduledLock?.value;
    if(runtime.scheduled?.status!=='READY'||!same(sl,runtime.scheduled.owner)||sl?.processId!==runtime.pid||
        sl.authorityEpoch!==a.authorityEpoch||sl.authorityProcessSession!==a.authorityProcessSession||after.scheduled)fail('SCHEDULED_REPOSITORY_NOT_READY');
    if(runtime.schedule?.status!=='READY'||!same(runtime.schedule.value,after.schedule?.value))fail('SCHEDULE_NOT_READY');
    verifyMigration(before.schedule.value,after.schedule.value,{earliest:startedAt,latest:now});
    const ledger=validateLedgerSnapshot(after.ledger?.value),ll=after.ledgerLock?.value,marker=after.marker?.value;
    if(runtime.ledger?.status!=='READY'||!same(ledger,runtime.ledger.snapshot)||!same(ll,runtime.ledger.lockOwner)||
        ll?.version!==1||ll.pid!==runtime.pid||typeof ll.processSession!=='string'||!ll.processSession||
        marker?.version!==1||!Number.isSafeInteger(marker.authorityEpoch)||marker.authorityEpoch<1||
        marker.authorityEpoch>a.authorityEpoch||(bootstrap&&marker.authorityEpoch!==a.authorityEpoch))fail('LEDGER_BOOTSTRAP_NOT_READY');
    if(bootstrap&&(ledger.generation!==0||ledger.entries.length))fail('UNEXPECTED_ENTRY_CONSUMPTION');
    if(!bootstrap&&(after.ledger.hash!==before.ledger.hash||after.marker.hash!==before.marker.hash))fail('LEDGER_HISTORY_CHANGED');
    const config=normalizeConfig(after.auto?.value);
    if(config.armed!==false||after.auto.hash!==before.auto.hash||!same(config,runtime.auto))fail('AUTOLIVE_NOT_DELIBERATELY_DISARMED');
    const program=validateRecord(after.program?.value);
    if(after.program.hash!==before.program.hash||runtime.program?.status!==program.programState||
        !same(program,runtime.program.record)||!same(program.envelope,runtime.program.current))fail('RETAINED_PROGRAM_NOT_PRESERVED');
    if(runtime.restartBlocked!==true||a.reason!=='RESTART_RECONCILIATION_REQUIRED'||!Array.isArray(runtime.diagnostics)||!runtime.diagnostics.length)fail('RESTART_DIAGNOSTICS_REQUIRED');
    return {ready:true,pid:runtime.pid,epoch:a.authorityEpoch,restartReconciliationRequired:true,diagnostics:runtime.diagnostics};
}
export function assertRestore(e,{record,service,root,bootstrapPermission=false}){
    if(classifyMaintenance(record,service,root)!=='ADOPTED_MAINTENANCE')fail('RESTORE_MAINTENANCE_CONFLICT');
    if(bootstrapPermission||['authorityLock','scheduledLock','ledgerLock','gate'].some(k=>e[k]))fail('RESTORE_OWNER_OR_LOCK_REMAINS');
    if(!e.ledger&&e.marker)fail('MARKER_ONLY_BOOTSTRAP_REVIEW_REQUIRED');
    if(e.ledger)bootstrapPlan(e,false);
    return record.Original;
}
