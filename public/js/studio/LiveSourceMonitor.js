const STATES = new Set(["IDLE", "CHECKING", "ONLINE", "OFFLINE", "ERROR"]);
import trace from "../core/RuntimeTrace.js";
export const LIVE_SOURCE_READINESS_TIMEOUT_MS = 12000;
export const LIVE_SOURCE_RETRY_DELAY_MS = 5000;
export const LIVE_SOURCE_UNCERTAINTY_MS = 5000;

export default class LiveSourceMonitor {
    constructor({ consumerFactory, clock = () => Date.now(), setTimer = setTimeout,
        clearTimer = clearTimeout, readinessTimeoutMs = LIVE_SOURCE_READINESS_TIMEOUT_MS,
        retryDelayMs = LIVE_SOURCE_RETRY_DELAY_MS } = {}) {
        if (typeof consumerFactory !== "function") throw new TypeError("consumerFactory required");
        this.consumerFactory = consumerFactory;
        this.clock = clock;
        this.setTimer = (callback, delay) => setTimer(callback, delay);
        this.clearTimer = (id) => clearTimer(id);
        this.readinessTimeoutMs = readinessTimeoutMs;
        this.retryDelayMs = retryDelayMs;
        this.listeners = new Set(); this.generation = 0; this.consumer = null;
        this.attempt = 0;
        this.source = null; this.timeout = null; this.retryTimer = null;
        this.uncertaintyTimer = null;
        this.uncertaintyToken = 0;
        this.snapshot = this.createSnapshot({ sourceId: null, state: "IDLE" });
    }

    selectSource(source) {
        this.attempt = 0;
        this.stopLifecycle(); ++this.generation; this.source = null;
        if (!source) return this.publish({ sourceId: null, state: "IDLE" });
        if (source.kind !== "hls" || source.enabled === false || !source.url) {
            return this.publish({ sourceId: source.id || null, state: "ERROR",
                errorCategory: "CONFIGURATION" });
        }
        this.source = Object.freeze({ ...source });
        return this.startAttempt();
    }

    startAttempt() {
        const source = this.source;
        if (!source) return this.snapshot;
        this.stopConsumer(); this.clearRetry();
        const generation = ++this.generation;
        trace.record("live-monitor", "attempt-start", { sourceId: source.id,
            monitorGeneration: generation, retryAttempt: ++this.attempt,
            readinessDeadline: this.clock() + this.readinessTimeoutMs });
        this.publish({ sourceId: source.id, state: "CHECKING", endpoint: source.url });
        try {
            this.consumer = this.consumerFactory(source, {
                online: (metadata = {}) => this.accept(generation, source, "ONLINE", metadata),
                uncertain: (metadata = {}) => this.acceptUncertainty(generation, source, metadata),
                error: (category) => {
                    if (this.uncertaintyTimer !== null) {
                        this.acceptUncertainty(generation, source, { retry: true }); return;
                    }
                    const errorCategory = this.normalizeError(category);
                    this.accept(generation, source, this.isRecoverableError(errorCategory)
                        ? "OFFLINE" : "ERROR", { errorCategory });
                },
                offline: (metadata = {}) => this.accept(generation, source, "OFFLINE", metadata)
            }, { monitorGeneration: generation });
            // Install the deadline before start: shared ready observations can be synchronous.
            this.timeout = this.setTimer(() => this.accept(generation, source, "OFFLINE"),
                this.readinessTimeoutMs);
            Promise.resolve(this.consumer.start()).catch(() => this.accept(generation,
                source, "OFFLINE", { errorCategory: "UNKNOWN" }));
        } catch (error) {
            this.accept(generation, source, "ERROR", { errorCategory: "UNSUPPORTED" });
        }
        return this.snapshot;
    }

    accept(generation, source, state, metadata = {}) {
        if (generation !== this.generation || !STATES.has(state)) return;
        if (["OFFLINE", "ERROR"].includes(state) &&
            ["OFFLINE", "ERROR"].includes(this.snapshot.state)) return;
        if (["ONLINE", "OFFLINE", "ERROR"].includes(state)) {
            this.clearTimer(this.timeout); this.timeout = null;
        }
        if (state === "ONLINE") { this.clearRetry(); this.clearUncertainty(); }
        if (["OFFLINE", "ERROR"].includes(state)) {
            if (metadata.recoverInPlace !== true) this.stopConsumer();
            if (state === "OFFLINE" || this.isRecoverableError(metadata.errorCategory)) {
                this.scheduleRetry(generation);
            }
        }
        this.publish({ sourceId: source.id, state, endpoint: source.url,
            uncertain: false,
            ...(state === "ONLINE" ? { lastOnlineAt: new Date(this.clock()).toISOString(),
                errorCategory: null } : {}), ...metadata });
    }

