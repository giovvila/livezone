import trace from "../core/RuntimeTrace.js";
import LiveSourceMonitor from "./LiveSourceMonitor.js";

// Resolve the trusted single-ingest mapping before selecting its health authority.
// Managed health stays server-side; other HLS endpoints stay in the browser.
export default class SourcePresenceMonitor {
    constructor({ fetchImplementation = globalThis.fetch?.bind(globalThis),
        setTimer = globalThis.setTimeout.bind(globalThis),
        clearTimer = globalThis.clearTimeout.bind(globalThis),
        pollMs = 1000, timeoutMs = 2000, clock = () => Date.now(), externalConsumerFactory = null } = {}) {
        Object.assign(this, { fetchImplementation, setTimer, clearTimer, pollMs, timeoutMs, clock });
        this.externalConsumerFactory = externalConsumerFactory;
        this.listeners = new Set(); this.generation = 0; this.lifecycle = 0; this.retryAttempt = 0;
        this.snapshot = Object.freeze({ sourceId: null, state: "IDLE", sourceHealth: true });
    }
    subscribe(fn) { this.listeners.add(fn); fn(this.snapshot); return () => this.listeners.delete(fn); }
    getSnapshot() { return this.snapshot; }
    refresh() { if (this.source) this.selectSource(this.source); }
    selectSource(source) {
        this.stop(); this.source = source;
        this.retryAttempt = 0;
        if (source && this.externalConsumerFactory) {
            this.snapshot = Object.freeze({ sourceId: source.id, state: "CHECKING",
                sourceHealth: true, generation: ++this.generation, authority: "unresolved" });
            this.listeners.forEach(fn => fn(this.snapshot));
        }
        if (source) void this.poll(this.lifecycle);
    }
    stop() {
        ++this.lifecycle; this.clearTimer(this.timer); this.clearTimer(this.deadline);
        this.abort?.abort(); this.source = null;
        this.externalUnsubscribe?.(); this.externalUnsubscribe = null;
        this.externalMonitor?.destroy(); this.externalMonitor = null;
        this.externalHealthDemandRelease?.(); this.externalHealthDemandRelease=null;
        this.managedIngestId = null;
    }
    destroy() { this.stop(); this.listeners.clear(); }
    startExternal(source, lifecycle) {
        this.externalHealthDemandRelease?.();
        this.externalHealthDemandRelease=this.externalConsumerFactory?.retainSource?.(source);
        const monitor = this.externalMonitor = new LiveSourceMonitor({
            consumerFactory: this.externalConsumerFactory, clock: this.clock,
            setTimer: this.setTimer, clearTimer: this.clearTimer
        });
        this.externalUnsubscribe = monitor.subscribe(snapshot => {
            if (lifecycle !== this.lifecycle || snapshot.sourceId !== source.id) return;
            // One sequence across polling, player attempts and authority changes.
            // ERROR means this HLS source cannot play; it is not API uncertainty.
            const retryingLoss = snapshot.state === "CHECKING" && !snapshot.uncertain &&
                this.snapshot.sourceId === source.id && this.snapshot.authority === "external-hls" &&
                this.snapshot.state === "OFFLINE";
            const state = snapshot.state === "ERROR" || retryingLoss ? "OFFLINE" : snapshot.state;
            this.snapshot = Object.freeze({ sourceId: source.id, state,
                generation: ++this.generation, sourceHealth: true,
                consumerGeneration: snapshot.generation,
                authority: "external-hls", reason: `HLS_${state}`,
                retryActive: snapshot.retryActive, uncertain: snapshot.uncertain === true,
                checkedAt: snapshot.checkedAt });
            trace.record("source-health", "external-hls-observation", {
                sourceId: source.id, state, reason: this.snapshot.reason,
                monitorGeneration: this.generation });
            this.listeners.forEach(fn => fn(this.snapshot));
        });
        monitor.selectSource(source);
    }
    async poll(lifecycle) {
        if (lifecycle !== this.lifecycle || !this.source) return;
        const source = this.source;
        const generation = ++this.generation;
        const requestedAt = this.clock();
        const retryAttempt = this.retryAttempt++;
        const selectedPath = safePath(source.url);
        let publisherPresentAt = null;
        trace.record("source-health", "checking-start", { sourceId: source.id, monitorGeneration: generation,
            selectedPath, retryAttempt, readinessDeadline: requestedAt + this.timeoutMs });
        const abort = this.abort = new AbortController();
        let timedOut = false; let onAbort;
        const cancelled = new Promise((_, reject) => {
            onAbort = () => reject(new Error("presence-request-aborted"));
            abort.signal.addEventListener("abort", onAbort, { once: true });
        });
        const deadline = this.deadline = this.setTimer(() => {
            timedOut = true; abort.abort();
        }, this.timeoutMs);
        let state = "ERROR", reason = "NETWORK_ERROR", phase = "fetch";
        let httpStatus = null, publisherPresent = null, hlsAvailable = null;
        let endpointMatch = null, probedPath = null, apiState = null;
        try {
            // Bound the complete request, including body parsing, even if an
            // implementation fails to settle its promise when aborted.
            const request = (async () => {
                const response = await this.fetchImplementation("/api/media-ingest/status?sourceOnly=1", {
                    cache: "no-store", credentials: "same-origin", signal: abort.signal
                });
                httpStatus = Number.isInteger(response?.status) ? response.status : null;
                if (!response?.ok) { reason = "HTTP_ERROR"; throw new Error("presence-http-error"); }
                phase = "body";
                return response.json();
            })();
            const status = await Promise.race([request, cancelled]);
            if (lifecycle !== this.lifecycle) return;
            reason = "INVALID_RESPONSE";
            if (status && typeof status === "object") {
                // The trusted server descriptor is the existing explicit ingest
                // mapping. Neither hostname nor configRef/origin implies ingest.
                // Unknown mapping fails closed; never use player fallback for a
                // previously mapped managed ingest when its API becomes uncertain.
                const mapped = typeof status.ingestId === "string" && status.ingestId.length > 0 &&
                    isHttpEndpoint(status.playbackHlsUrl);
                if (this.externalConsumerFactory && !this.managedIngestId) {
                    if (!mapped || !isHttpEndpoint(source.url)) throw new Error("invalid-ingest-mapping");
                    if (!sameEndpoint(source.url, status.playbackHlsUrl)) {
                        this.startExternal(source, lifecycle);
                        return;
                    }
                    this.managedIngestId = status.ingestId;
                }
                apiState = ["offline", "live", "connecting", "error"].includes(status.state) ? status.state : null;
                publisherPresent = typeof status.health?.publisherPresent === "boolean" ? status.health.publisherPresent : null;
                hlsAvailable = typeof status.health?.hlsAvailable === "boolean" ? status.health.hlsAvailable : null;
                publisherPresentAt = Date.parse(status.lastSeenAt);
                endpointMatch = sameEndpoint(source.url, status.playbackHlsUrl) &&
                    (!this.managedIngestId || status.ingestId === this.managedIngestId);
                probedPath = safePath(status.playbackHlsUrl);
                if (!endpointMatch) reason = "ENDPOINT_MISMATCH";
                else if (apiState === "offline" && publisherPresent === false) {
                    state = "OFFLINE"; reason = "PUBLISHER_ABSENT";
                } else if (["live", "connecting"].includes(apiState) && publisherPresent === true) {
                    state = "ONLINE"; reason = "PUBLISHER_PRESENT";
                } else if (apiState === "error") reason = "PRESENCE_UNAVAILABLE";
                else if (apiState === "connecting" && publisherPresent === false) reason = "PUBLISHER_NOT_READY";
            }
        } catch {
            if (timedOut) reason = "CHECKING_TIMEOUT";
            else if (phase === "body") reason = "INVALID_RESPONSE";
        } finally {
            this.clearTimer(deadline);
            abort.signal.removeEventListener("abort", onAbort);
        }
        if (lifecycle !== this.lifecycle || abort.signal.aborted && this.source !== source) return;
        const retryDeadline = this.clock() + this.pollMs;
        if (timedOut) trace.record("source-health", "checking-timeout", {
            sourceId: source.id, monitorGeneration: generation, reason, retryAttempt });
        this.snapshot = Object.freeze({ sourceId: source.id, state, generation,
            authority: this.managedIngestId ? "managed-ingest" : "unresolved",
            ingestId: this.managedIngestId,
            sourceHealth: true, retryActive: state !== "ONLINE", reason,
            uncertain: state === "ERROR" && reason !== "ENDPOINT_MISMATCH",
            httpStatus, publisherPresent, hlsAvailable, endpointMatch, selectedPath, probedPath, apiState,
            checkingStartedAt: requestedAt, retryAttempt, retryDeadline,
            checkedAt: new Date(this.clock()).toISOString() });
        trace.record("source-health", "observation", { sourceId: source.id, state, reason,
            monitorGeneration: generation, publisherPresentAt,
            httpStatus, publisherPresent, hlsAvailable, endpointMatch, selectedPath, probedPath, apiState,
            retryAttempt, retryDeadline,
            requestDurationMs: this.clock() - requestedAt });
        this.listeners.forEach(fn => fn(this.snapshot));
        if (lifecycle === this.lifecycle) this.timer = this.setTimer(() => void this.poll(lifecycle), this.pollMs);
    }
}

function isHttpEndpoint(value) {
    try { return ["http:", "https:"].includes(new URL(value).protocol); }
    catch { return false; }
}

function safePath(value) {
    try {
        const url = new URL(value);
        if (url.username || url.password || url.search || url.hash) return null;
        return url.pathname.match(/^\/([a-z0-9_-]{1,80})\/index\.m3u8$/i)?.[1] || null;
    } catch { return null; }
}

function sameEndpoint(left, right) {
    try {
        const normalize = value => { const url = new URL(value);
            if (url.hostname === "localhost") url.hostname = "127.0.0.1";
            return url.href; };
        return normalize(left) === normalize(right);
    } catch { return false; }
}
