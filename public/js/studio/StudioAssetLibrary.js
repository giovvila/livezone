const STORAGE_KEY = "livezone.studio.assetLibrary.overlay.v1";
const SCHEMA_VERSION = 1;
const ALLOWED_KINDS = Object.freeze(["video", "audio", "still", "logo"]);
const MAX_OPERATOR_ASSETS = 100;
const MAX_NAME_LENGTH = 120;
const MAX_ID_LENGTH = 120;
const MAX_URL_LENGTH = 4096;

export default class StudioAssetLibrary {

    constructor({
        storage,
        configUrl = new URL("../../config/assets.json", import.meta.url),
        uuidFactory = () => globalThis.crypto?.randomUUID?.()
    } = {}) {
        this.storage = storage === undefined ? this.getDefaultStorage() : storage;
        this.configUrl = configUrl;
        this.uuidFactory = uuidFactory;
        this.assets = new Map();
        this.operatorAssetIds = new Set();
        this.listeners = new Set();
        this.referenceGuard = null;
        this.initializationPromise = null;
        this.report = null;
        this.initialized = false;
        this.mutating = false;
    }

    initialize() {
        if (!this.initializationPromise) {
            this.initializationPromise = this.initializeInternal();
        }
        return this.initializationPromise;
    }

    async initializeInternal() {
        let response;
        let document;
        try {
            response = await fetch(this.configUrl);
            if (!response.ok) {
                return this.finish("unavailable", 0, 0, [
                    { reason: "fetch-failed" }
                ]);
            }
            document = await response.json();
        }
        catch {
            return this.finish("unavailable", 0, 0, [
                { reason: "fetch-or-json-failed" }
            ]);
        }

        if (!this.hasExactKeys(document, ["version", "assets"]) ||
            document.version !== SCHEMA_VERSION ||
            !Array.isArray(document.assets)) {
            return this.finish("unavailable", 0, 0, [
                { reason: "invalid-base-schema" }
            ]);
        }

        const issues = [];
        const baseUrl = response.url || String(this.configUrl);
        document.assets.forEach((candidate, index) => {
            const asset = this.createBaseAsset(candidate, baseUrl);
            if (!asset || this.assets.has(asset.id)) {
                issues.push({ reason: "invalid-or-duplicate-base-asset", index });
                return;
            }
            this.assets.set(asset.id, asset);
        });

        const overlay = this.loadOverlay();
        issues.push(...overlay.issues);
        overlay.assets.forEach((asset, index) => {
            if (this.assets.has(asset.id)) {
                issues.push({ reason: "operator-asset-id-collision", index });
                return;
            }
            this.assets.set(asset.id, asset);
            this.operatorAssetIds.add(asset.id);
        });

        this.initialized = true;
        return this.finish(
            issues.length ? "degraded" : "ready",
            document.assets.length - issues.filter((issue) =>
                issue.reason === "invalid-or-duplicate-base-asset"
            ).length,
            this.operatorAssetIds.size,
            issues
        );
    }

    getAsset(assetId) {
        const id = this.normalizeString(assetId, MAX_ID_LENGTH);
        const asset = id ? this.assets.get(id) : null;
        return asset ? this.createSnapshot(asset) : null;
    }

    getAssets(kind = null) {
        const normalizedKind = kind === null
            ? null
            : this.normalizeKind(kind);
        if (kind !== null && !normalizedKind) {
            return Object.freeze([]);
        }
        return Object.freeze(Array.from(this.assets.values())
            .filter((asset) => !normalizedKind || asset.kind === normalizedKind)
            .map((asset) => this.createSnapshot(asset)));
    }

    subscribe(listener) {
        if (typeof listener !== "function") {
            return () => {};
        }
        this.listeners.add(listener);
        listener(this.getAssets());
        return () => this.listeners.delete(listener);
    }

    setReferenceGuard(guard) {
        this.referenceGuard = typeof guard === "function" ? guard : null;
    }

