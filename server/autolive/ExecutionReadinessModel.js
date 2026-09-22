import {freeze, compareTransferCAS, validBinding, id, digest} from './ExecutionTransferContract.js';

export const CAPABILITIES = freeze({
    EXTERNAL_HLS: {presence: true, playlistProgress: true, segmentReachability: true, decoderProgress: false, headlessEquivalent: false},
    MANAGED_INGEST: {presence: true, playlistProgress: false, segmentReachability: false, decoderProgress: false, headlessEquivalent: false},
    BROWSER_DECODER: {presence: false, playlistProgress: false, segmentReachability: false, decoderProgress: true, headlessEquivalent: false},
    ACTIVE_PROGRAM: {presence: false, playlistProgress: false, segmentReachability: false, decoderProgress: true, headlessEquivalent: false}
});

// Pure, bounded projection; no caller-supplied capability can upgrade a producer.
export function evaluateReadiness({expected, current, observations = [], now, recoveryAtomicityProven = false} = {}) {
    const blockers = ['PHASE1_EXECUTION_FORBIDDEN', 'HEADLESS_DECODER_EQUIVALENCE_UNPROVEN'];
    if (!compareTransferCAS(expected, current).matches) blockers.push('STALE_CAS');
    if (recoveryAtomicityProven !== true) blockers.push('ACTION_PROGRAM_ATOMICITY_UNPROVEN');
    // Even a hypothetical proof input is not an implemented executable recovery reader.
    blockers.push('EXECUTABLE_RECOVERY_NOT_IMPLEMENTED');
    const input = Array.isArray(observations) ? observations : [];
    if (!Array.isArray(observations) || input.length > 8) blockers.push('EVIDENCE_BOUNDS');
    const evidence = input.slice(0, 8).map(o => {
        const kind = Object.hasOwn(CAPABILITIES, o?.kind) ? o.kind : 'UNKNOWN';
        const identityMatches = id(o?.sourceId) && digest(o?.sourceFingerprint) &&
            o.sourceId === current?.authorizedSourceId && o.sourceFingerprint === current?.sourceFingerprint;
        const fresh = Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(o?.observedAt) &&
            Number.isSafeInteger(o?.validUntil) && o.observedAt >= 0 && o.observedAt <= now &&
            now < o.validUntil && o.validUntil - o.observedAt <= 10000 &&
            o.authorityEpoch === current?.authorityEpoch && o.authorityProcessSession === current?.authorityProcessSession;
        const state = ['ONLINE','OFFLINE','CHECKING','UNKNOWN','UNCERTAIN','ERROR'].includes(o?.state) ? o.state : 'UNKNOWN';
        const accepted = validBinding(current) && identityMatches && fresh && kind !== 'UNKNOWN';
        const activeProgramBound = accepted && kind === 'ACTIVE_PROGRAM' && o.programIdentity === current.programIdentity &&
            o.ownershipRevision === current.ownershipRevision;
        return {kind, identityMatches: Boolean(identityMatches), fresh: Boolean(fresh), state,
            playlistProgress: accepted && CAPABILITIES[kind].playlistProgress && o.playlistProgress === true,
            segmentReachable: accepted && CAPABILITIES[kind].segmentReachability && o.segmentReachable === true,
            decoderProgress: accepted && CAPABILITIES[kind].decoderProgress && o.playbackProgressing === true &&
                (kind !== 'ACTIVE_PROGRAM' || activeProgramBound),
            activeProgramBound,
            headlessEquivalent: false};
    });
    if (!evidence.length) blockers.push('NO_EVIDENCE');
    if (evidence.some(e => !e.identityMatches)) blockers.push('SOURCE_IDENTITY_MISMATCH');
    if (evidence.some(e => !e.fresh)) blockers.push('STALE_EVIDENCE');
    if (evidence.some(e => e.kind === 'UNKNOWN')) blockers.push('UNKNOWN_PRODUCER');
    if (!evidence.some(e => e.decoderProgress)) blockers.push('NO_DECODER_PROGRESS');
    if (evidence.some(e => e.kind === 'ACTIVE_PROGRAM' && !e.activeProgramBound)) blockers.push('PROGRAM_BINDING_MISMATCH');
    if (evidence.some(e => e.kind === 'EXTERNAL_HLS' && e.state === 'ONLINE' && (!e.playlistProgress || !e.segmentReachable)))
        blockers.push('TRANSPORT_EVIDENCE_INCOMPLETE');
    return freeze({modelOnly: true, transferReady: false, executionAllowed: false, serverTake: false,
        blockers: [...new Set(blockers)], capabilities: CAPABILITIES, evidence});
}

export function compareDecisionPaths({browser, shadow, readiness, programIdentity}) {
    // Caller supplies private scalar projections, never raw health objects/URLs.
    const differences = [];
    if (browser?.sourceIdentityMatches !== true) differences.push('BROWSER_SOURCE_IDENTITY_UNPROVEN');
    if (shadow?.sourceIdentityMatches !== true) differences.push('SHADOW_SOURCE_IDENTITY_UNPROVEN');
    if (browser?.healthState !== shadow?.healthState) differences.push('HEALTH_STATE_DIFFERS');
    if (browser?.entryEligible !== shadow?.entryEligible) differences.push('ENTRY_ELIGIBILITY_DIFFERS');
    if (browser?.lossEligible !== shadow?.lossEligible) differences.push('LOSS_ELIGIBILITY_DIFFERS');
    if (browser?.uncertain !== shadow?.uncertain) differences.push('UNCERTAINTY_DIFFERS');
    if (!digest(programIdentity) || browser?.programIdentity !== programIdentity) differences.push('PROGRAM_IDENTITY_DIFFERS');
    if (readiness?.evidence?.some(e => e.decoderProgress) && shadow?.healthState !== 'ONLINE')
        differences.push('DECODER_PROGRESS_WITH_NONONLINE_TRANSPORT');
    return freeze({modelOnly: true, executionAllowed: false, differences});
}
