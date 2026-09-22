import {createHash} from 'node:crypto';
import {canonical} from '../program-output/DurableProgramContract.js';
import {freeze, validBinding, compareTransferCAS, revision, digest, id} from './ExecutionTransferContract.js';
import {recoveryRecord} from './ExecutionRecoveryContract.js';

export const ACTION_STATES = Object.freeze(['NONE','RESERVED','COMMITTING','PROGRAM_COMMITTED','ACTIVE',
    'RETURN_PENDING','COMPLETED','ABORTED','RECOVERY_BLOCKED']);
const fail = code => { throw Object.assign(Error(code), {code}); };
const same = (a, b) => canonical(a) === canonical(b);
const terminal = state => ['COMPLETED','ABORTED','RECOVERY_BLOCKED'].includes(state);
export function intent(expected, target) {
    if (!validBinding(expected) || !validBinding(target) || target.durableGeneration !== expected.durableGeneration + 1 ||
        target.programIdentity === expected.programIdentity) fail('INVALID_COMMIT_INTENT');
    const programFields = ['durableGeneration','programIdentity','programStatus','programRevision','publisherSessionId'];
    if (Object.keys(expected).some(k => !programFields.includes(k) && expected[k] !== target[k])) fail('INTENT_FENCE_MISMATCH');
    return freeze({expected: structuredClone(expected), target: structuredClone(target)});
}
export function normalizeTransaction(value) {
    if (!value || !revision(value.actionRevision) || value.actionRevision < 1 || !revision(value.reservedAt) ||
        !ACTION_STATES.includes(value.state) || value.state === 'NONE') fail('INVALID_ACTION_TRANSACTION');
    const action = recoveryRecord(value.action);
    const commitIntent = value.commitIntent === null ? null : intent(value.commitIntent?.expected, value.commitIntent?.target);
    const returnIntent = value.returnIntent === null ? null : intent(value.returnIntent?.expected, value.returnIntent?.target);
    if (commitIntent && !same(commitIntent.expected, action.origin)) fail('ORIGIN_MISMATCH');
    if (returnIntent && (!commitIntent || !same(returnIntent.expected, commitIntent.target) || action.returnEligibility !== 'CAPTURED')) fail('RETURN_MISMATCH');
    const commit = value.programCommit;
    if (commit !== null && (!digest(commit?.programIdentity) || !revision(commit.generation) ||
        !commitIntent || commit.programIdentity !== commitIntent.target.programIdentity || commit.generation !== commitIntent.target.durableGeneration)) fail('COMMIT_MISMATCH');
    if (['COMMITTING','PROGRAM_COMMITTED','ACTIVE','RETURN_PENDING','COMPLETED'].includes(value.state) && !commitIntent) fail('COMMIT_INTENT_REQUIRED');
    if (['PROGRAM_COMMITTED','ACTIVE','RETURN_PENDING','COMPLETED'].includes(value.state) && !commit) fail('COMMIT_RECEIPT_REQUIRED');
    if (['RETURN_PENDING','COMPLETED'].includes(value.state) && !returnIntent) fail('RETURN_INTENT_REQUIRED');
    if (terminal(value.state) && !id(value.reason)) fail('TERMINAL_REASON_REQUIRED');
    if (!terminal(value.state) && value.reason !== null) fail('UNEXPECTED_REASON');
    return freeze({actionRevision: value.actionRevision, action, reservedAt: value.reservedAt, state: value.state,
        commitIntent, returnIntent, programCommit: commit && {programIdentity: commit.programIdentity, generation: commit.generation}, reason: value.reason});
}
export const checksum = value => createHash('sha256').update(canonical(value)).digest('hex');
export function actionEnvelope(record) {
    const payload = {schemaVersion: 1, mode: 'NON_EXECUTING_MODEL', record: normalizeTransaction(record)};
    return freeze({...payload, checksum: checksum(payload)});
}
export function validateActionEnvelope(value) {
    if (value?.schemaVersion !== 1 || !digest(value.checksum)) fail('ACTION_CORRUPT');
    const normalized = actionEnvelope(value.record);
    if (!same(normalized, value)) fail('ACTION_CORRUPT');
    return normalized;
}
export function inspectAction(record, current) {
    const base = {modelOnly: true, executionAllowed: false, serverTake: false, replayAllowed: false, returnAllowed: false};
    if (!record) return freeze({...base, state: 'NONE', disposition: 'NO_RESERVATION'});
    const r = normalizeTransaction(record), origin = r.action.origin;
    let disposition = 'RECONCILIATION_REQUIRED';
    if (!validBinding(current)) disposition = 'PROGRAM_UNAVAILABLE';
    else if (current.manualIntentRevision !== origin.manualIntentRevision) disposition = 'MANUAL_INTENT_DOMINATES';
    else if (current.authorityEpoch !== origin.authorityEpoch || current.authorityProcessSession !== origin.authorityProcessSession)
        disposition = 'EPOCH_RECONCILIATION_REQUIRED';
    else if (terminal(r.state)) disposition = r.state;
    else if (r.returnIntent && compareTransferCAS(r.returnIntent.target, current).matches) disposition = 'RETURN_COMMITTED_DO_NOT_REPLAY';
    else if (r.commitIntent && compareTransferCAS(r.commitIntent.target, current).matches) disposition = 'PROGRAM_COMMITTED_DO_NOT_REPLAY';
    else if (compareTransferCAS(origin, current).matches && ['RESERVED','COMMITTING'].includes(r.state)) disposition = 'UNCOMMITTED_DO_NOT_REPLAY';
    return freeze({...base, state: r.state, disposition});
}

