import {repositoryIdentity} from '../scheduler/ScheduledExecutionProvenance.js';
import {lstat} from 'node:fs/promises';
import {validateLedgerSnapshot} from '../scheduler/ScheduledEntryLedgerContract.js';
import {hash,equal,decodeEnvelope,parseWal,inspectV2,fail} from '../scheduler/ScheduledEntryLedgerV2Protocol.js';
import {assertMigrationStartup,migrationArtifacts,validateMigrationCompletion} from './CleanLedgerV1Migration.js';
import {readEvidence} from './PersistentEvidence.js';
import {executionEraStartup} from './ExecutionEraContract.js';

const evidence=(path,options={})=>readEvidence(path,{...options,
    ordinaryError:'LEDGER_V2_ORDINARY_FILE_REQUIRED',encodingError:'RESTORE_ENCODING_UNPROVEN'});

// The READY anchor retains the observed WAL prefix, not only a generation. A
// later closed chain must extend that exact prefix; a replacement/fork cannot
// qualify by keeping a ledger ID or copying earlier consumption records.
export async function ledgerAuthority(workflow,{allowOwner=false,storage}={}){
    const {p,migration}=workflow;
    for(const path of [p.ledger,p.ledgerWal,p.marker]){
        try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('RESTORE_ORDINARY_STORAGE_REQUIRED');}
        catch(e){if(e.code!=='ENOENT')throw e;}
    }
    const artifacts=await migrationArtifacts(p.ledger);
    const canonicalEvidence=await evidence(p.ledger,{optional:true}),walEvidence=await evidence(p.ledgerWal,{optional:true});
    const markerEvidence=await evidence(p.marker,{optional:true});
    const canonical=canonicalEvidence?.text??null,wal=walEvidence?.text??null,marker=markerEvidence?.text??null;
    const hasMigration=Object.values(artifacts).some(v=>v!==null);
    if(canonical===null){if(hasMigration||wal!==null||marker!==null)fail('RESTORE_AUTHORITATIVE_LEDGER_MISSING');return {mode:'ABSENT'};}
    const value=JSON.parse(canonical),v2=value.schemaVersion===2||wal!==null||hasMigration;
    const snapshot=v2?decodeEnvelope(p.ledger,value):validateLedgerSnapshot(value);
    if(marker===null)fail('RESTORE_BOOTSTRAP_MARKER_MISSING');
    const m=JSON.parse(marker),authority=(await evidence(p.authority,{json:true})).value;
    const era=executionEraStartup(p.ledger);
    if(era){
        if(!workflow.newEra||!equal(m,era.marker)||snapshot.ledgerId!==era.ledgerId||snapshot.executionEraId!==era.executionEraId||
            snapshot.retirementHash!==era.retirementHash||!Number.isSafeInteger(authority.epoch)||hasMigration||wal===null)
            fail('RESTORE_NEW_ERA_AUTHORITY_REQUIRED');
    }else if(m.version!==1||Object.keys(m).sort().join(',')!=='authorityEpoch,version'||!Number.isSafeInteger(m.authorityEpoch)||
        m.authorityEpoch<1||!Number.isSafeInteger(authority.epoch)||m.authorityEpoch>authority.epoch)fail('RESTORE_MARKER_INCONSISTENT');
    if(!v2)return {mode:'V1',snapshot,canonicalHash:canonicalEvidence.sha256,markerHash:markerEvidence.sha256};
    if(wal===null)fail('RESTORE_WAL_MISSING');
    let transactionId=null;
    if(hasMigration){
        await assertMigrationStartup(p.ledger);
        transactionId=validateMigrationCompletion(p.ledger,JSON.parse(artifacts.intent),JSON.parse(artifacts.activated),JSON.parse(artifacts.completed)).transactionId;
    }
    const state=await inspectV2(p.ledger);
    if(state.pending||!equal(snapshot,state.current)||(!allowOwner&&state.owner))fail('RESTORE_LEDGER_TRANSACTION_UNRESOLVED');
    if(state.base.ledgerId!==snapshot.ledgerId||state.records[0].data.namespaceDurability!=='DIRECTORY_SYNCED')fail('RESTORE_LEDGER_DURABILITY_UNPROVEN');
    return {mode:'V2',schemaVersion:2,path:p.ledger,repositoryId:repositoryIdentity(p.ledger),snapshot,
        canonicalHash:canonicalEvidence.sha256,walBytes:wal,walHash:walEvidence.sha256,markerHash:markerEvidence.sha256,transactionId,
        ...(era?{executionEraId:era.executionEraId,transitionId:era.transitionId,retirementHash:era.retirementHash}:{}),
        storage:era?(storage?storage():workflow.writer.native.capability((await import('node:path')).dirname(p.ledger))):await migration.storage()};
}

