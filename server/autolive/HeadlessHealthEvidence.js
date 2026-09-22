import HlsObserver from './AutoLiveHlsObserver.js';
import Shadow from './AutoLiveDecisionShadow.js';
import {freeze, id, digest, revision} from './ExecutionTransferContract.js';

// Non-executing evidence vocabulary. No decoder is present in this module.
export const CAPABILITY_CLASSES = Object.freeze(['TRANSPORT_PRESENCE', 'PLAYLIST_PROGRESS',
    'SEGMENT_PROGRESS', 'TIMESTAMP_PROGRESS', 'MEDIA_DECODE_PROGRESS', 'ACTIVE_PROGRAM_PROGRESS', 'LOSS_CONFIRMATION']);
const kinds = ['EXTERNAL_HLS', 'MANAGED_INGEST', 'RETAINED_LIVE', 'BROWSER_PROGRAM', 'NONLIVE_MEDIA'];
const states = ['ONLINE', 'OFFLINE', 'CHECKING', 'UNKNOWN', 'UNCERTAIN', 'ERROR'];
export function evidence(input) {
    if (!input || !kinds.includes(input.kind) || !id(input.sourceId) || !digest(input.sourceFingerprint) ||
        !revision(input.authorityEpoch) || input.authorityEpoch < 1 || !id(input.authorityProcessSession) ||
        !revision(input.observedAt) || !revision(input.validUntil) || input.validUntil <= input.observedAt ||
        input.validUntil - input.observedAt > 10000 || !states.includes(input.state)) throw Error('INVALID_EVIDENCE');
    const browser = input.kind === 'BROWSER_PROGRAM';
    if (browser && (!digest(input.programIdentity) || !revision(input.ownershipRevision))) throw Error('PROGRAM_BINDING_REQUIRED');
    const caps = Object.fromEntries(CAPABILITY_CLASSES.map(k => [k, false]));
    caps.TRANSPORT_PRESENCE = ['EXTERNAL_HLS','MANAGED_INGEST'].includes(input.kind) && input.presence === true;
    caps.PLAYLIST_PROGRESS = input.kind === 'EXTERNAL_HLS' && input.playlistProgress === true;
    caps.SEGMENT_PROGRESS = caps.PLAYLIST_PROGRESS && input.segmentReachable === true;
    caps.TIMESTAMP_PROGRESS = caps.PLAYLIST_PROGRESS && input.manifestTimestampProgress === true;
    caps.MEDIA_DECODE_PROGRESS = browser && input.playbackProgressing === true && input.state === 'ONLINE';
    caps.ACTIVE_PROGRAM_PROGRESS = caps.MEDIA_DECODE_PROGRESS;
    caps.LOSS_CONFIRMATION = browser && input.confirmedLoss === true && input.state === 'OFFLINE';
    return freeze({version: 1, kind: input.kind, sourceId: input.sourceId, sourceFingerprint: input.sourceFingerprint,
        authorityEpoch: input.authorityEpoch, authorityProcessSession: input.authorityProcessSession,
        observedAt: input.observedAt, validUntil: input.validUntil, state: input.state, capabilities: caps,
        programIdentity: browser ? input.programIdentity : null, ownershipRevision: browser ? input.ownershipRevision : null,
        reason: typeof input.reason === 'string' && /^[A-Z0-9_]{1,64}$/.test(input.reason) ? input.reason : 'UNSPECIFIED',
        timestampBasis: caps.TIMESTAMP_PROGRESS ? 'MANIFEST_DECLARED' : 'NONE',
        headlessDecoderEquivalent: false, executionAllowed: false, serverTake: false});
}
export function usable(sample, binding, now) {
    return Boolean(sample && kinds.includes(sample.kind) && states.includes(sample.state) &&
        sample.capabilities && CAPABILITY_CLASSES.every(k => typeof sample.capabilities[k] === 'boolean') &&
        revision(sample.observedAt) && revision(sample.validUntil) && sample.validUntil > sample.observedAt &&
        sample.validUntil - sample.observedAt <= 10000 &&
        Number.isSafeInteger(now) && now >= sample.observedAt && now < sample.validUntil &&
        sample.sourceId === binding?.authorizedSourceId && sample.sourceFingerprint === binding?.sourceFingerprint &&
        sample.authorityEpoch === binding?.authorityEpoch && sample.authorityProcessSession === binding?.authorityProcessSession &&
        (sample.kind !== 'BROWSER_PROGRAM' || sample.programIdentity === binding.programIdentity && sample.ownershipRevision === binding.ownershipRevision));
}
export function compareHealth({server, browser, binding, now}) {
    const s = usable(server, binding, now), b = usable(browser, binding, now);
    let classification = 'INSUFFICIENT_EVIDENCE';
    if (s && b) {
        const sd = ['ONLINE','OFFLINE'].includes(server.state), bd = ['ONLINE','OFFLINE'].includes(browser.state);
        if (sd && bd && server.state !== browser.state) classification = 'DISAGREEMENT';
        else if (server.state === 'ONLINE' && browser.capabilities.MEDIA_DECODE_PROGRESS) classification = 'MATCH_HEALTHY';
        else if (server.state === 'OFFLINE' && browser.capabilities.LOSS_CONFIRMATION) classification = 'MATCH_LOSS';
        else if (!sd && bd) classification = 'SERVER_WEAKER';
        else if (sd && !bd) classification = 'BROWSER_WEAKER';
    }
    return freeze({classification, serverFreshAndBound: s, browserFreshAndBound: b,
        gaps: ['NO_HEADLESS_DECODER', 'NO_HEADLESS_CONFIRMED_LOSS', ...(!b ? ['NO_CURRENT_BROWSER_EVIDENCE'] : [])],
        // MATCH means observed agreement, not equivalent capabilities or permission.
        decoderEquivalent: false, transferReady: false, executionAllowed: false, serverTake: false});
}
export class AdvisoryHealthTiming {
    constructor({clock = () => Date.now()} = {}) { this.clock = clock; this.shadow = new Shadow({clock}); }
    update(sample, binding, {enabled = false, armed = false, liveObserved = false} = {}) {
        const ownerIdentity = JSON.stringify([binding?.authorityEpoch, binding?.authorityProcessSession, binding?.ownershipRevision]);
        if (this.ownerIdentity !== ownerIdentity) { this.shadow.reset(); this.ownerIdentity = ownerIdentity; }
        const fresh = usable(sample, binding, this.clock());
        const qualified = fresh && (sample.capabilities.PLAYLIST_PROGRESS && sample.capabilities.SEGMENT_PROGRESS ||
            sample.capabilities.MEDIA_DECODE_PROGRESS || sample.state === 'OFFLINE');
        const shadow = this.shadow.update({enabled, armed, sourceId: binding?.authorizedSourceId,
            sourceFingerprint: binding?.sourceFingerprint, browserStage: liveObserved ? 'LIVE' : null,
            health: {state: qualified ? sample.state : 'UNKNOWN', freshness: fresh ? 'FRESH' : 'STALE', validUntil: sample?.validUntil}});
        return freeze({...shadow, transportAdvisoryOnly: !sample?.capabilities.MEDIA_DECODE_PROGRESS,
            transferReady: false, executionAllowed: false, serverTake: false});
    }
}
export class HeadlessHlsProbe {
    constructor({http, clock = () => Date.now()} = {}) { Object.assign(this, {http, clock}); this.generation = 0; }
    async sample(source, binding) {
        if (!id(source?.id) || source.id !== binding?.authorizedSourceId || !digest(binding?.sourceFingerprint)) throw Error('SOURCE_BINDING_REQUIRED');
        // A superseding request cancels its predecessor and fences late completion.
        source = {...source}; binding = {...binding};
        const wasBusy = this.busy; this.busy = true;
        this.abort?.abort(); const abort = this.abort = new AbortController(), generation = ++this.generation;
        const key = JSON.stringify([source.id, source.endpoint, binding.sourceFingerprint, binding.authorityEpoch, binding.authorityProcessSession]);
        if (key !== this.key || wasBusy) { this.key = key; this.observer = new HlsObserver({http: this.http, clock: this.clock}); }
        const observer = this.observer;
        let result;
        try { result = await observer.sample(source, abort.signal); }
        catch { result = {state: 'ERROR', reason: 'PROBE_FAILED'}; }
        if (generation !== this.generation) return null;
        this.busy = false;
        const now = this.clock(), previous = result.diagnostics?.previous, current = result.diagnostics?.current;
        return evidence({kind: 'EXTERNAL_HLS', sourceId: source.id, sourceFingerprint: binding.sourceFingerprint,
            authorityEpoch: binding.authorityEpoch, authorityProcessSession: binding.authorityProcessSession,
            observedAt: now, validUntil: now + 10000, state: result.state, reason: result.reason,
            presence: result.playbackAvailable, playlistProgress: result.playlistProgressing,
            segmentReachable: result.segmentReachable,
            manifestTimestampProgress: Number.isFinite(previous?.date) && Number.isFinite(current?.date) && current.date > previous.date});
    }
    close() { ++this.generation; this.abort?.abort(); }
}
