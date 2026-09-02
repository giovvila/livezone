export default class MediaLibraryManager {
    constructor(client, { durationProbe = probeMediaDuration } = {}) { this.client = client; this.durationProbe = durationProbe; this.assets = []; this.listeners = new Set(); this.state = "idle"; this.error = null; this.progress = null; }
    initialize() { if (!this.initializationPromise) this.initializationPromise = this.refresh().then(() => this.discoverUnknownDurations()); return this.initializationPromise; }
    async refresh(kind = null) { return this.run("loading", async () => { const result = await this.client.list(kind); this.assets = result.assets.map((asset) => Object.freeze({ ...asset, metadata: asset.metadata && Object.freeze({ ...asset.metadata }) })); return this.getSnapshot(); }); }
    listAssets({ kind = null } = {}) { return Object.freeze(this.assets.filter((asset) => !kind || asset.kind === kind)); }
    getAsset(id) { return this.assets.find((asset) => asset.id === id) || null; }
    async importAsset(file) {
        if (!(file instanceof Blob) || typeof file.name !== "string") throw new TypeError("A browser File is required.");
        return this.run("uploading", async () => {
            const result = await this.client.import(file, { onProgress: (progress) => { this.progress = progress; this.notify(); } });
            let asset = Object.freeze({ ...result.asset, metadata: result.asset.metadata && Object.freeze({ ...result.asset.metadata }) });
            this.assets = [...this.assets, asset]; this.progress = null;
            asset = await this.discoverDuration(asset);
            return asset;
        });
    }
    async discoverUnknownDurations() {
        for (const asset of [...this.assets]) {
            if (["video", "audio"].includes(asset.kind) &&
                !Number.isFinite(asset.metadata?.durationSeconds)) {
                await this.discoverDuration(asset);
            }
        }
        return this.getSnapshot();
    }
    async discoverDuration(asset) {
        if (!["video", "audio"].includes(asset?.kind)) return asset;
        if (Number.isFinite(asset.metadata?.durationSeconds) &&
            asset.metadata.durationSeconds > 0) return asset;
        let durationSeconds = null;
        try { durationSeconds = await this.durationProbe(asset); }
        catch { return asset; }
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return asset;
        try {
            const result = await this.client.updateMetadata(asset.id, { durationSeconds });
            const updated = Object.freeze({ ...result.asset,
                metadata: Object.freeze({ ...result.asset.metadata }) });
            this.assets = this.assets.map((candidate) => candidate.id === asset.id
                ? updated : candidate);
            this.notify();
            return updated;
        }
        catch { return asset; }
    }
    async deleteAsset(id, { referenceGuard } = {}) {
        if (typeof referenceGuard !== "function" || await referenceGuard(this.getAsset(id)) !== false) throw Object.assign(new Error("Complete source reference guard is required."), { code: "REFERENCE_GUARD_REQUIRED" });
        return this.run("deleting", async () => { const result = await this.client.remove(id); this.assets = this.assets.filter((asset) => asset.id !== id); return result.asset; });
    }
    subscribe(listener) { if (typeof listener !== "function") return () => {}; this.listeners.add(listener); listener(this.getSnapshot()); return () => this.listeners.delete(listener); }
    getSnapshot() { return Object.freeze({ state: this.state, error: this.error, progress: this.progress, assets: this.listAssets() }); }
    async run(state, operation) { this.state = state; this.error = null; this.notify(); try { const result = await operation(); this.state = "ready"; this.notify(); return result; } catch (error) { this.state = "error"; this.error = Object.freeze({ code: error.code || "UNKNOWN", message: error.message }); this.progress = null; this.notify(); throw error; } }
    notify() { const snapshot = this.getSnapshot(); this.listeners.forEach((listener) => listener(snapshot)); }
}

export function probeMediaDuration(asset, { document = globalThis.document,
    timeoutMs = 12000 } = {}) {
    if (!["video", "audio"].includes(asset?.kind) || !document?.createElement) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        const media = document.createElement(asset.kind === "audio" ? "audio" : "video");
        let timer = null;
        let finished = false;
        const finish = (value = null) => {
            if (finished) return; finished = true;
            media.removeEventListener("loadedmetadata", ready);
            media.removeEventListener("error", failed);
            if (timer !== null) clearTimeout(timer);
            media.removeAttribute?.("src");
            media.load?.();
            resolve(value);
        };
        const ready = () => finish(Number.isFinite(media.duration) && media.duration > 0
            ? media.duration : null);
        const failed = () => finish(null);
        media.preload = "metadata";
        media.addEventListener("loadedmetadata", ready, { once: true });
        media.addEventListener("error", failed, { once: true });
        timer = setTimeout(() => finish(null), timeoutMs);
        media.src = asset.url;
        media.load?.();
    });
}
