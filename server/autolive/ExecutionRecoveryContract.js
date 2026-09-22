import {freeze, id, revision, digest, compareTransferCAS} from './ExecutionTransferContract.js';

export const TIMING = freeze({entryMs: 30000, confirmedLossMs: 15000,
    authority: 'CURRENT_BROWSER_POLICY', shadowExecutable: false});
export const CRASH_POINTS = Object.freeze(['BEFORE_RESERVATION','AFTER_RESERVATION','BEFORE_PROGRAM_COMMIT',
    'AFTER_PROGRAM_COMMIT','BEFORE_TRANSFER_COMPLETION','DURING_LIVE','DURING_CONFIRMED_LOSS','BEFORE_RETURN','AFTER_RETURN']);
const validBinding = b => b && compareTransferCAS(b, b).matches;
export function recoveryRecord(value) {
    if (!value || !id(value.actionId) || !['ENTRY','TAKE','RETURN'].includes(value.actionType) ||
        !validBinding(value.origin) || !CRASH_POINTS.includes(value.phase) ||
        !['NOT_RESERVED','RESERVED','COMMITTED','UNKNOWN'].includes(value.commitStatus) ||
        !['NONE','CAPTURED','INVALIDATED'].includes(value.returnEligibility) ||
        !id(value.authorizedSourceId) || !digest(value.sourceFingerprint) ||
        value.authorizedSourceId !== value.origin.authorizedSourceId || value.sourceFingerprint !== value.origin.sourceFingerprint ||
        !revision(value.manualIntentRevision) || value.manualIntentRevision !== value.origin.manualIntentRevision ||
        value.authorityEpoch !== value.origin.authorityEpoch || value.ownershipRevision !== value.origin.ownershipRevision ||
        !revision(value.actionRevision) || value.actionRevision !== value.origin.actionRevision ||
        !digest(value.decisionEvidenceDigest) || !revision(value.configRevision) || value.configRevision !== value.origin.configRevision)
        throw new TypeError('INVALID_RECOVERY_CONTRACT');
    const evidence = value.decisionEvidence;
    if (!evidence || !['EXTERNAL_HLS','MANAGED_INGEST','BROWSER_DECODER','ACTIVE_PROGRAM'].includes(evidence.kind) ||
        !['ONLINE','OFFLINE','CHECKING','UNKNOWN','UNCERTAIN','ERROR'].includes(evidence.state) ||
        !revision(evidence.observedAt) || !revision(evidence.validUntil) || evidence.validUntil <= evidence.observedAt ||
        evidence.validUntil - evidence.observedAt > 10000 || typeof evidence.decoderProgress !== 'boolean')
        throw new TypeError('INVALID_DECISION_EVIDENCE');
    const target = value.interruptedTarget;
    if (target !== null && (!id(target?.sceneId) || !id(target?.sourceId) || !digest(target?.programIdentity) ||
        !Number.isFinite(target?.cue) || target.cue < 0 || target.cue > 31536000 ||
        !['PLAYING','PAUSED','ENDED'].includes(target?.playbackState))) throw new TypeError('INVALID_RETURN_TARGET');
    if ((value.returnEligibility === 'CAPTURED') !== (target !== null)) throw new TypeError('INVALID_RETURN_ELIGIBILITY');
    if (value.commitStatus === 'COMMITTED' && !digest(value.committedProgramIdentity)) throw new TypeError('COMMIT_PROOF_REQUIRED');
    return freeze({version: 1, actionId: value.actionId, actionType: value.actionType, origin: structuredClone(value.origin),
        authorizedSourceId: value.authorizedSourceId, sourceFingerprint: value.sourceFingerprint,
        manualIntentRevision: value.manualIntentRevision, authorityEpoch: value.authorityEpoch,
        ownershipRevision: value.ownershipRevision, actionRevision: value.actionRevision, configRevision: value.configRevision,
        decisionEvidenceDigest: value.decisionEvidenceDigest, decisionEvidence: {
            kind: evidence.kind, state: evidence.state, observedAt: evidence.observedAt,
            validUntil: evidence.validUntil, decoderProgress: evidence.decoderProgress},
        phase: value.phase, commitStatus: value.commitStatus,
        committedProgramIdentity: value.commitStatus === 'COMMITTED' ? value.committedProgramIdentity : null,
        returnEligibility: value.returnEligibility, interruptedTarget: target === null ? null : {
            sceneId: target.sceneId, sourceId: target.sourceId, programIdentity: target.programIdentity,
            cue: target.cue, playbackState: target.playbackState}});
}
export function inspectRecovery(record, current, crashPoint) {
    if (!CRASH_POINTS.includes(crashPoint)) throw new TypeError('INVALID_CRASH_POINT');
    const r = recoveryRecord(record);
    const manualChanged = current?.manualIntentRevision !== r.manualIntentRevision;
    const originMatches = compareTransferCAS(r.origin, current).matches;
    const committedObserved = r.commitStatus === 'COMMITTED' && current?.programIdentity === r.committedProgramIdentity;
    return freeze({modelOnly: true, executionAllowed: false, serverTake: false, replayAllowed: false, returnAllowed: false,
        crashPoint, originMatches, committedObserved,
        disposition: manualChanged ? 'INVALIDATED_BY_MANUAL_INTENT' : committedObserved ? 'OBSERVE_COMMIT_DO_NOT_REPLAY' :
            r.commitStatus === 'UNKNOWN' || !originMatches ? 'RECONCILE_REQUIRED' :
                r.commitStatus === 'NOT_RESERVED' ? 'NO_ACTION_RESERVED' :
                    crashPoint === 'BEFORE_RESERVATION' ? 'RECONCILE_REQUIRED' : 'UNCOMMITTED_ACTION_DO_NOT_EXECUTE',
        blockers: ['PHASE1_EXECUTION_FORBIDDEN', 'ACTION_PROGRAM_ATOMICITY_UNPROVEN',
            ...(manualChanged ? ['MANUAL_INTENT_CHANGED'] : [])]});
}
export function timingContinuity(event) {
    if (!['BROWSER_RELOAD','OWNER_TRANSFER','SERVER_RESTART','PROCESS_CRASH'].includes(event))
        throw new TypeError('INVALID_TIMING_BOUNDARY');
    return freeze({event, ...TIMING, inheritEntryAccumulation: false, inheritLossDeadline: false,
        retainedLiveIdentityMayBeAdopted: true, requiresFreshBoundObservation: true,
        reason: 'TIMING_CONTINUITY_UNPROVEN', executionAllowed: false});
}
export function futurePriority({manualPending = false, autoLiveActive = false, interruptionActive = false,
    returnTargetValid = false, ownerValid = false} = {}) {
    return freeze({modelOnly: true, schedulerExecution: 'SUSPENDED', executionAllowed: false,
        proposedPriority: manualPending ? 'MANUAL' : !ownerValid ? 'FENCED' : autoLiveActive ? 'AUTOLIVE' :
            interruptionActive ? (returnTargetValid ? 'VALIDATE_RETURN_CAS' : 'NO_MANUFACTURED_RETURN') : 'SCHEDULER_CANDIDATE',
        requiresSharedOwnerAndCAS: true});
}
