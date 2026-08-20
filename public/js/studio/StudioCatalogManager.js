const STORAGE_KEY = "livezone.studio.mediaCatalog.overlay.v1";
const SCHEMA_VERSION = 1;
const MAX_NAME_LENGTH = 120;
const MAX_ID_LENGTH = 120;
const MAX_URL_LENGTH = 4096;

export default class StudioCatalogManager {

    constructor({
        studioStateManager,
        studioSourceManager,
        assetResolver = null,
        storage,
        baseUrl = globalThis.document?.baseURI,
        uuidFactory = () => globalThis.crypto?.randomUUID?.()
    } = {}) {
        if (!studioStateManager ||
            typeof studioStateManager.registerScene !== "function" ||
            typeof studioStateManager.unregisterScene !== "function") {
            throw new TypeError(
                "StudioCatalogManager requires a StudioStateManager dependency."
            );
        }

        if (!studioSourceManager ||
            typeof studioSourceManager.registerSource !== "function" ||
            typeof studioSourceManager.unregisterSource !== "function") {
            throw new TypeError(
                "StudioCatalogManager requires a StudioSourceManager dependency."
            );
        }

        this.studioStateManager = studioStateManager;
        this.studioSourceManager = studioSourceManager;
        this.assetResolver = typeof assetResolver === "function"
            ? assetResolver
            : null;
        this.storage = storage === undefined ? this.getDefaultStorage() : storage;
        this.baseUrl = baseUrl;
        this.uuidFactory = uuidFactory;
        this.sources = new Map();
        this.definitions = new Map();
        this.operatorSourceIds = new Set();
        this.operatorSceneIds = new Set();
        this.listeners = new Set();
        this.removalGuard = null;
        this.initialized = false;
        this.mutating = false;
    }

    initialize({ sources = [], scenes = [] } = {}) {
        if (this.initialized) {
            return this.createInitializationReport([], 0, 0, 0, 0);
        }

        const issues = [];
        let registeredSourceCount = 0;
        let registeredSceneCount = 0;
        let overlaySourceCount = 0;
        let overlaySceneCount = 0;
        const sceneNamesBySource = new Map();

        scenes.forEach((scene) => {
            const sourceId = scene?.renderer?.kind === "source"
                ? scene.renderer.sourceId
                : null;
            if (sourceId && !sceneNamesBySource.has(sourceId)) {
                sceneNamesBySource.set(sourceId, scene.name);
            }
        });

        sources.forEach((source, index) => {
            const record = this.createSourceRecord({
                ...source,
                name: source.name || sceneNamesBySource.get(source.id) || source.id
            }, "base");

            if (!record || !this.registerSourceRecord(record)) {
                issues.push({ reason: "base-source-registration-rejected", index });
                return;
            }

            registeredSourceCount += 1;
        });

        scenes.forEach((scene, index) => {
            const definition = this.createSceneDefinition(scene, "base");

            const missingSource = definition?.renderer?.kind === "source" &&
                !this.sources.has(definition.renderer.sourceId);
            if (!definition || missingSource ||
                !this.registerSceneDefinition(definition)) {
                issues.push({ reason: "base-scene-registration-rejected", index });
                return;
            }

            registeredSceneCount += 1;
        });

        const overlay = this.loadOverlay();
        issues.push(...overlay.issues);

        overlay.pairs.forEach(({ source, scene }, index) => {
            if (this.sources.has(source.id) || this.definitions.has(scene.id) ||
                !this.registerSourceRecord(source)) {
                issues.push({ reason: "overlay-registration-rejected", index });
                return;
            }

            if (!this.registerSceneDefinition(scene)) {
                this.studioSourceManager.unregisterSource(source.id);
                this.sources.delete(source.id);
                issues.push({ reason: "overlay-registration-rejected", index });
                return;
            }

            this.operatorSourceIds.add(source.id);
            this.operatorSceneIds.add(scene.id);
            overlaySourceCount += 1;
            overlaySceneCount += 1;
        });

        this.initialized = true;
        return this.createInitializationReport(
            issues,
            registeredSourceCount,
            registeredSceneCount,
            overlaySourceCount,
            overlaySceneCount
        );
    }

