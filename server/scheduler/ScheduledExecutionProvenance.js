import {createHash} from 'node:crypto';
import {resolve,basename,dirname} from 'node:path';
import {readdir} from 'node:fs/promises';
import {capturedEvidence} from '../recovery/PersistentEvidence.js';
import {namespaceKey,assertCanonicalNames} from '../recovery/RecoveryNamespace.js';
import {scheduledLiveTransactionEnvelope, validateScheduledLiveTransactionEnvelope}
    from './ScheduledLiveExecutionTransaction.js';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, function(key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(k => [k,item[k]])) : item;
});
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
export const refuse = code => { throw Object.assign(new Error(code), {code}); };

// Identity is stable across clean restarts, specific to the canonical private
// path. Copying/moving a journal is not an implicit repository migration.
export function repositoryIdentity(path) {
    const absolute=resolve(path);
    return digest(process.platform === 'win32' ? absolute.toLowerCase() : absolute);
}
export function validateLock(lock, repositoryId) {
    if (lock?.version === 1 && id(lock.processSession)) return 'LEGACY_UNVERIFIABLE';
    if (lock?.schemaVersion !== 2) refuse('SCHEDULED_LOCK_SCHEMA_UNSUPPORTED');
    if(lock.executionEraId!==undefined&&(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(lock.executionEraId)||!hash(lock.retirementHash)))refuse('SCHEDULED_ERA_INVALID');
    if (!hash(lock.repositoryId) || lock.repositoryId !== repositoryId ||
        !id(lock.processSession) || !positive(lock.processId) ||
        !positive(lock.authorityEpoch) || !id(lock.authorityProcessSession) || !hash(lock.authorityId) ||
        typeof lock.createdAt !== 'string' || !Number.isFinite(Date.parse(lock.createdAt)) ||
        !(lock.initialJournalHash === null || hash(lock.initialJournalHash)))
        refuse('SCHEDULED_LOCK_INVALID');
    return 'VERIFIABLE';
}
export function journalEnvelope(record, lock) {
    const inner=scheduledLiveTransactionEnvelope(record);
    const provenance={repositoryId:lock.repositoryId, processSession:lock.processSession,
        ...(lock.executionEraId?{executionEraId:lock.executionEraId,retirementHash:lock.retirementHash}:{}),
        authorityEpoch:lock.authorityEpoch, authorityProcessSession:lock.authorityProcessSession, authorityId:lock.authorityId,
        // Immutable capture identifies the transaction across its phase writes.
        transactionId:digest(canonical(record === null ? null : {
            eventId:record.eventId, sourceId:record.sourceId, capturedAt:record.capturedAt,
            manualIntentRevision:record.manualIntentRevision, capturedProgram:record.capturedProgram
        }))};
    const payload={schemaVersion:2, provenance, transaction:inner};
    return {...payload, checksum:digest(canonical(payload))};
}
export function validateJournal(value, repositoryId) {
    if (value?.schemaVersion === 1) refuse('LEGACY_JOURNAL_REVIEW_REQUIRED');
    if (value?.schemaVersion !== 2) refuse('SCHEDULED_JOURNAL_SCHEMA_UNSUPPORTED');
    const p=value.provenance;
    if(p?.executionEraId!==undefined&&(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.executionEraId)||!hash(p.retirementHash)))refuse('SCHEDULED_ERA_INVALID');
    if (!p || p.repositoryId !== repositoryId || !hash(p.repositoryId) ||
        !id(p.processSession) || !positive(p.authorityEpoch) || !id(p.authorityProcessSession) || !hash(p.authorityId))
        refuse('SCHEDULED_JOURNAL_PROVENANCE_MISMATCH');
    const inner=validateScheduledLiveTransactionEnvelope(value.transaction);
    const expected=journalEnvelope(inner.record,p);
    if (canonical(expected) !== canonical(value)) refuse('SCHEDULED_JOURNAL_CORRUPT');
    return inner;
}
export function journalMatchesLock(bytes, lock) {
    if (bytes === null) {
        if (lock.initialJournalHash !== null) refuse('SCHEDULED_JOURNAL_DISAPPEARED');
        return;
    }
    const evidence=capturedEvidence(Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes),{json:true});
    const journal=evidence.value;
    validateJournal(journal,lock.repositoryId);
    const p=journal.provenance;
    if (p.authorityId !== lock.authorityId) refuse('SCHEDULED_JOURNAL_AUTHORITY_MISMATCH');
    const current=p.processSession === lock.processSession &&
        p.authorityEpoch === lock.authorityEpoch &&
        p.authorityProcessSession === lock.authorityProcessSession;
    const historical=evidence.sha256 === lock.initialJournalHash &&
        (p.authorityEpoch < lock.authorityEpoch ||
         (p.authorityEpoch === lock.authorityEpoch && p.authorityProcessSession === lock.authorityProcessSession));
    if (!current && !historical) refuse('SCHEDULED_JOURNAL_PROVENANCE_MISMATCH');
}

// Ledger and Scheduled sessions are independent. Their common authority epoch
// and session identify the runtime; capturedProgram is advisory D10 history,
// not a final PROGRAM/RETURN receipt. Never infer completion from another state.
export function completedScheduledHistory(bytes,{scheduledPath,authorityPath,ledgerLock}) {
    if(bytes===null)return null;
    const evidence=capturedEvidence(Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes),{json:true});
    const value=evidence.value,validated=validateJournal(value,repositoryIdentity(scheduledPath));
    const p=value.provenance;
    if(p.authorityId!==repositoryIdentity(authorityPath)||p.authorityEpoch!==ledgerLock.authorityEpoch||
        p.authorityProcessSession!==ledgerLock.authorityProcessSession)
        refuse('LEDGER_V2_TERMINAL_SCHEDULED_PROVENANCE_MISMATCH');
    if(validated.record.state!=='COMPLETED')refuse('LEDGER_V2_TERMINAL_SCHEDULED_UNRESOLVED');
    return {state:'COMPLETED',journalHash:evidence.sha256,processSession:p.processSession,
        transactionId:p.transactionId};
}

export async function assertScheduledTerminalNamespace(path) {
    const key=namespaceKey;
    const prefix=key(basename(path)+'.');
    const names=await readdir(dirname(path));
    assertCanonicalNames(names,[basename(path),basename(path)+'.lock'],{code:'LEDGER_V2_TERMINAL_SCHEDULED_AMBIGUOUS'});
    const seen=new Set();
    for(const name of names) {
        const normalized=key(name);
        if(!normalized.startsWith(prefix))continue;
        if(seen.has(normalized))refuse('LEDGER_V2_TERMINAL_SCHEDULED_AMBIGUOUS');
        seen.add(normalized);
        const tail=normalized.slice(prefix.length);
        const originalTail=name.slice(prefix.length);
        if(!name.startsWith(basename(path)+'.')||
            !(originalTail==='lock'||/^lock\.quarantine-[a-zA-Z0-9_-]{1,80}$/.test(originalTail)||
                /^reconciliation-[a-zA-Z0-9_-]{1,80}\.json(?:\.completed)?$/.test(originalTail)))
            refuse('LEDGER_V2_TERMINAL_SCHEDULED_AMBIGUOUS');
        if(tail==='lock'||/^lock\.quarantine-[a-zA-Z0-9_-]{1,80}$/.test(tail)||
            /^reconciliation-[a-zA-Z0-9_-]{1,80}\.json(?:\.completed)?$/.test(tail))continue;
        refuse('LEDGER_V2_TERMINAL_SCHEDULED_AMBIGUOUS');
    }
}