    addAsset({ name, kind, url } = {}) {
        if (!this.initialized || this.mutating) {
            return this.failure("library-unavailable");
        }
        if (this.operatorAssetIds.size >= MAX_OPERATOR_ASSETS) {
            return this.failure("operator-limit-reached");
        }

        const normalizedName = this.normalizeString(name, MAX_NAME_LENGTH);
        const normalizedKind = this.normalizeKind(kind);
        const canonicalUrl = this.createHttpUrl(url, globalThis.document?.baseURI);
        const uuid = this.createUuid();
        if (!normalizedName) {
            return this.failure("invalid-name");
        }
        if (!normalizedKind) {
            return this.failure("invalid-kind");
        }
        if (!canonicalUrl) {
            return this.failure("invalid-url");
        }
        if (!uuid) {
            return this.failure("id-generation-failed");
        }

        const asset = Object.freeze({
            id: `asset-${uuid}`,
            name: normalizedName,
            kind: normalizedKind,
            url: canonicalUrl,
            origin: "operator"
        });
        if (this.assets.has(asset.id)) {
            return this.failure("id-collision");
        }

        this.mutating = true;
        try {
            this.assets.set(asset.id, asset);
            this.operatorAssetIds.add(asset.id);
            if (!this.persistOverlay()) {
                this.operatorAssetIds.delete(asset.id);
                this.assets.delete(asset.id);
                return this.failure("persistence-failed");
            }
            this.notify();
            return Object.freeze({ ok: true, asset: this.createSnapshot(asset) });
        }
        finally {
            this.mutating = false;
        }
    }

    removeAsset(assetId) {
        if (!this.initialized || this.mutating) {
            return this.failure("library-unavailable");
        }
        const id = this.normalizeString(assetId, MAX_ID_LENGTH);
        const asset = id ? this.assets.get(id) : null;
        if (!asset) {
            return this.failure("asset-not-found");
        }
        if (!this.operatorAssetIds.has(id)) {
            return this.failure("base-asset-protected");
        }

        const referenceReason = this.referenceGuard?.(this.createSnapshot(asset));
        if (referenceReason) {
            return this.failure(referenceReason === true
                ? "asset-still-referenced"
                : referenceReason);
        }

        this.mutating = true;
        try {
            this.assets.delete(id);
            this.operatorAssetIds.delete(id);
            if (!this.persistOverlay()) {
                this.assets.set(id, asset);
                this.operatorAssetIds.add(id);
                return this.failure("persistence-failed");
            }
            this.notify();
            return Object.freeze({ ok: true, asset: this.createSnapshot(asset) });
        }
        finally {
            this.mutating = false;
        }
    }

    loadOverlay() {
        let value;
        try {
            value = this.storage?.getItem(STORAGE_KEY);
        }
        catch {
            return { assets: [], issues: [{ reason: "overlay-read-failed" }] };
        }
        if (!value) {
            return { assets: [], issues: [] };
        }

        let parsed;
        try {
            parsed = JSON.parse(value);
        }
        catch {
            return { assets: [], issues: [{ reason: "overlay-invalid-json" }] };
        }
        if (!this.hasExactKeys(parsed, ["version", "assets"]) ||
            parsed.version !== SCHEMA_VERSION ||
            !Array.isArray(parsed.assets) ||
            parsed.assets.length > MAX_OPERATOR_ASSETS) {
            return { assets: [], issues: [{ reason: "overlay-invalid-schema" }] };
        }

        const assets = [];
        const ids = new Set();
        for (const candidate of parsed.assets) {
            const asset = this.createOperatorAsset(candidate);
            if (!asset || ids.has(asset.id)) {
                return { assets: [], issues: [{ reason: "overlay-invalid-record" }] };
            }
            ids.add(asset.id);
            assets.push(asset);
        }
        return { assets, issues: [] };
    }