    getDefinition(sceneId) {
        const id = this.normalizeString(sceneId, MAX_ID_LENGTH);
        return id ? this.definitions.get(id) || null : null;
    }

    getDefinitions() {
        return Object.freeze(Array.from(this.definitions.values()));
    }

    getMediaSources() {
        return Object.freeze(this.getSources()
            .filter((source) => source.kind === "media"));
    }

    getSources() {
        return Object.freeze(Array.from(this.sources.values())
            .filter((source) => ["media", "audio"].includes(source.kind))
            .map((source) => {
                const scenes = Array.from(this.definitions.values()).filter(
                    (definition) => definition.renderer.kind === "source" &&
                        definition.renderer.sourceId === source.id
                );
                return Object.freeze({
                    id: source.id,
                    name: source.name,
                    kind: source.kind,
                    url: source.url,
                    assetId: source.assetId || null,
                    audioAssetId: source.audioAssetId || null,
                    stillAssetId: source.stillAssetId || null,
                    audioUrl: source.audioUrl || null,
                    stillUrl: source.stillUrl || null,
                    origin: source.origin,
                    removable: source.origin === "operator",
                    sceneIds: Object.freeze(scenes.map((scene) => scene.id))
                });
            }));
    }

    subscribe(listener) {
        if (typeof listener !== "function") {
            return () => {};
        }

        this.listeners.add(listener);
        listener(this.getSources());
        return () => this.listeners.delete(listener);
    }

    setRemovalGuard(guard) {
        this.removalGuard = typeof guard === "function" ? guard : null;
    }

    addMedia({ name, url, assetId = null } = {}) {
        if (!this.initialized || this.mutating) {
            return this.failure("catalog-unavailable");
        }

        const normalizedName = this.normalizeString(name, MAX_NAME_LENGTH);
        const normalizedAssetId = assetId === null
            ? null
            : this.normalizeString(assetId, MAX_ID_LENGTH);
        const asset = normalizedAssetId
            ? this.assetResolver?.(normalizedAssetId)
            : null;
        const canonicalUrl = asset
            ? this.createHttpUrl(asset.url)
            : this.createHttpUrl(url, this.baseUrl);
        const uuid = this.createUuid();

        if (!normalizedName) {
            return this.failure("invalid-name");
        }
        if (normalizedAssetId && (!asset || asset.kind !== "video")) {
            return this.failure("invalid-video-asset");
        }
        if (!canonicalUrl) {
            return this.failure("invalid-url");
        }
        if (!uuid) {
            return this.failure("id-generation-failed");
        }

        const source = this.createSourceRecord({
            id: `media-${uuid}`,
            name: normalizedName,
            kind: "media",
            url: canonicalUrl,
            ...(normalizedAssetId ? { assetId: normalizedAssetId } : {})
        }, "operator");
        const scene = this.createSceneDefinition({
            id: `media-scene-${uuid}`,
            name: normalizedName,
            type: "MEDIA",
            renderer: { kind: "source", sourceId: source?.id }
        }, "operator");

        if (!source || !scene || this.sources.has(source.id) ||
            this.definitions.has(scene.id)) {
            return this.failure("id-collision");
        }

        this.mutating = true;
        try {
            if (!this.registerSourceRecord(source)) {
                return this.failure("source-registration-rejected");
            }
            if (!this.registerSceneDefinition(scene)) {
                this.sources.delete(source.id);
                this.studioSourceManager.unregisterSource(source.id);
                return this.failure("scene-registration-rejected");
            }

            this.operatorSourceIds.add(source.id);
            this.operatorSceneIds.add(scene.id);

            if (!this.persistOverlay()) {
                this.operatorSceneIds.delete(scene.id);
                this.operatorSourceIds.delete(source.id);
                this.definitions.delete(scene.id);
                this.studioStateManager.unregisterScene(scene.id);
                this.sources.delete(source.id);
                this.studioSourceManager.unregisterSource(source.id);
                return this.failure("persistence-failed");
            }

            this.notify();
            return Object.freeze({ ok: true, source, scene });
        }
        finally {
            this.mutating = false;
        }
    }

