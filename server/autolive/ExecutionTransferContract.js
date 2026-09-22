import {createHash} from 'node:crypto';
import {validateProgramOutputEnvelope} from '../../public/js/program-output/ProgramOutputEnvelope.js';

// Phase-1 specification model ONLY. No grants, timers, IO, or production callers.
export const STATES = Object.freeze(['BROWSER_OWNER', 'TRANSFER_PREPARING',
    'NO_OWNER_FENCED', 'SERVER_CANDIDATE', 'TRANSFER_BLOCKED']);
export const freeze = value => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze); Object.freeze(value);
    }
    return value;
};
export const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
export const revision = value => Number.isSafeInteger(value) && value >= 0;
export const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reject = () => { throw new TypeError('INVALID_TRANSFER_CONTRACT'); };
const INTEGER_KEYS = ['authorityEpoch', 'ownershipRevision', 'durableGeneration', 'configRevision',
    'manualIntentRevision', 'recoveryRevision', 'actionRevision', 'programRevision'];
const BINDING_KEYS = [...INTEGER_KEYS, 'authorityProcessSession', 'programStatus', 'programIdentity',
    'publisherSessionId', 'authorizedSourceId', 'sourceFingerprint', 'schedulerExecution'];
export function validBinding(value) {
    return Boolean(value && Object.keys(value).length === BINDING_KEYS.length &&
        BINDING_KEYS.every(k => Object.hasOwn(value, k)) && INTEGER_KEYS.every(k => revision(value[k])) &&
        value.authorityEpoch > 0 && value.durableGeneration > 0 && value.programRevision > 0 &&
        ['authorityProcessSession','publisherSessionId','authorizedSourceId'].every(k => id(value[k])) &&
        digest(value.programIdentity) && digest(value.sourceFingerprint) &&
        ['PRESENT','EXPLICIT_EMPTY'].includes(value.programStatus) && value.schedulerExecution === 'SUSPENDED');
}
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export function acceptedProgramIdentity(envelope) {
    // Call with store.getCurrent(), never a time-projected output snapshot.
    const accepted = validateProgramOutputEnvelope(envelope);
    if (!accepted) reject();
    const encoded = canonical(accepted);
    if (Buffer.byteLength(encoded) > 128 * 1024) reject();
    return createHash('sha256').update(encoded).digest('hex');
}
export function bindTransferState(input) {
    if (!input || !['PRESENT', 'EXPLICIT_EMPTY'].includes(input.programStatus)) reject();
    const integers = ['authorityEpoch', 'ownershipRevision', 'durableGeneration', 'configRevision',
        'manualIntentRevision', 'recoveryRevision', 'actionRevision'];
    if (!integers.every(k => revision(input[k])) || input.authorityEpoch < 1 || input.durableGeneration < 1 ||
        !id(input.authorityProcessSession) || !id(input.authorizedSourceId) || !digest(input.sourceFingerprint) ||
        input.schedulerExecution !== 'SUSPENDED') reject();
    const envelope = input.acceptedProgram;
    const programIdentity = acceptedProgramIdentity(envelope);
    if ((input.programStatus === 'PRESENT') !== Boolean(envelope.snapshot.scene)) reject();
    const binding = { ...Object.fromEntries(integers.map(k => [k, input[k]])),
        authorityProcessSession: input.authorityProcessSession, programStatus: input.programStatus,
        programIdentity, publisherSessionId: envelope.publisherSessionId, programRevision: envelope.revision,
        authorizedSourceId: input.authorizedSourceId, sourceFingerprint: input.sourceFingerprint,
        schedulerExecution: input.schedulerExecution };
    if (!validBinding(binding)) reject();
    return freeze(binding);
}
export function compareTransferCAS(expected, current) {
    if (!validBinding(expected) || !validBinding(current)) return freeze({matches: false, mismatches: ['INVALID_BINDING']});
    const keys = ['authorityEpoch', 'authorityProcessSession', 'ownershipRevision', 'durableGeneration',
        'programStatus', 'programIdentity', 'publisherSessionId', 'programRevision', 'configRevision',
        'authorizedSourceId', 'sourceFingerprint', 'manualIntentRevision', 'recoveryRevision',
        'actionRevision', 'schedulerExecution'];
    const mismatches = keys.filter(k => expected[k] === undefined || current[k] !== expected[k]);
    return freeze({matches: mismatches.length === 0, mismatches});
}