// Durable specification only: current() reads trusted DP1 binding; no Program writer is accepted.
export default class ActionTransactionModel {
    constructor({repository, current, clock = () => Date.now()}) { Object.assign(this, {repository, current, clock}); }
    inspect() {
        if (this.repository.status !== 'READY') return freeze({state: 'RECOVERY_BLOCKED', disposition: 'ACTION_UNAVAILABLE',
            executionAllowed: false, serverTake: false, replayAllowed: false, returnAllowed: false});
        return inspectAction(this.repository.record, this.current());
    }
    async reserve(action, expectedRevision = 0) {
        const normalized = recoveryRecord(action), current = this.current();
        const existing = this.repository.record;
        if (existing && same(existing.action, normalized)) return freeze({record: existing, duplicate: true, ...this.inspect()});
        if (!compareTransferCAS(normalized.origin, current).matches) fail('STALE_ACTION_CAS');
        return this.repository.write(expectedRevision, {actionRevision: 1, action: normalized, reservedAt: this.clock(), state: 'RESERVED',
            commitIntent: null, returnIntent: null, programCommit: null, reason: null}, () => compareTransferCAS(current, this.current()).matches);
    }
    async transition(operation, expectedRevision, target = null) {
        const r = this.repository.record; if (!r || terminal(r.state)) fail('ACTION_TERMINAL_OR_MISSING');
        const current = this.current();
        let expected, changes;
        if (operation === 'begin-commit' && r.state === 'RESERVED') {
            expected = r.action.origin; changes = {state: 'COMMITTING', commitIntent: intent(expected, target)};
        } else if (operation === 'observe-commit' && r.state === 'COMMITTING') {
            expected = r.commitIntent.target; changes = {state: 'PROGRAM_COMMITTED', programCommit: {
                programIdentity: expected.programIdentity, generation: expected.durableGeneration}};
        } else if (operation === 'activate-model' && r.state === 'PROGRAM_COMMITTED') {
            expected = r.commitIntent.target; changes = {state: 'ACTIVE'};
        } else if (operation === 'prepare-return' && r.state === 'ACTIVE' && r.action.returnEligibility === 'CAPTURED') {
            expected = r.commitIntent.target; changes = {state: 'RETURN_PENDING', returnIntent: intent(expected, target)};
        } else if (operation === 'observe-return' && r.state === 'RETURN_PENDING') {
            expected = r.returnIntent.target; changes = {state: 'COMPLETED', reason: 'RETURN_OBSERVED'};
        } else fail('INVALID_ACTION_TRANSITION');
        if (!compareTransferCAS(expected, current).matches) fail('STALE_ACTION_CAS');
        return this.repository.write(expectedRevision, {...r, ...changes, actionRevision: expectedRevision + 1},
            () => compareTransferCAS(expected, this.current()).matches);
    }
    async invalidate(expectedRevision) {
        const r = this.repository.record; if (!r || terminal(r.state)) fail('ACTION_TERMINAL_OR_MISSING');
        const reason = this.inspect().disposition;
        return this.repository.write(expectedRevision, {...r, actionRevision: expectedRevision + 1,
            state: reason === 'MANUAL_INTENT_DOMINATES' ? 'ABORTED' : 'RECOVERY_BLOCKED', reason}, () => true);
    }
    evaluateCandidate(transfer) {
        return freeze({candidateState: transfer?.state === 'SERVER_CANDIDATE' ? 'SERVER_CANDIDATE' : 'TRANSFER_BLOCKED',
            action: this.inspect(), transferReady: false, executionAllowed: false, serverTake: false});
    }
}
