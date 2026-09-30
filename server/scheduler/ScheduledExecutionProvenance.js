import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
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
    const journal=JSON.parse(bytes);
    validateJournal(journal,lock.repositoryId);
    const p=journal.provenance;
    if (p.authorityId !== lock.authorityId) refuse('SCHEDULED_JOURNAL_AUTHORITY_MISMATCH');
    const current=p.processSession === lock.processSession &&
        p.authorityEpoch === lock.authorityEpoch &&
        p.authorityProcessSession === lock.authorityProcessSession;
    const historical=digest(bytes) === lock.initialJournalHash &&
        (p.authorityEpoch < lock.authorityEpoch ||
         (p.authorityEpoch === lock.authorityEpoch && p.authorityProcessSession === lock.authorityProcessSession));
    if (!current && !historical) refuse('SCHEDULED_JOURNAL_PROVENANCE_MISMATCH');
}