    addAudio({ name, audioAssetId, stillAssetId } = {}) {
        if (!this.initialized || this.mutating) {
            return this.failure("catalog-unavailable");
        }

        const normalizedName = this.normalizeString(name, MAX_NAME_LENGTH);
        const normalizedAudioAssetId = this.normalizeString(
            audioAssetId,
            MAX_ID_LENGTH
        );
        const normalizedStillAssetId = this.normalizeString(
            stillAssetId,
            MAX_ID_LENGTH
        );
        const audioAsset = normalizedAudioAssetId
            ? this.assetResolver?.(normalizedAudioAssetId)
            : null;
        const stillAsset = normalizedStillAssetId
            ? this.assetResolver?.(normalizedStillAssetId)
            : null;
        const uuid = this.createUuid();

        if (!normalizedName) {
            return this.failure("invalid-name");
        }
        if (!audioAsset || audioAsset.kind !== "audio") {
            return this.failure("invalid-audio-asset");
        }
        if (!stillAsset || stillAsset.kind !== "still") {
            return this.failure("invalid-still-asset");
        }
        if (!uuid) {
            return this.failure("id-generation-failed");
        }

        const source = this.createSourceRecord({
            id: `audio-${uuid}`,
            name: normalizedName,
            kind: "audio",
            audioAssetId: normalizedAudioAssetId,
            stillAssetId: normalizedStillAssetId
        }, "operator");
        const scene = this.createSceneDefinition({
            id: `audio-scene-${uuid}`,
            name: normalizedName,
            type: "AUDIO",
            renderer: { kind: "source", sourceId: source?.id }
        }, "operator");

        return this.addOperatorPair(source, scene);
    }

    addOperatorPair(source, scene) {
        if (!source || !scene || this.sources.has(source.id) ||
            this.definitions.has(scene.id)) {
            return this.failure("id-collision");
        }

        this.mutating = true;
        try {
            if (!this.registerSourceRecord(source)) {
                return this.failure("source-registration-rejected");
            }
            if (!this.registerSceneDefinition(scene)) {
                this.sources.delete(source.id);
                this.studioSourceManager.unregisterSource(source.id);
                return this.failure("scene-registration-rejected");
            }

            this.operatorSourceIds.add(source.id);
            this.operatorSceneIds.add(scene.id);
            if (!this.persistOverlay()) {
                this.operatorSceneIds.delete(scene.id);
                this.operatorSourceIds.delete(source.id);
                this.definitions.delete(scene.id);
                this.studioStateManager.unregisterScene(scene.id);
                this.sources.delete(source.id);
                this.studioSourceManager.unregisterSource(source.id);
                return this.failure("persistence-failed");
            }

            this.notify();
            return Object.freeze({ ok: true, source, scene });
        }
        finally {
            this.mutating = false;
        }
    }

    removeMedia(sourceId) {
        return this.removeSource(sourceId);
    }

    removeSource(sourceId) {
        if (!this.initialized || this.mutating) {
            return this.failure("catalog-unavailable");
        }

        const id = this.normalizeString(sourceId, MAX_ID_LENGTH);
        const source = id ? this.sources.get(id) : null;

        if (!source) {
            return this.failure("source-not-found");
        }
        if (!this.operatorSourceIds.has(id)) {
            return this.failure("base-source-protected");
        }

        const references = Array.from(this.definitions.values()).filter(
            (definition) => definition.renderer.kind === "source" &&
                definition.renderer.sourceId === id
        );
        if (references.length !== 1 ||
            !this.operatorSceneIds.has(references[0].id)) {
            return this.failure("source-still-referenced");
        }

        const scene = references[0];
        if (scene.id === this.studioStateManager.getPreviewSceneId() ||
            scene.id === this.studioStateManager.getProgramSceneId()) {
            return this.failure("scene-on-air");
        }
        if (this.removalGuard?.({ sourceId: id, sceneId: scene.id })) {
            return this.failure("scene-in-transition");
        }
        if (this.studioSourceManager.getActiveInstances().some(
            (instance) => instance.sourceId === id
        )) {
            return this.failure("source-has-active-instances");
        }

        this.mutating = true;
        try {
            const previousOverlay = this.serializeOverlay();
            const unregisteredScene = this.studioStateManager.unregisterScene(
                scene.id
            );
            if (!unregisteredScene) {
                return this.failure("scene-unregister-rejected");
            }

            this.definitions.delete(scene.id);
            this.operatorSceneIds.delete(scene.id);
            this.sources.delete(id);
            this.operatorSourceIds.delete(id);

            if (!this.studioSourceManager.unregisterSource(id)) {
                this.restoreRuntimePair(source, scene);
                return this.failure("source-unregister-rejected");
            }

            if (!this.persistOverlay()) {
                this.restoreRuntimePair(source, scene);
                this.writeOverlay(previousOverlay);
                return this.failure("persistence-failed");
            }

            this.notify();
            return Object.freeze({ ok: true, source, scene });
        }
        finally {
            this.mutating = false;
        }
    }