    acceptUncertainty(generation, source, { retry = false } = {}) {
        if (generation !== this.generation || this.snapshot.state === "OFFLINE") return;
        this.clearTimer(this.timeout); this.timeout = null;
        // A source-level deadline survives consumer replacement. Repeated waiting
        // and retry edges must neither confirm absence nor postpone it forever.
        if (this.uncertaintyTimer === null) {
            const token = ++this.uncertaintyToken;
            trace.record("live-monitor", "uncertainty-deadline", { sourceId: source.id,
                monitorGeneration: generation, readinessDeadline: this.clock() + LIVE_SOURCE_UNCERTAINTY_MS });
            this.uncertaintyTimer = this.setTimer(() => {
                if (token !== this.uncertaintyToken) return;
                this.uncertaintyTimer = null;
                // The retired consumer cannot confirm failure of a replacement still
                // inside its own bounded readiness attempt. Its timeout/error supplies the verdict.
                if (generation !== this.generation && this.timeout !== null &&
                    this.snapshot.state === "CHECKING") return;
                if (this.source?.id === source.id) this.accept(this.generation,
                    this.source, "OFFLINE", { recoverInPlace: true });
            }, LIVE_SOURCE_UNCERTAINTY_MS);
        }
        if (retry && this.retryTimer === null) this.scheduleRetry(generation, 1000);
        this.publish({ sourceId: source.id, state: "CHECKING", endpoint: source.url,
            uncertain: true });
        trace.record("live-monitor", "uncertainty", { sourceId: source.id,
            monitorGeneration: generation, uncertain: true });
    }
    clearUncertainty() { ++this.uncertaintyToken;
        this.clearTimer(this.uncertaintyTimer); this.uncertaintyTimer = null; }

    scheduleRetry(generation, delay = this.retryDelayMs) {
        this.clearRetry();
        trace.record("live-monitor", "retry-scheduled", { monitorGeneration: generation,
            sourceId: this.source?.id, retryDeadline: this.clock() + delay });
        this.retryTimer = this.setTimer(() => {
            this.retryTimer = null;
            if (generation === this.generation && this.source) this.startAttempt();
        }, delay);
    }
    clearRetry() { this.clearTimer(this.retryTimer); this.retryTimer = null; }
    stop() { this.stopLifecycle(); this.source = null; ++this.generation;
        return this.publish({ sourceId: null, state: "IDLE" }); }
    destroy() { this.stop(); this.listeners.clear(); }
    getSnapshot() { return this.snapshot; }
    subscribe(listener) { if (typeof listener !== "function") return () => {};
        this.listeners.add(listener); listener(this.snapshot); return () => this.listeners.delete(listener); }
    stopConsumer() { this.clearTimer(this.timeout); this.timeout = null;
        const consumer = this.consumer; this.consumer = null; consumer?.destroy?.(); }
    stopLifecycle() { this.clearRetry(); this.clearUncertainty(); this.stopConsumer(); }
    publish(fields) { this.snapshot = this.createSnapshot({ ...this.snapshot, ...fields,
        checkedAt: new Date(this.clock()).toISOString() });
        trace.record("live-monitor", "health-transition", { state: this.snapshot.state,
            sourceId: this.snapshot.sourceId, monitorGeneration: this.generation });
        this.listeners.forEach((listener) => listener(this.snapshot)); return this.snapshot; }
    createSnapshot(value) { return Object.freeze({ sourceId: value.sourceId ?? null,
        state: value.state || "IDLE", checkedAt: value.checkedAt || null,
        lastOnlineAt: value.lastOnlineAt || null, errorCategory: value.errorCategory || null,
        generation: this.generation, retryActive: this.retryTimer !== null,
        uncertain: value.uncertain === true,
        width: Number.isFinite(value.width) ? value.width : null,
        height: Number.isFinite(value.height) ? value.height : null,
        endpoint: value.endpoint || null }); }
    normalizeError(value) { const category = String(value || "UNKNOWN").toUpperCase();
        return ["NETWORK", "MANIFEST", "MEDIA", "UNSUPPORTED", "CONFIGURATION"].includes(category)
            ? category : "UNKNOWN"; }
    isRecoverableError(category) {
        return !["UNSUPPORTED", "CONFIGURATION"].includes(category);
    }
}
