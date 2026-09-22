import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {freeze} from '../ExecutionTransferContract.js';

export const POLICY_VERSION = 'LOCAL_FIXTURE_SHADOW_1';
export const BROKER_POLICY_VERSION = 'BROKER_HLS_SHADOW_1';
export const STATES = Object.freeze(['DECODER_STARTING', 'DECODER_PROGRESS', 'DECODER_STALLED',
    'DECODER_ERROR', 'DECODER_ENDED', 'DECODER_UNAVAILABLE', 'DECODER_UNCERTAIN']);
export const PROFILES = Object.freeze({AUDIO_VIDEO: ['video', 'audio'], AUDIO_ONLY: ['audio'], VIDEO_ONLY: ['video']});
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const terminal = new Set(['DECODER_ERROR', 'DECODER_ENDED', 'DECODER_UNAVAILABLE']);

// Shadow decoded evidence only. Not an ownership or execution authorization.
export class DecoderEvidence {
    constructor({sourceId, sourceFingerprint, backend, workerId, workerGeneration, restartGeneration = 0,
        profile, broker = null, clock = () => performance.now(), wallClock = () => Date.now()}) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sourceId) || !hash(sourceFingerprint) || !hash(backend?.digest) ||
            !backend.version || !workerId || !integer(workerGeneration) || !integer(restartGeneration) ||
            !Object.hasOwn(PROFILES, profile)) throw Error('INVALID_DECODER_BINDING');
        Object.assign(this, {clock, wallClock});
        if (broker && (!hash(broker.renditionIdentity) || typeof broker.brokerGeneration !== 'string' ||
            broker.sourceId !== sourceId || broker.sourceFingerprint !== sourceFingerprint)) throw Error('INVALID_BROKER_BINDING');
        this.identity = freeze({sourceId, sourceFingerprint, backend: structuredClone(backend),
            policyVersion: broker ? BROKER_POLICY_VERSION : POLICY_VERSION, workerId, workerGeneration, restartGeneration, profile,
            ...(broker ? {brokerGeneration: broker.brokerGeneration, renditionIdentity: broker.renditionIdentity} : {})});
        this.required = PROFILES[profile]; this.trackSetGeneration = 0; this.timestampGeneration = 0;
        this.sequence = 0; this.startedAt = clock(); this.state = 'DECODER_STARTING'; this.reason = 'AWAITING_DECODE';
        this.tracks = {}; this.qualifiedSince = null; this.lastReceipt = null;
        if (broker) this.updateBroker(broker);
    }
    updateBroker(broker) {
        if (!broker || broker.brokerGeneration !== this.identity.brokerGeneration || broker.renditionIdentity !== this.identity.renditionIdentity ||
            broker.sourceId !== this.identity.sourceId || broker.sourceFingerprint !== this.identity.sourceFingerprint ||
            broker.brokerContentGeneration < (this.brokerContentGeneration ?? 0)) {
            this.close('DECODER_UNAVAILABLE', 'BROKER_BINDING_CHANGED'); return;
        }
        if (this.brokerDiscontinuity !== undefined && this.brokerDiscontinuity !== broker.discontinuity) {
            ++this.timestampGeneration; this.invalidate('BROKER_DISCONTINUITY');
        }
        this.brokerDiscontinuity = broker.discontinuity;
        this.brokerContentGeneration = broker.brokerContentGeneration; this.brokerReady = broker.ready;
    }
    ingest({workerGeneration, restartGeneration, kind, pts, count = 1, signature}) {
        if (this.closed || terminal.has(this.state) || workerGeneration !== this.identity.workerGeneration ||
            restartGeneration !== this.identity.restartGeneration || !this.required.includes(kind) ||
            !Number.isFinite(pts) || !Number.isSafeInteger(count) || count < 1 ||
            typeof signature !== 'string' || signature.length > 160) return false;
        const now = this.clock(); let track = this.tracks[kind];
        if (track && signature !== track.signature) {
            ++this.trackSetGeneration; this.invalidate('TRACK_SET_CHANGED'); track = null;
        } else if (track && (pts < track.pts || pts - track.pts > 2)) {
            ++this.timestampGeneration; this.invalidate('TIMESTAMP_DISCONTINUITY'); track = null;
        }
        if (!track) this.tracks[kind] = track = {signature, count: 0, frames: 0, pts, firstPts: pts,
            firstAt: now, lastAt: now, advancing: false};
        const previousPts = track.pts;
        track.count += count; ++track.frames; track.pts = pts;
        if (pts > previousPts) { track.lastAt = now; track.advancing = true; }
        this.lastReceipt = now;
        return true;
    }
    invalidate(reason) {
        this.tracks = {}; this.qualifiedSince = null; this.state = 'DECODER_UNCERTAIN'; this.reason = reason;
    }
    fail(state, reason) {
        if (!STATES.includes(state) || !/^[A-Z0-9_]{1,64}$/.test(reason)) throw Error('INVALID_DECODER_STATE');
        this.state = state; this.reason = reason; this.qualifiedSince = null;
    }
    close(state, reason) { this.fail(state, reason); this.closed = true; }
    snapshot() {
        const now = this.clock();
        if (!this.closed && !terminal.has(this.state)) {
            const tracks = this.required.map(kind => this.tracks[kind]);
            const ready = this.brokerReady !== false && tracks.every(t => t && t.advancing && t.frames >= 2 && now - t.lastAt <= 2000 &&
                t.lastAt - t.firstAt >= 500 && t.pts > t.firstPts &&
                // A fast buffered burst cannot buy wall-clock stability.
                (t.pts - t.firstPts) * 1000 <= now - t.firstAt + 1000);
            if (ready) {
                if (this.qualifiedSince === null) this.qualifiedSince = now;
                this.state = 'DECODER_PROGRESS'; this.reason = 'DECODED_TRACKS_ADVANCING';
            } else {
                this.qualifiedSince = null;
                const age = Math.max(...tracks.map(t => now - (t?.lastAt ?? this.startedAt)));
                this.state = age > 5000 ? 'DECODER_STALLED' :
                    age > 2000 || Object.keys(this.tracks).length ? 'DECODER_UNCERTAIN' : 'DECODER_STARTING';
                this.reason = this.brokerReady === false ? 'BROKER_NOT_FRESH' : age > 2000 ? 'REQUIRED_TRACK_NOT_FRESH' : 'AWAITING_SUSTAINED_TRACKS';
            }
        }
        const sample = {...this.identity, trackSetGeneration: this.trackSetGeneration,
            timestampGeneration: this.timestampGeneration, sequence: ++this.sequence,
            state: this.state, reason: this.reason, observedAt: this.wallClock(), receivedMonotonic: now,
            freshnessMs: this.lastReceipt === null ? null : Math.max(0, now - this.lastReceipt), validForMs: 2000,
            qualifiedMs: this.qualifiedSince === null ? 0 : now - this.qualifiedSince,
            tracks: structuredClone(this.tracks), localFixtureOnly: !this.identity.brokerGeneration,
            ...(this.identity.brokerGeneration ? {brokerContentGeneration: this.brokerContentGeneration, brokerReady: this.brokerReady} : {}),
            executionAllowed: false, serverTake: false, transferReady: false};
        return freeze({...sample, evidenceDigest: sha256(JSON.stringify(sample))});
    }
}

