const STATES = new Set(["IDLE", "CHECKING", "ONLINE", "OFFLINE", "ERROR"]);

export default class LiveSourceMonitor {
    constructor({ consumerFactory, clock = () => Date.now(), setTimer = setTimeout,
        clearTimer = clearTimeout, readinessTimeoutMs = 12000 } = {}) {
        if (typeof consumerFactory !== "function") throw new TypeError("consumerFactory required");
        this.consumerFactory = consumerFactory;
        this.clock = clock;
        this.setTimer = (callback, delay) => setTimer(callback, delay);
        this.clearTimer = (id) => clearTimer(id);
        this.readinessTimeoutMs = readinessTimeoutMs;
        this.listeners = new Set(); this.generation = 0; this.consumer = null;
        this.snapshot = this.createSnapshot({ sourceId: null, state: "IDLE" });
    }

    selectSource(source) {
        this.stopConsumer();
        const generation = ++this.generation;
        if (!source) return this.publish({ sourceId: null, state: "IDLE" });
        if (source.kind !== "hls" || source.enabled === false || !source.url) {
            return this.publish({ sourceId: source.id || null, state: "ERROR",
                errorCategory: "CONFIGURATION" });
        }
        this.publish({ sourceId: source.id, state: "CHECKING", endpoint: source.url });
        try {
            this.consumer = this.consumerFactory(source, {
                online: (metadata = {}) => this.accept(generation, source, "ONLINE", metadata),
                error: (category) => this.accept(generation, source, "ERROR",
                    { errorCategory: this.normalizeError(category) }),
                offline: () => this.accept(generation, source, "OFFLINE")
            });
            this.consumer.start();
            this.timeout = this.setTimer(() => this.accept(generation, source, "OFFLINE"),
                this.readinessTimeoutMs);
        } catch (error) {
            this.accept(generation, source, "ERROR", { errorCategory: "UNSUPPORTED" });
        }
        return this.snapshot;
    }

    accept(generation, source, state, metadata = {}) {
        if (generation !== this.generation || !STATES.has(state)) return;
        if (["ONLINE", "OFFLINE", "ERROR"].includes(state)) {
            this.clearTimer(this.timeout); this.timeout = null;
        }
        this.publish({ sourceId: source.id, state, endpoint: source.url,
            ...(state === "ONLINE" ? { lastOnlineAt: new Date(this.clock()).toISOString(),
                errorCategory: null } : {}), ...metadata });
    }

    stop() { this.stopConsumer(); ++this.generation; return this.publish({ sourceId: null, state: "IDLE" }); }
    destroy() { this.stop(); this.listeners.clear(); }
    getSnapshot() { return this.snapshot; }
    subscribe(listener) { if (typeof listener !== "function") return () => {};
        this.listeners.add(listener); listener(this.snapshot); return () => this.listeners.delete(listener); }
    stopConsumer() { this.clearTimer(this.timeout); this.timeout = null;
        const consumer = this.consumer; this.consumer = null; consumer?.destroy?.(); }
    publish(fields) { this.snapshot = this.createSnapshot({ ...this.snapshot, ...fields,
        checkedAt: new Date(this.clock()).toISOString() });
        this.listeners.forEach((listener) => listener(this.snapshot)); return this.snapshot; }
    createSnapshot(value) { return Object.freeze({ sourceId: value.sourceId ?? null,
        state: value.state || "IDLE", checkedAt: value.checkedAt || null,
        lastOnlineAt: value.lastOnlineAt || null, errorCategory: value.errorCategory || null,
        width: Number.isFinite(value.width) ? value.width : null,
        height: Number.isFinite(value.height) ? value.height : null,
        endpoint: value.endpoint || null }); }
    normalizeError(value) { const category = String(value || "UNKNOWN").toUpperCase();
        return ["NETWORK", "MANIFEST", "MEDIA", "UNSUPPORTED", "CONFIGURATION"].includes(category)
            ? category : "UNKNOWN"; }
}