export default class ExecutionTransferModel {
    constructor({ownerInstanceId, binding}) {
        if (!id(ownerInstanceId) || !binding || !compareTransferCAS(binding, binding).matches) reject();
        this.ownerInstanceId = ownerInstanceId;
        this.binding = freeze(structuredClone(binding));
        this.state = 'BROWSER_OWNER'; this.candidate = null;
    }
    result(blockers = []) {
        return freeze({state: this.state, candidate: this.candidate, blockers,
            transferReady: false, executionAllowed: false, serverTake: false,
            modelOnly: true});
    }
    block(reason) { this.state = 'TRANSFER_BLOCKED'; return this.result([reason]); }
    prepare({transferId, operatorAuthorized, ownerInstanceId, leaseValid, current, now, expiresAt}) {
        if (this.state !== 'BROWSER_OWNER') return this.block('TRANSFER_ALREADY_STARTED');
        if (operatorAuthorized !== true || ownerInstanceId !== this.ownerInstanceId || leaseValid !== true)
            return this.block('EXPLICIT_CURRENT_OWNER_REQUIRED');
        if (!id(transferId) || !revision(now) || !revision(expiresAt) || expiresAt <= now || expiresAt - now > 60000)
            return this.block('INVALID_CHALLENGE');
        if (!compareTransferCAS(this.binding, current).matches) return this.block('STALE_CAS');
        this.candidate = freeze({version: 1, transferId, ownerInstanceId, preparedAt: now, expiresAt,
            origin: this.binding, expected: this.binding});
        this.state = 'TRANSFER_PREPARING'; return this.result();
    }
    fence({current, now, ownerInstanceId, ownerPresent, oldGrantRejected, pendingRequestsFenced, exclusiveAuthority}) {
        if (this.state !== 'TRANSFER_PREPARING') return this.block('PREPARATION_REQUIRED');
        if (!revision(now) || now < this.candidate.preparedAt || now >= this.candidate.expiresAt)
            return this.block('CHALLENGE_EXPIRED');
        // The *only* permitted CAS change is the modeled release revision.
        const expected = {...this.candidate.expected, ownershipRevision: this.binding.ownershipRevision + 1};
        if (!compareTransferCAS(expected, current).matches) return this.block('STALE_CAS');
        if (ownerInstanceId !== this.ownerInstanceId || ownerPresent !== false || oldGrantRejected !== true ||
            pendingRequestsFenced !== true || exclusiveAuthority !== true) return this.block('FENCE_UNPROVEN');
        this.candidate = freeze({...this.candidate, expected: freeze(structuredClone(current))});
        this.state = 'NO_OWNER_FENCED'; return this.result();
    }
    evaluate({current, now, ownerPresent, exclusiveAuthority, readiness}) {
        if (!['NO_OWNER_FENCED', 'SERVER_CANDIDATE'].includes(this.state)) return this.block('FENCE_REQUIRED');
        if (!revision(now) || now < this.candidate.preparedAt || now >= this.candidate.expiresAt)
            return this.block('CHALLENGE_EXPIRED');
        if (!compareTransferCAS(this.candidate.expected, current).matches) return this.block('STALE_CAS');
        if (ownerPresent !== false || exclusiveAuthority !== true) return this.block('CONFLICTING_EXECUTOR');
        this.state = 'SERVER_CANDIDATE';
        // Caller diagnostics cannot turn a candidate into an executor.
        return this.result(['PHASE1_EXECUTION_FORBIDDEN', ...(readiness?.blockers || []).filter(v =>
            typeof v === 'string' && /^[A-Z0-9_]{1,80}$/.test(v)).slice(0, 24)]);
    }
}
