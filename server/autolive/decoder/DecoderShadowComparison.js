import {compareHealth, usable} from '../HeadlessHealthEvidence.js';
import Shadow from '../AutoLiveDecisionShadow.js';
import {freeze} from '../ExecutionTransferContract.js';
import {validSample, provenance} from './DecoderEvidenceContract.js';

function freshDecoder(sample, binding, now) {
    return validSample(sample) && sample.sourceId === binding?.authorizedSourceId &&
        sample.sourceFingerprint === binding?.sourceFingerprint && Number.isSafeInteger(now) &&
        now >= sample.observedAt && now - sample.observedAt <= 2000;
}

export function compareDecoderShadow({decoder, server, browser, binding, now}) {
    const transportComparison = compareHealth({server, browser, binding, now});
    const fresh = freshDecoder(decoder, binding, now), browserFresh = usable(browser, binding, now);
    const progress = fresh && decoder.state === 'DECODER_PROGRESS';
    let classification = 'INSUFFICIENT_EVIDENCE';
    if (browserFresh && browser.capabilities.MEDIA_DECODE_PROGRESS) {
        classification = progress ? 'MATCH_HEALTHY' : 'SERVER_WEAKER';
    } else if (browserFresh && browser.capabilities.LOSS_CONFIRMATION && progress) classification = 'DISAGREEMENT';
    else if (fresh && usable(server, binding, now) && server.state === 'ONLINE' &&
        ['DECODER_ERROR', 'DECODER_STALLED', 'DECODER_ENDED'].includes(decoder.state)) classification = 'DISAGREEMENT';
    return freeze({classification, transportComparison, decoderFreshAndBound: fresh, decoderProgress: progress,
        localFixtureOnly: decoder?.localFixtureOnly !== false, decoderEquivalent: false, executionAllowed: false, serverTake: false, transferReady: false});
}

// Reuses the Phase-2 advisory timing, with decoder-specific freshness and generation resets.
// Only an already-classified, fresh browser loss observation can supply hypothetical OFFLINE.
// Decoder failure alone is UNKNOWN; this model never confirms source loss itself.
export class DecoderHypotheticalTiming {
    constructor({clock = () => Date.now()} = {}) { this.clock = clock; this.shadow = new Shadow({clock}); }
    update({decoder, binding, lossEvidence, enabled = false, armed = false, liveObserved = false}) {
        const now = this.clock(), fresh = freshDecoder(decoder, binding, now);
        const key = JSON.stringify([binding?.authorityEpoch, binding?.authorityProcessSession, binding?.ownershipRevision,
            fresh ? provenance(decoder) : null]);
        const gap = this.lastAt !== undefined && now - this.lastAt > 2000;
        if (this.key !== key || gap) this.shadow.reset();
        this.key = key; this.lastAt = now;
        const progress = fresh && decoder.state === 'DECODER_PROGRESS';
        const loss = !progress && usable(lossEvidence, binding, now) && lossEvidence.capabilities.LOSS_CONFIRMATION;
        // Do not accumulate entry stability across uncertain observation gaps.
        if (!liveObserved && !progress) this.shadow.reset();
        const result = this.shadow.update({enabled, armed, sourceId: binding?.authorizedSourceId,
            sourceFingerprint: binding?.sourceFingerprint, browserStage: liveObserved ? 'LIVE' : null,
            health: {state: progress ? 'ONLINE' : loss ? 'OFFLINE' : 'UNKNOWN', freshness: 'FRESH', validUntil: now + 2000}});
        return freeze({...result, localFixtureOnly: decoder?.localFixtureOnly !== false, hypotheticalOnly: true,
            executionAllowed: false, serverTake: false, transferReady: false});
    }
}