    isAssetReferenced(assetId) {
        const id = this.normalizeString(assetId, MAX_ID_LENGTH);
        return Boolean(id) && Array.from(this.sources.values()).some(
            (source) => source.assetId === id ||
                source.audioAssetId === id || source.stillAssetId === id
        );
    }

    registerSourceRecord(source) {
        if (!source || this.sources.has(source.id) ||
            !this.studioSourceManager.registerSource(source)) {
            return false;
        }
        this.sources.set(source.id, source);
        return true;
    }

    registerSceneDefinition(scene) {
        if (!scene || this.definitions.has(scene.id) ||
            scene.renderer.kind === "source" &&
                !this.sources.has(scene.renderer.sourceId)) {
            return false;
        }

        const registered = this.studioStateManager.registerScene(scene);
        if (!registered) {
            return false;
        }
        this.definitions.set(scene.id, scene);
        return true;
    }

    restoreRuntimePair(source, scene) {
        this.studioSourceManager.registerSource(source);
        this.sources.set(source.id, source);
        this.definitions.set(scene.id, scene);
        this.studioStateManager.registerScene(scene);
        this.operatorSourceIds.add(source.id);
        this.operatorSceneIds.add(scene.id);
    }

    loadOverlay() {
        let value;
        try {
            value = this.storage?.getItem(STORAGE_KEY);
        }
        catch {
            return { pairs: [], issues: [{ reason: "overlay-read-failed" }] };
        }

        if (!value) {
            return { pairs: [], issues: [] };
        }

        let parsed;
        try {
            parsed = JSON.parse(value);
        }
        catch {
            return { pairs: [], issues: [{ reason: "overlay-invalid-json" }] };
        }

        if (!this.hasExactKeys(parsed, ["version", "sources", "scenes"]) ||
            parsed.version !== SCHEMA_VERSION ||
            !Array.isArray(parsed.sources) || !Array.isArray(parsed.scenes) ||
            parsed.sources.length !== parsed.scenes.length ||
            parsed.sources.length > 500) {
            return { pairs: [], issues: [{ reason: "overlay-invalid-schema" }] };
        }

        const sources = parsed.sources.map((item) =>
            this.createOverlaySource(item)
        );
        const scenes = parsed.scenes.map((item) =>
            this.createOverlayScene(item)
        );
        if (sources.some((item) => !item) || scenes.some((item) => !item)) {
            return { pairs: [], issues: [{ reason: "overlay-invalid-record" }] };
        }

        const sourceById = new Map();
        for (const source of sources) {
            if (sourceById.has(source.id)) {
                return { pairs: [], issues: [{ reason: "overlay-duplicate-id" }] };
            }
            sourceById.set(source.id, source);
        }

        const sceneIds = new Set();
        const referencedSourceIds = new Set();
        const pairs = [];
        for (const scene of scenes) {
            const source = sourceById.get(scene.renderer.sourceId);
            if (!source || sceneIds.has(scene.id) ||
                referencedSourceIds.has(source.id)) {
                return { pairs: [], issues: [{ reason: "overlay-invalid-reference" }] };
            }
            sceneIds.add(scene.id);
            referencedSourceIds.add(source.id);
            pairs.push({ source, scene });
        }

        if (referencedSourceIds.size !== sourceById.size) {
            return { pairs: [], issues: [{ reason: "overlay-orphan-source" }] };
        }
        return { pairs, issues: [] };
    }