export async function verifyRestoreAuthority(workflow,{audit,ready,start,evidence}){
    const current=await ledgerAuthority(workflow);
    if(current.mode==='ABSENT'){
        if(audit.before.ledger||audit.before.ledgerWal||audit.before.marker||ready||start)fail('RESTORE_HISTORY_MISSING');
        return current; // Configuration-only cancellation before any bootstrap.
    }
    if(current.mode==='V1'){
        const before=audit.before.ledger?.value;
        const anchor=ready?.ledgerAuthority;
        if(!before&&ready?.ready&&ready.head===workflow.expected.head&&ready.recoveryRunId===workflow.runId&&ready.root===workflow.p.root&&
            start?.head===ready.head&&start.bootstrap===true&&anchor?.mode==='V1'&&ready.ledgerHash===anchor.canonicalHash&&
            equal(current.snapshot,validateLedgerSnapshot(anchor.snapshot))&&current.canonicalHash===anchor.canonicalHash&&current.markerHash===anchor.markerHash)return current;
        if(!before||before.schemaVersion!==1||current.canonicalHash!==audit.before.ledger.hash||current.markerHash!==audit.before.marker?.hash)
            fail('RESTORE_LEGACY_HISTORY_CHANGED');
        return current;
    }
    const anchor=ready?.ledgerAuthority;
    if(!ready?.ready||ready.head!==workflow.expected.head||ready.recoveryRunId!==workflow.runId||ready.root!==workflow.p.root||
        start?.version!==1||start.state!=='START_RESERVED'||start.head!==ready.head||anchor?.mode!=='V2'||anchor.schemaVersion!==2||anchor.path!==workflow.p.ledger||
        anchor.repositoryId!==current.repositoryId||ready.ledgerHash!==anchor.canonicalHash||anchor.walHash!==hash(anchor.walBytes)||
        ready.ledgerProtocolVersion!==2||ready.migrationTransactionId!==(anchor.transactionId??undefined)||
        (anchor.transactionId!==null&&start.migrationTransactionId!==anchor.transactionId))fail('RESTORE_READY_LEDGER_EVIDENCE_REQUIRED');
    validateLedgerSnapshot(anchor.snapshot);
    const anchored=parseWal(workflow.p.ledger,anchor.walBytes);
    if(anchored.pending||!anchored.owner||anchored.owner.pid!==ready.pid||anchored.owner.authorityEpoch!==ready.epoch||
        !equal(anchored.current,anchor.snapshot)||anchor.repositoryId!==repositoryIdentity(workflow.p.ledger)||
        current.snapshot.ledgerId!==anchor.snapshot.ledgerId||current.snapshot.generation<anchor.snapshot.generation||
        !current.walBytes.startsWith(anchor.walBytes)||current.markerHash!==anchor.markerHash||current.transactionId!==anchor.transactionId||
        !equal(current.storage,anchor.storage)||anchor.snapshot.entries.some(old=>!current.snapshot.entries.some(entry=>equal(old,entry))))
        fail('RESTORE_LEDGER_SUCCESSOR_UNPROVEN');
    if(start.bootstrap){
        if(start.before?.ledger||start.before?.marker||audit.before.ledger||anchor.snapshot.generation!==0||anchor.snapshot.entries.length)fail('RESTORE_START_HISTORY_MISMATCH');
    }else if(start.before?.ledger?.hash!==anchor.canonicalHash||start.before?.marker?.hash!==anchor.markerHash)fail('RESTORE_START_HISTORY_MISMATCH');
    if(audit.before.ledger){
        const value=audit.before.ledger.value,original=value.schemaVersion===2?decodeEnvelope(workflow.p.ledger,value):validateLedgerSnapshot(value);
        if(original.ledgerId!==anchor.snapshot.ledgerId||original.generation>anchor.snapshot.generation||
            original.entries.some(old=>!anchor.snapshot.entries.some(entry=>equal(old,entry))))fail('RESTORE_RECOVERY_HISTORY_MISMATCH');
    }else if(!start.bootstrap)fail('RESTORE_RECOVERY_HISTORY_MISMATCH');
    if(!Number.isSafeInteger(ready.epoch)||evidence.authority?.value.epoch<ready.epoch)fail('RESTORE_AUTHORITY_ROLLBACK');
    if(anchor.transactionId!==null){
        const intent=validateMigrationCompletion(workflow.p.ledger,evidence.migrationIntent?.value,evidence.migrationActivated?.value,evidence.migrationCompleted?.value);
        if(audit.before.ledger?.value.schemaVersion===1&&intent.original.hash!==audit.before.ledger.hash)fail('RESTORE_RECOVERY_MIGRATION_MISMATCH');
    }
    return current;
}
