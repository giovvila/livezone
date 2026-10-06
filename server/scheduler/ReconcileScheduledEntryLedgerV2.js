// Module only. No CLI, automatic lock breaking, or legacy authorization bypass.
import {open,realpath} from 'node:fs/promises';
import {createLedgerV2Durability} from './LedgerV2Durability.js';
import {dirname,resolve,isAbsolute} from 'node:path';
import {proveWindowsOffline} from '../autolive/ReconcileAuthorityLock.js';
import {acquireMaintenanceGate} from '../autolive/AuthorityMaintenanceGate.js';
import {reserve8080} from '../recovery/WindowsRecoveryHost.js';
import {repositoryIdentity,validateLock,journalMatchesLock,completedScheduledHistory,assertScheduledTerminalNamespace} from './ScheduledExecutionProvenance.js';
import {append,directorySync,equal,fail,hash,inspectV2,ordinary,recoverV2,terminalShutdown,validateV2Lock} from './ScheduledEntryLedgerV2Protocol.js';
import {readEvidence} from '../recovery/PersistentEvidence.js';

const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const sha=bytes=>bytes===null?null:hash(bytes);
const terminalReason=reason=>['TERMINAL_SHUTDOWN_ORPHAN','TERMINAL_LEDGER_WITH_COMPLETED_SCHEDULED_HISTORY'].includes(reason);
export async function ledgerRecoveryEvidence({path,authorityPath,scheduledPath}) {
    const names={lock:path+'.lock',ledger:path,wal:path+'.wal',marker:path+'.bootstrap',authority:authorityPath,
        authorityLock:authorityPath+'.lock',scheduled:scheduledPath,scheduledLock:scheduledPath+'.lock'};
    const captures=await Promise.all(Object.entries(names).map(async([key,p])=>[key,await readEvidence(p,{optional:true,
        ordinaryError:'LEDGER_V2_ORDINARY_FILE_REQUIRED'})]));
    return {bytes:Object.fromEntries(captures.map(([key,e])=>[key,e?.text??null])),
        hashes:Object.fromEntries(captures.map(([key,e])=>[key,e?.sha256??null]))};
}
export async function reconcileScheduledEntryLedgerV2({path,authorityPath,scheduledPath,operationId,expected,
    proveOffline=proveWindowsOffline,reserve=reserve8080,isAlive=alive,syncDirectory=directorySync,hook=()=>{}}) {
    if(![path,authorityPath,scheduledPath].every(p=>typeof p==='string'&&isAbsolute(p)) ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(operationId??'') || !expected)fail('LEDGER_V2_RECOVERY_IDENTITY_REQUIRED');
    [path,authorityPath,scheduledPath]=[path,authorityPath,scheduledPath].map(p=>resolve(p));
    if(new Set([path,authorityPath,scheduledPath]).size!==3)fail('LEDGER_V2_DISTINCT_PATHS_REQUIRED');
    for(const p of [path,authorityPath,scheduledPath])if(repositoryIdentity(await realpath(dirname(p)))!==repositoryIdentity(dirname(p)))fail('LEDGER_V2_ALIASED_PATH');
    const proof=async()=>{
        const p=await proveOffline();
        if(p.absent!==true || !Array.isArray(p.services) || p.services.length!==1 ||
            p.services[0].State!=='Stopped' || p.services[0].StartMode!=='Disabled')fail('LEDGER_V2_CANONICAL_OFFLINE_PROOF_REQUIRED');
        return p;
    };
    await proof();
    const initial=await ordinary(path+'.lock',{optional:true});
    if(initial && JSON.parse(initial).version===1)fail('LEGACY_LEDGER_LOCK_UNVERIFIABLE');
    // Do not equate successful file fsync with durable namespace mutation.
    // Injectable only for isolated storage/proof fixtures, not an operator flag.
    if(syncDirectory(path)!=='DIRECTORY_SYNCED')fail('LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN');
    const durability=createLedgerV2Durability({syncDirectory});
    for(const p of [path,authorityPath,scheduledPath])durability.sync(p);
    const releaseGate=await acquireMaintenanceGate(authorityPath,{durability});let releasePort;
    const audit=path+'.recovery-'+operationId+'.json',archive=path+'.lock.reconciled-'+operationId;
    const save=async(p,value)=>{
        const f=await open(p,'wx',0o600);try{await f.writeFile(JSON.stringify(value)+'\n');await f.sync();}finally{await f.close();}
        if(syncDirectory(p)!=='DIRECTORY_SYNCED')fail('LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN');
    };
    try {
        releasePort=await reserve();const census=await proof();
        const observed=await ledgerRecoveryEvidence({path,authorityPath,scheduledPath});
        const archived=await ordinary(archive,{optional:true});
        if((observed.bytes.lock===null)===(archived===null))fail('LEDGER_V2_LOCK_ARCHIVE_AMBIGUOUS');
        const lockBytes=observed.bytes.lock??archived,lock=validateV2Lock(JSON.parse(lockBytes),path);
        if(isAlive(lock.pid))fail('LEDGER_V2_OWNER_ALIVE_OR_AMBIGUOUS');
        const originalAudit=await ordinary(audit,{optional:true});
        const saved=originalAudit===null?null:JSON.parse(originalAudit);
        if(saved && (!equal(saved.expected,expected)||saved.path!==path||saved.authorityPath!==authorityPath||
            saved.scheduledPath!==scheduledPath||saved.operationId!==operationId||saved.archive!==archive||saved.lockBytes!==lockBytes))
            fail('LEDGER_V2_AUDIT_MISMATCH');
        const reviewed=saved?.expected??observed.hashes;
        if(!saved && (archived!==null||!equal(expected,reviewed)))fail('LEDGER_V2_EXPECTED_EVIDENCE_MISMATCH');
        if(saved && (sha(lockBytes)!==expected.lock || !observed.bytes.wal?.startsWith(saved.walBytes)))fail('LEDGER_V2_RETRY_EVIDENCE_MISMATCH');
        for(const k of ['marker','authority','authorityLock','scheduled','scheduledLock'])
            if(observed.hashes[k]!==expected[k])fail('LEDGER_V2_PROVENANCE_CHANGED');
        let state=await inspectV2(path);
        const lastOwner=state.records.filter(r=>r.type==='BEGIN').at(-1)?.data;
        if(!equal(lastOwner,lock)||state.current.ledgerId!==lock.ledgerId)fail('LEDGER_V2_LOCK_PROVENANCE_MISMATCH');
        const terminal=terminalShutdown(state,lock);
        if(terminalReason(saved?.reason)&&(!terminal||observed.hashes.ledger!==expected.ledger||observed.hashes.wal!==expected.wal))fail('LEDGER_V2_TERMINAL_CHANGED');
        const marker=JSON.parse(observed.bytes.marker),authority=JSON.parse(observed.bytes.authority),al=JSON.parse(observed.bytes.authorityLock),sl=JSON.parse(observed.bytes.scheduledLock);
        if(marker?.version!==1||!Number.isSafeInteger(marker.authorityEpoch)||marker.authorityEpoch<1||marker.authorityEpoch>lock.authorityEpoch)
            fail('LEDGER_V2_MARKER_INVALID');
        if(authority?.epoch!==lock.authorityEpoch||((!terminal||al!==null)&&(al?.pid!==lock.pid||al.authorityProcessSession!==lock.authorityProcessSession)))
            fail('LEDGER_V2_AUTHORITY_MISMATCH');
        let scheduledHistory=null;
        if(terminal){await assertScheduledTerminalNamespace(scheduledPath);}
        if(terminal&&sl===null){
            scheduledHistory=completedScheduledHistory(observed.bytes.scheduled,{scheduledPath,authorityPath,ledgerLock:lock});
        }else{
            if(validateLock(sl,repositoryIdentity(scheduledPath))!=='VERIFIABLE'||sl.processId!==lock.pid||sl.authorityEpoch!==lock.authorityEpoch||
                sl.authorityProcessSession!==lock.authorityProcessSession||sl.authorityId!==repositoryIdentity(authorityPath))fail('LEDGER_V2_SCHEDULED_MISMATCH');
            journalMatchesLock(observed.bytes.scheduled,sl);
        }
        if(terminal){
            // Observing complete END bytes does not prove its producer's fsync
            // or namespace ACK returned. Establish current native durability
            // for the exact closed snapshot/WAL/owner before accepting absence.
            for(const p of [path,path+'.wal',observed.bytes.lock===null?archive:path+'.lock'])await durability.syncFile(p);
            if(scheduledHistory)await durability.syncFile(scheduledPath);
        }
        const verifyExternal=async()=>{
            await proof();if(isAlive(lock.pid))fail('LEDGER_V2_OWNER_ALIVE_OR_AMBIGUOUS');
            if(terminal)await assertScheduledTerminalNamespace(scheduledPath);
            const fresh=await ledgerRecoveryEvidence({path,authorityPath,scheduledPath});
            for(const k of ['marker','authority','authorityLock','scheduled','scheduledLock'])
                if(fresh.hashes[k]!==expected[k])fail('LEDGER_V2_EVIDENCE_RACE');
            if(terminal&&(fresh.hashes.ledger!==expected.ledger||fresh.hashes.wal!==expected.wal))fail('LEDGER_V2_TERMINAL_CHANGED');
            if(await ordinary(observed.bytes.lock===null?archive:path+'.lock')!==lockBytes)fail('LEDGER_V2_EVIDENCE_RACE');
            return fresh;
        };
        const reason=terminal?(scheduledHistory?'TERMINAL_LEDGER_WITH_COMPLETED_SCHEDULED_HISTORY':'TERMINAL_SHUTDOWN_ORPHAN'):state.pending?'CONSERVATIVE_CONSUMPTION':state.owner?'STABLE_ORPHAN':'CLEAN_STABLE';
        if(!saved)await save(audit,{schemaVersion:2,state:'PREPARED',path,authorityPath,scheduledPath,operationId,archive,
            expected,lockBytes,walBytes:observed.bytes.wal,reason,proof:census,at:new Date().toISOString()});
        else await durability.syncFile(audit);
        await hook('prepared');
        const fresh=await verifyExternal();
        if(fresh.hashes.ledger!==observed.hashes.ledger||fresh.hashes.wal!==observed.hashes.wal)fail('LEDGER_V2_EVIDENCE_RACE');
        state=await recoverV2(path,{hook,syncDirectory});
        if(state.owner) {
            await append(path,state.records,'END',{processSession:lock.processSession,snapshotHash:hash(state.current),recovered:true},{hook,syncDirectory});
        }
        await hook('recovered');state=await inspectV2(path);
        if(state.owner||state.pending)fail('LEDGER_V2_RECOVERY_INCOMPLETE');
        await verifyExternal();
        if(observed.bytes.lock!==null) {
            if(await ordinary(archive,{optional:true})!==null)fail('LEDGER_V2_ARCHIVE_EXISTS');
            await durability.archive(path+'.lock',archive);
        }
        await hook('archived');
        if(await ordinary(archive)!==lockBytes||await ordinary(path+'.lock',{optional:true})!==null)fail('LEDGER_V2_ARCHIVE_MISMATCH');
        await proof();
        if(terminal)await assertScheduledTerminalNamespace(scheduledPath);
        const after=await ledgerRecoveryEvidence({path,authorityPath,scheduledPath});
        for(const k of ['marker','authority','authorityLock','scheduled','scheduledLock'])
            if(after.hashes[k]!==expected[k])fail('LEDGER_V2_POST_ARCHIVE_EVIDENCE_CHANGED');
        if(terminal&&(after.hashes.ledger!==expected.ledger||after.hashes.wal!==expected.wal))fail('LEDGER_V2_TERMINAL_CHANGED');
        const finalState=await inspectV2(path);
        if(finalState.owner||finalState.pending||!equal(finalState.current,state.current))fail('LEDGER_V2_POST_ARCHIVE_EVIDENCE_CHANGED');
        const completion={schemaVersion:2,state:'COMPLETED',auditHash:(await readEvidence(audit)).sha256,archive,
            ledgerHash:(await readEvidence(path)).sha256,walHash:(await readEvidence(path+'.wal')).sha256,reason:saved?.reason??reason};
        const prior=await ordinary(audit+'.completed',{optional:true});
        if(prior===null)await save(audit+'.completed',completion);
        else if(!equal(JSON.parse(prior),completion))fail('LEDGER_V2_COMPLETION_MISMATCH');
        else await durability.syncFile(audit+'.completed');
        await hook('completed');return {audit,archive,completion:audit+'.completed',reason:completion.reason};
    } finally {if(releasePort)await releasePort();await releaseGate();}
}