    createOverlaySource(candidate) {
        const directUrl = this.hasExactKeys(
            candidate,
            ["id", "name", "kind", "url"]
        );
        const assetBacked = this.hasExactKeys(
            candidate,
            ["id", "name", "kind", "assetId"]
        );
        const audio = this.hasExactKeys(
            candidate,
            ["id", "name", "kind", "audioAssetId", "stillAssetId"]
        );
        if (candidate.kind === "media") {
            if ((!directUrl && !assetBacked) ||
                !this.isGeneratedSourceId(candidate.id, "media")) {
                return null;
            }
        }
        else if (candidate.kind === "audio") {
            if (!audio || !this.isGeneratedSourceId(candidate.id, "audio")) {
                return null;
            }
        }
        else {
            return null;
        }
        return this.createSourceRecord(candidate, "operator");
    }

    createOverlayScene(candidate) {
        if (!this.hasExactKeys(candidate, ["id", "name", "type", "renderer"]) ||
            !["MEDIA", "AUDIO"].includes(candidate.type) ||
            !this.isGeneratedSceneId(
                candidate.id,
                candidate.type === "AUDIO" ? "audio" : "media"
            ) ||
            !this.hasExactKeys(candidate.renderer, ["kind", "sourceId"]) ||
            candidate.renderer.kind !== "source" ||
            !this.isGeneratedSourceId(
                candidate.renderer.sourceId,
                candidate.type === "AUDIO" ? "audio" : "media"
            )) {
            return null;
        }
        return this.createSceneDefinition(candidate, "operator");
    }

    createSourceRecord(candidate, origin) {
        if (!this.isPlainObject(candidate)) {
            return null;
        }
        const id = this.normalizeString(candidate.id, MAX_ID_LENGTH);
        const name = this.normalizeString(candidate.name, MAX_NAME_LENGTH);
        const kind = this.normalizeString(candidate.kind, 40);
        if (!id || !name || !kind) {
            return null;
        }

        if (kind === "media") {
            const assetId = this.normalizeString(candidate.assetId, MAX_ID_LENGTH);
            const asset = assetId ? this.assetResolver?.(assetId) : null;
            const url = asset
                ? this.createHttpUrl(asset.url)
                : this.createHttpUrl(candidate.url);
            if (assetId && (!asset || asset.kind !== "video")) {
                return null;
            }
            return url ? Object.freeze({
                id,
                name,
                kind,
                url,
                ...(assetId ? { assetId } : {}),
                origin
            }) : null;
        }
        if (kind === "audio") {
            const audioAssetId = this.normalizeString(
                candidate.audioAssetId,
                MAX_ID_LENGTH
            );
            const stillAssetId = this.normalizeString(
                candidate.stillAssetId,
                MAX_ID_LENGTH
            );
            const audioAsset = audioAssetId
                ? this.assetResolver?.(audioAssetId)
                : null;
            const stillAsset = stillAssetId
                ? this.assetResolver?.(stillAssetId)
                : null;
            const audioUrl = audioAsset
                ? this.createHttpUrl(audioAsset.url)
                : null;
            const stillUrl = stillAsset
                ? this.createHttpUrl(stillAsset.url)
                : null;
            if (!audioAsset || audioAsset.kind !== "audio" || !audioUrl ||
                !stillAsset || stillAsset.kind !== "still" || !stillUrl) {
                return null;
            }
            return Object.freeze({
                id,
                name,
                kind,
                audioAssetId,
                stillAssetId,
                audioUrl,
                stillUrl,
                origin
            });
        }
        if (kind === "hls") {
            const configRef = this.normalizeString(candidate.configRef, 200);
            const url = this.createHttpUrl(candidate.url);
            if (Boolean(configRef) === Boolean(url)) {
                return null;
            }
            return Object.freeze({
                id,
                name,
                kind,
                ...(configRef ? { configRef } : { url }),
                origin
            });
        }
        return null;
    }

