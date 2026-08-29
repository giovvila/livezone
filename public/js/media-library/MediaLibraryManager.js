export default class MediaLibraryManager {
    constructor(client) { this.client = client; this.assets = []; this.listeners = new Set(); this.state = "idle"; this.error = null; this.progress = null; }
    initialize() { if (!this.initializationPromise) this.initializationPromise = this.refresh(); return this.initializationPromise; }
    async refresh(kind = null) { return this.run("loading", async () => { const result = await this.client.list(kind); this.assets = result.assets.map((asset) => Object.freeze({ ...asset, metadata: asset.metadata && Object.freeze({ ...asset.metadata }) })); return this.getSnapshot(); }); }
    listAssets({ kind = null } = {}) { return Object.freeze(this.assets.filter((asset) => !kind || asset.kind === kind)); }
    getAsset(id) { return this.assets.find((asset) => asset.id === id) || null; }
    async importAsset(file) {
        if (!(file instanceof Blob) || typeof file.name !== "string") throw new TypeError("A browser File is required.");
        return this.run("uploading", async () => {
            const result = await this.client.import(file, { onProgress: (progress) => { this.progress = progress; this.notify(); } });
            this.assets = [...this.assets, Object.freeze({ ...result.asset })]; this.progress = null; return result.asset;
        });
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