export function validSample(sample) {
    if (!sample || !hash(sample.evidenceDigest)) return false;
    const {evidenceDigest, ...body} = sample;
    return STATES.includes(sample.state) && (sample.policyVersion === POLICY_VERSION && sample.localFixtureOnly === true ||
        sample.policyVersion === BROKER_POLICY_VERSION && sample.localFixtureOnly === false &&
        typeof sample.brokerGeneration === 'string' && hash(sample.renditionIdentity) && integer(sample.brokerContentGeneration)) &&
        sample.executionAllowed === false && sample.serverTake === false &&
        sample.transferReady === false && sha256(JSON.stringify(body)) === evidenceDigest;
}

// Immutable generation provenance; sample advancement is deliberately not a CAS equality condition.
export function provenance(sample) {
    if (!validSample(sample)) throw Error('INVALID_DECODER_EVIDENCE');
    return freeze({version: sample.brokerGeneration ? 2 : 1, sourceId: sample.sourceId, sourceFingerprint: sample.sourceFingerprint,
        backendDigest: sample.backend.digest, backendVersion: sample.backend.version, policyVersion: sample.policyVersion,
        workerId: sample.workerId, workerGeneration: sample.workerGeneration, restartGeneration: sample.restartGeneration,
        profile: sample.profile, trackSetGeneration: sample.trackSetGeneration, timestampGeneration: sample.timestampGeneration,
        ...(sample.brokerGeneration ? {brokerGeneration: sample.brokerGeneration, renditionIdentity: sample.renditionIdentity} : {})});
}
export function sameEvidenceGeneration(expected, current) {
    return JSON.stringify(provenance(expected)) === JSON.stringify(provenance(current)) && current.sequence >= expected.sequence &&
        (current.brokerContentGeneration ?? 0) >= (expected.brokerContentGeneration ?? 0);
}

export class DecoderEvidenceReceiver {
    constructor({clock = () => performance.now()} = {}) { this.clock = clock; this.sample = null; }
    bind(identity) { this.binding = {...identity}; this.sample = null; this.receivedAt = null; this.boundAt = this.clock(); }
    accept(sample) {
        if (!validSample(sample) || !this.binding || sample.receivedMonotonic < this.boundAt ||
            this.clock() < sample.receivedMonotonic || this.clock() - sample.receivedMonotonic > 2000 ||
            Object.entries(this.binding).some(([k, v]) => sample[k] !== v) ||
            sample.sequence <= (this.sample?.sequence ?? 0)) return false;
        this.sample = sample; this.receivedAt = this.clock(); return true;
    }
    current() {
        if (!this.sample || this.clock() - this.receivedAt > 2000) return null;
        return this.sample;
    }
}