    createSceneDefinition(candidate, origin) {
        if (!this.isPlainObject(candidate) || !this.isPlainObject(candidate.renderer)) {
            return null;
        }
        const id = this.normalizeString(candidate.id, MAX_ID_LENGTH);
        const name = this.normalizeString(candidate.name, MAX_NAME_LENGTH);
        const type = this.normalizeString(candidate.type, 40);
        const rendererKind = this.normalizeString(candidate.renderer.kind, 40);
        if (!id || !name || !type || !rendererKind) {
            return null;
        }

        let renderer;
        if (rendererKind === "source") {
            const sourceId = this.normalizeString(
                candidate.renderer.sourceId,
                MAX_ID_LENGTH
            );
            if (!sourceId) {
                return null;
            }
            renderer = Object.freeze({ kind: "source", sourceId });
        }
        else if (rendererKind === "slate") {
            const title = this.normalizeString(candidate.renderer.title, 200);
            const message = this.normalizeString(candidate.renderer.message, 500);
            const logo = this.createHttpUrl(candidate.renderer.logo);
            if (!title || !message || !logo) {
                return null;
            }
            renderer = Object.freeze({ kind: "slate", title, message, logo });
        }
        else {
            return null;
        }

        return Object.freeze({ id, name, type, renderer, origin });
    }

    persistOverlay() {
        return this.writeOverlay(this.serializeOverlay());
    }

    serializeOverlay() {
        const sources = Array.from(this.operatorSourceIds, (id) => {
            const source = this.sources.get(id);
            const {
                id: sourceId,
                name,
                kind,
                url,
                assetId,
                audioAssetId,
                stillAssetId
            } = source;
            if (kind === "audio") {
                return { id: sourceId, name, kind, audioAssetId, stillAssetId };
            }
            return assetId
                ? { id: sourceId, name, kind, assetId }
                : { id: sourceId, name, kind, url };
        });
        const scenes = Array.from(this.operatorSceneIds, (id) => {
            const scene = this.definitions.get(id);
            return {
                id: scene.id,
                name: scene.name,
                type: scene.type,
                renderer: { ...scene.renderer }
            };
        });
        return JSON.stringify({ version: SCHEMA_VERSION, sources, scenes });
    }

    writeOverlay(value) {
        try {
            if (!this.storage || typeof this.storage.setItem !== "function") {
                return false;
            }
            this.storage.setItem(STORAGE_KEY, value);
            return true;
        }
        catch {
            return false;
        }
    }

    notify() {
        const snapshot = this.getSources();
        this.listeners.forEach((listener) => listener(snapshot));
    }

    createInitializationReport(
        issues,
        registeredSourceCount,
        registeredSceneCount,
        overlaySourceCount,
        overlaySceneCount
    ) {
        return Object.freeze({
            registeredSourceCount,
            registeredSceneCount,
            overlaySourceCount,
            overlaySceneCount,
            issues: Object.freeze(issues.map((issue) => Object.freeze(issue)))
        });
    }

    failure(reason) {
        return Object.freeze({ ok: false, reason });
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
                value = [
                    hex.slice(0, 8),
                    hex.slice(8, 12),
                    hex.slice(12, 16),
                    hex.slice(16, 20),
                    hex.slice(20)
                ].join("-");
            }
        }
        catch {
            return null;
        }
        const uuid = this.normalizeString(value, 80);
        return uuid && /^[a-zA-Z0-9-]+$/.test(uuid) ? uuid : null;
    }

    isGeneratedSourceId(value, kind = "media") {
        return typeof value === "string" &&
            new RegExp(`^${kind}-[a-zA-Z0-9-]+$`).test(value) &&
            value.length <= MAX_ID_LENGTH;
    }

    isGeneratedSceneId(value, kind = "media") {
        return typeof value === "string" &&
            new RegExp(`^${kind}-scene-[a-zA-Z0-9-]+$`).test(value) &&
            value.length <= MAX_ID_LENGTH;
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

    hasExactKeys(value, keys) {
        if (!this.isPlainObject(value)) {
            return false;
        }
        const actual = Object.keys(value).sort();
        const expected = [...keys].sort();
        return actual.length === expected.length &&
            actual.every((key, index) => key === expected[index]);
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
