// Local-only, bounded, in-memory diagnostics. Never record raw snapshots, URLs or errors.
const NUMBERS = new Set(["mediaErrorCode", "retryDelayMs", "maxRetryDelayMs", "retryFailures", "healthDemandCount", "generation", "monitorGeneration", "consumerGeneration", "lossGeneration", "remainingMs", "revision",
    "currentTime", "lastProgressTime", "readyState", "bufferedSeconds", "watchdogDeadline",
    "graceDeadline", "readinessDeadline", "retryDeadline", "retryAttempt", "httpStatus",
    "initialTime", "expectedTime", "eventSourceState", "playbackStartedAt",
    "publisherPresentAt", "requestDurationMs", "networkState", "hlsGeneration", "lastHealthyAt",
    "requestCount", "playlistSequence", "fragmentCount", "stableElapsed", "lastProgressAge", "duration",
    "videoWidth", "videoHeight", "rangeIndex", "rangeStart", "rangeEnd", "videoElements", "audioElements", "pendingAudioPlays"]);
const FLAGS = new Set(["paused", "muted", "ended", "playing", "hlsFatal", "graceExpired", "sessionActive",
    "lossSlateActive", "publisherPresent", "hlsAvailable", "endpointMatch", "uncertain", "lossTimerActive", "waiting", "stalled", "error", "playbackProgressing",
    "transitionBusy", "metadataReady", "durationKnown", "playbackReady", "pendingTransition", "pendingPublication", "seeking", "pendingMotionPlay", "motionDeferred", "loop"]);
const LABELS = new Set(["sourceId", "programSourceId", "sceneId", "previousSceneId", "publisherSessionId", "kind", "state", "mode", "reason",
    "sourceState", "ownershipState", "acquisitionState", "consumer", "instanceId",
    "selectedPath", "probedPath", "apiState", "playerState", "phase", "authority", "sessionId", "transportState"]);
const label = value => typeof value === "string" && /^[a-zA-Z0-9_ .-]{1,128}$/.test(value);

// Export-only inspection: no observer, new requests, timers or performance-buffer changes.
// Resource Timing does not expose pending requests, Range headers or socket occupancy.
export function mediaResourceTiming(performance = globalThis.performance, location = globalThis.location) {
    const result = { timeOrigin: performance?.timeOrigin, pendingRequests: "not-exposed",
        rangeHeaders: "not-exposed", entries: [] };
    try {
        const entries = performance.getEntriesByType("resource").filter(entry => {
            const url = new URL(entry.name, location.href);
            return url.origin === location.origin && url.pathname.startsWith("/media/");
        });
        result.truncated = entries.length > 128;
        result.entries = entries.slice(-128).map(entry => {
            const url = new URL(entry.name, location.href);
            const row = { pathname: url.pathname };
            for (const key of ["startTime", "duration", "fetchStart", "workerStart", "redirectStart", "redirectEnd",
                "domainLookupStart", "domainLookupEnd", "connectStart", "connectEnd", "secureConnectionStart",
                "requestStart", "responseStart", "responseEnd", "transferSize", "encodedBodySize", "decodedBodySize", "responseStatus"])
                if (Number.isFinite(entry[key])) row[key] = entry[key];
            for (const key of ["initiatorType", "nextHopProtocol", "deliveryType"])
                if (label(entry[key])) row[key] = entry[key];
            return row;
        });
    } catch { result.unavailable = true; }
    return result;
}

export class RuntimeTrace {
    constructor({ enabled = false, capacity = 1000, now = () => Date.now() } = {}) {
        this.enabled = enabled;
        this.capacity = Number.isInteger(capacity) ? Math.max(1, Math.min(2000, capacity)) : 1000;
        this.now = now; this.entries = []; this.sequence = 0;
    }
    record(scope, event, fields = {}) {
        if (!this.enabled) return;
        try {
            if (!label(scope) || !label(event)) return;
            const at = this.now();
            const previous = this.entries.at(-1);
            const entry = { sequence: ++this.sequence, at,
                deltaMs: previous ? at - previous.at : 0, scope, event };
            for (const [key, value] of Object.entries(fields)) {
                if (NUMBERS.has(key) && Number.isFinite(value) ||
                    FLAGS.has(key) && typeof value === "boolean" || LABELS.has(key) && label(value)) {
                    entry[key] = value;
                }
            }
            this.entries.push(Object.freeze(entry));
            if (this.entries.length > this.capacity) this.entries.shift();
        } catch { /* Diagnostics must never interrupt the runtime. */ }
    }
    snapshot() { return Object.freeze([...this.entries]); }
    clear() { this.entries = []; }
    exportJSON() { return JSON.stringify({ version: 1, entries: this.snapshot(),
        mediaResourceTiming: this.enabled ? mediaResourceTiming() : undefined }, null, 2); }
    download() {
        if (!this.enabled || !globalThis.document) return;
        const url = URL.createObjectURL(new Blob([this.exportJSON()], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url; link.download = "livezone-runtime-trace.json";
        link.click(); URL.revokeObjectURL(url);
    }
}

const trace = new RuntimeTrace({ enabled: ["127.0.0.1", "localhost", "[::1]"]
    .includes(globalThis.location?.hostname) });
if (trace.enabled && !globalThis.livezoneRuntimeTrace) {
    Object.defineProperty(globalThis, "livezoneRuntimeTrace", { value: Object.freeze({
        snapshot: () => trace.snapshot(), exportJSON: () => trace.exportJSON(),
        download: () => trace.download(), clear: () => trace.clear()
    }), configurable: true });
}
export default trace;
export function programTraceFields(snapshot) {
    return { revision: snapshot?.revision, publisherSessionId: snapshot?.publisherSessionId,
        sceneId: snapshot?.scene?.id,
        lossSlateActive: snapshot?.graphics?.items?.some(item => item.id === "autolive-loss-slate") === true,
        sourceId: snapshot?.source?.id, kind: snapshot?.source?.kind,
        initialTime: snapshot?.playback?.initialTime, playing: snapshot?.playback?.playing,
        playbackStartedAt: Date.parse(snapshot?.playback?.startedAt),
        ended: snapshot?.playback?.ended };
}