    createBaseAsset(candidate, baseUrl) {
        if (!this.hasAllowedKeys(candidate, ["id", "name", "kind", "url"],
            ["durationSeconds"])) {
            return null;
        }
        const id = this.normalizeString(candidate.id, MAX_ID_LENGTH);
        const name = this.normalizeString(candidate.name, MAX_NAME_LENGTH);
        const kind = this.normalizeKind(candidate.kind);
        const url = this.createHttpUrl(candidate.url, baseUrl);
        const durationSeconds = candidate.durationSeconds === undefined
            ? null : Number(candidate.durationSeconds);
        if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id) || !name || !kind || !url) {
            return null;
        }
        if (durationSeconds !== null && (!["video", "audio"].includes(kind) ||
            !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
            durationSeconds > 7 * 24 * 60 * 60)) {
            return null;
        }
        return Object.freeze({ id, name, kind, url, durationSeconds, origin: "base" });
    }

    createOperatorAsset(candidate) {
        if (!this.hasExactKeys(candidate, ["id", "name", "kind", "url"]) ||
            typeof candidate.id !== "string" ||
            !/^asset-[a-zA-Z0-9-]+$/.test(candidate.id)) {
            return null;
        }
        const id = this.normalizeString(candidate.id, MAX_ID_LENGTH);
        const name = this.normalizeString(candidate.name, MAX_NAME_LENGTH);
        const kind = this.normalizeKind(candidate.kind);
        const url = this.createHttpUrl(candidate.url);
        return id && name && kind && url
            ? Object.freeze({ id, name, kind, url, origin: "operator" })
            : null;
    }

    createSnapshot(asset) {
        return Object.freeze({
            id: asset.id,
            name: asset.name,
            kind: asset.kind,
            url: asset.url,
            durationSeconds: asset.durationSeconds ?? null,
            origin: asset.origin,
            removable: asset.origin === "operator"
        });
    }

    persistOverlay() {
        const assets = Array.from(this.operatorAssetIds, (id) => {
            const { id: assetId, name, kind, url } = this.assets.get(id);
            return { id: assetId, name, kind, url };
        });
        try {
            if (!this.storage || typeof this.storage.setItem !== "function") {
                return false;
            }
            this.storage.setItem(
                STORAGE_KEY,
                JSON.stringify({ version: SCHEMA_VERSION, assets })
            );
            return true;
        }
        catch {
            return false;
        }
    }

    notify() {
        const snapshot = this.getAssets();
        this.listeners.forEach((listener) => listener(snapshot));
    }

    finish(status, baseAssetCount, operatorAssetCount, issues) {
        this.report = Object.freeze({
            status,
            baseAssetCount,
            operatorAssetCount,
            issues: Object.freeze(issues.map((issue) => Object.freeze(issue)))
        });
        return this.report;
    }

    failure(reason) {
        return Object.freeze({ ok: false, reason });
    }

    normalizeKind(value) {
        const kind = this.normalizeString(value, 20);
        return ALLOWED_KINDS.includes(kind) ? kind : null;
    }

    createHttpUrl(value, baseUrl) {
        const url = this.normalizeString(value, MAX_URL_LENGTH);
        if (!url) {
            return null;
        }
        try {
            const parsed = new URL(url, baseUrl);
            return ["http:", "https:"].includes(parsed.protocol)
                ? parsed.href
                : null;
        }
        catch {
            return null;
        }
    }

    createUuid() {
        let value;
        try {
            value = this.uuidFactory();
            if (!value && typeof globalThis.crypto?.getRandomValues === "function") {
                const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
                bytes[6] = bytes[6] & 0x0f | 0x40;
                bytes[8] = bytes[8] & 0x3f | 0x80;
                const hex = Array.from(bytes, (byte) =>
                    byte.toString(16).padStart(2, "0")
                ).join("");
                value = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
                    hex.slice(16, 20), hex.slice(20)].join("-");
            }
        }
        catch {
            return null;
        }
        const uuid = this.normalizeString(value, 80);
        return uuid && /^[a-zA-Z0-9-]+$/.test(uuid) ? uuid : null;
    }

    hasExactKeys(value, keys) {
        if (!this.isPlainObject(value)) {
            return false;
        }
        const actual = Object.keys(value).sort();
        const expected = [...keys].sort();
        return actual.length === expected.length &&
            actual.every((key, index) => key === expected[index]);
    }

    hasAllowedKeys(value, required, optional) {
        if (!this.isPlainObject(value)) return false;
        const keys = Object.keys(value);
        return required.every((key) => keys.includes(key)) &&
            keys.every((key) => required.includes(key) || optional.includes(key));
    }

    isPlainObject(value) {
        return value !== null && typeof value === "object" &&
            !Array.isArray(value) &&
            (Object.getPrototypeOf(value) === Object.prototype ||
                Object.getPrototypeOf(value) === null);
    }

    normalizeString(value, maximumLength) {
        if (typeof value !== "string") {
            return null;
        }
        const normalized = value.trim();
        return normalized && normalized.length <= maximumLength
            ? normalized
            : null;
    }

    getDefaultStorage() {
        try {
            return globalThis.localStorage;
        }
        catch {
            return null;
        }
    }
}
