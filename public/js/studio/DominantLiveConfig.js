import authorizationDiagnostics from "./AutoLiveAuthorizationDiagnostics.js";

const STORAGE_KEY = "livezone.studio.dominantLive.v1";
const VERSION = 1;
let nextInstanceId = 0;

export default class DominantLiveConfig {
    constructor({ storage, eventTarget = globalThis.window,
        diagnostics = authorizationDiagnostics } = {}) {
        try { this.storage = storage === undefined ? globalThis.localStorage : storage; }
        catch { this.storage = null; }
        this.diagnostics = diagnostics;
        this.instanceId = `autolive-config-${++nextInstanceId}`;
        this.eventTarget = eventTarget;
        this.listeners = new Set();
        this.snapshot = this.load();
        this.logRead();
        this.handleStorage = this.handleStorage.bind(this);
        this.eventTarget?.addEventListener?.("storage", this.handleStorage);
    }

    getSnapshot() { return this.snapshot; }
    subscribe(listener) { if (typeof listener !== "function") return () => {};
        this.listeners.add(listener); listener(this.snapshot); return () => this.listeners.delete(listener); }
    setArmed(armed) { return this.mutate({ armed: armed === true }); }
    setAuthorizedSourceId(sourceId, { sourceKind = null } = {}) {
        return this.mutate({ authorizedSourceId: this.normalizeId(sourceId) }, sourceKind);
    }
    setAutoInterruptSource(sourceId, { sourceKind = null } = {}) {
        const id = this.normalizeId(sourceId);
        return this.mutate({ armed: id !== null, authorizedSourceId: id }, sourceKind);
    }
    mutate(patch, sourceKind = null) {
        if(this.authorityMutation)return this.authorityMutation(patch);
        // Storage owns both fields. Another document may have saved before its
        // storage event reaches this instance; never merge with a stale snapshot.
        const latest = this.load();
        let result = this.snapshot;
        if (this.readSucceeded) {
            this.snapshot = latest;
            result = this.update({ ...latest, ...patch });
        } else {
            this.lastWrite = Object.freeze({ ok: false, reason: "STORAGE_READ_FAILED",
                writeSucceeded: false, readBackSucceeded: false });
        }
        this.diagnostics.record("AUTOLIVE_AUTH_WRITE", {
            ...this.diagnosticContext(), sourceId: patch.authorizedSourceId ?? result.authorizedSourceId,
            sourceKind, armed: result.armed, authorizedSourceId: result.authorizedSourceId,
            requestedArmed: patch.armed ?? null,
            requestedSourceId: Object.hasOwn(patch, "authorizedSourceId") ? patch.authorizedSourceId : null,
            ...this.lastWrite });
        return result;
    }
    update(value, { persist = true } = {}) {
        const next = Object.freeze({ armed: value?.armed === true,
            authorizedSourceId: this.normalizeId(value?.authorizedSourceId) });
        if (persist) {
            let writeSucceeded = false;
            try {
                if (!this.storage) throw new Error("storage-unavailable");
                const serialized = JSON.stringify({ version: VERSION, ...next });
                this.storage.setItem(STORAGE_KEY, serialized);
                writeSucceeded = true;
                if (this.storage.getItem(STORAGE_KEY) !== serialized) throw new Error("write-not-retained");
                this.lastWrite = Object.freeze({ ok: true, reason: "PERSISTED",
                    writeSucceeded, readBackSucceeded: true });
            } catch {
                this.lastWrite = Object.freeze({ ok: false, reason: "PERSISTENCE_FAILED",
                    writeSucceeded, readBackSucceeded: false });
                return this.snapshot;
            }
        }
        this.snapshot = next;
        this.storedSourceId = value?.authorizedSourceId ?? null;
        this.storedArmed = next.armed;
        this.listeners.forEach((listener) => listener(this.snapshot));
        return this.snapshot;
    }
    load() { this.readSucceeded = false;
        try {
        if (!this.storage) return this.safeDefault();
        const raw = this.storage.getItem(STORAGE_KEY);
        this.readSucceeded = true;
        const parsed = JSON.parse(raw || "null");
        this.storedSourceId = parsed?.authorizedSourceId ?? null;
        this.storedArmed = typeof parsed?.armed === "boolean" ? parsed.armed : null;
        if (!parsed || parsed.version !== VERSION || typeof parsed.armed !== "boolean" ||
            !Object.hasOwn(parsed, "authorizedSourceId")) return this.safeDefault();
        const id = this.normalizeId(parsed.authorizedSourceId);
        if (parsed.authorizedSourceId !== null && !id) return this.safeDefault();
        return Object.freeze({ armed: parsed.armed, authorizedSourceId: id });
    } catch { return this.safeDefault(); } }
    handleStorage(event) { if (this.authorityMutation || event?.key !== STORAGE_KEY) return;
        let parsed; try { parsed = JSON.parse(event.newValue || "null"); } catch { parsed = null; }
        if (!parsed || parsed.version !== VERSION || typeof parsed.armed !== "boolean") {
            this.update(this.safeDefault(), { persist: false }); return;
        }
        const id = this.normalizeId(parsed.authorizedSourceId);
        this.update(parsed.authorizedSourceId !== null && !id ? this.safeDefault()
            : { armed: parsed.armed, authorizedSourceId: id }, { persist: false });
    }
    logRead(catalog) {
        const id = this.snapshot.authorizedSourceId;
        const source = catalog?.getSources?.().find(source => source.id === id);
        const finalAuthorizedSourceId = source?.kind === "hls" && source.enabled !== false ? id : null;
        this.diagnostics.record("AUTOLIVE_AUTH_READ", { ...this.diagnosticContext(),
            phase: catalog ? "CATALOG_RESOLUTION" : "CONFIG_LOAD", armed: this.snapshot.armed,
            storedArmed: this.storedArmed ?? null, authorizedSourceId: id,
            readSucceeded: this.readSucceeded, storedSourceId: this.storedSourceId ?? null,
            normalizedSourceId: id, catalogMatch: catalog ? Boolean(source) : null, finalAuthorizedSourceId });
    }
    diagnosticContext() { return { origin: globalThis.location?.origin ?? null,
        storageKey: STORAGE_KEY, schemaVersion: VERSION, instanceId: this.instanceId,
        storageAvailable: Boolean(this.storage) }; }
    destroy() { this.eventTarget?.removeEventListener?.("storage", this.handleStorage);
        this.listeners.clear(); }
    normalizeId(value) { if (value === null || value === undefined || value === "") return null;
        // Bootstrap LIVE IDs (for example primary-live) do not use the operator prefix.
        // Eligibility is checked against the catalog by the controller and source UI.
        const id = String(value).trim(); return id.length <= 120 && /^[a-z0-9][a-z0-9_-]*$/i.test(id) ? id : null; }
    safeDefault() { return Object.freeze({ armed: false, authorizedSourceId: null }); }
}

export { STORAGE_KEY as DOMINANT_LIVE_STORAGE_KEY };
