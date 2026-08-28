const STORAGE_KEY = "livezone.studio.dominantLive.v1";
const VERSION = 1;

export default class DominantLiveConfig {
    constructor({ storage = globalThis.localStorage, eventTarget = globalThis.window } = {}) {
        this.storage = storage;
        this.eventTarget = eventTarget;
        this.listeners = new Set();
        this.snapshot = this.load();
        this.handleStorage = this.handleStorage.bind(this);
        this.eventTarget?.addEventListener?.("storage", this.handleStorage);
    }

    getSnapshot() { return this.snapshot; }
    subscribe(listener) { if (typeof listener !== "function") return () => {};
        this.listeners.add(listener); listener(this.snapshot); return () => this.listeners.delete(listener); }
    setArmed(armed) { return this.update({ ...this.snapshot, armed: armed === true }); }
    setAuthorizedSourceId(sourceId) {
        return this.update({ ...this.snapshot, authorizedSourceId: this.normalizeId(sourceId) });
    }
    update(value, { persist = true } = {}) {
        this.snapshot = Object.freeze({ armed: value?.armed === true,
            authorizedSourceId: this.normalizeId(value?.authorizedSourceId) });
        if (persist) { try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({
            version: VERSION, ...this.snapshot })); } catch {} }
        this.listeners.forEach((listener) => listener(this.snapshot));
        return this.snapshot;
    }
    load() { try { const parsed = JSON.parse(this.storage?.getItem(STORAGE_KEY) || "null");
        if (!parsed || parsed.version !== VERSION || typeof parsed.armed !== "boolean" ||
            !Object.hasOwn(parsed, "authorizedSourceId")) return this.safeDefault();
        const id = this.normalizeId(parsed.authorizedSourceId);
        if (parsed.authorizedSourceId !== null && !id) return this.safeDefault();
        return Object.freeze({ armed: parsed.armed, authorizedSourceId: id });
    } catch { return this.safeDefault(); } }
    handleStorage(event) { if (event?.key !== STORAGE_KEY) return;
        let parsed; try { parsed = JSON.parse(event.newValue || "null"); } catch { parsed = null; }
        if (!parsed || parsed.version !== VERSION || typeof parsed.armed !== "boolean") {
            this.update(this.safeDefault(), { persist: false }); return;
        }
        const id = this.normalizeId(parsed.authorizedSourceId);
        this.update(parsed.authorizedSourceId !== null && !id ? this.safeDefault()
            : { armed: parsed.armed, authorizedSourceId: id }, { persist: false });
    }
    destroy() { this.eventTarget?.removeEventListener?.("storage", this.handleStorage);
        this.listeners.clear(); }
    normalizeId(value) { if (value === null || value === undefined || value === "") return null;
        const id = String(value).trim(); return id.length <= 120 && /^live-[a-z0-9-]+$/i.test(id) ? id : null; }
    safeDefault() { return Object.freeze({ armed: false, authorizedSourceId: null }); }
}

export { STORAGE_KEY as DOMINANT_LIVE_STORAGE_KEY };
