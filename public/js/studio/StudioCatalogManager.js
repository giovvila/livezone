const STORAGE_KEY = "livezone.studio.mediaCatalog.overlay.v1";
const SCHEMA_VERSION = 3;
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
        uuidFactory = () => globalThis.crypto?.randomUUID?.(),
        eventTarget = globalThis.window
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
        this.assetResolver = assetResolver;
        this.storage = storage === undefined ? this.getDefaultStorage() : storage;
        this.baseUrl = baseUrl;
        this.uuidFactory = uuidFactory;
        this.eventTarget = eventTarget;
        this.sources = new Map();
        this.definitions = new Map();
        this.runtimeDefinitions = new Map();
        this.operatorSourceIds = new Set();
        this.operatorSceneIds = new Set();
        this.baseSourceIds = new Set();
        this.baseSceneIds = new Set();
        this.sourceOverrides = new Map();
        this.sceneOverrides = new Map();
        this.deletedBootstrapSourceIds = new Set();
        this.deletedBootstrapSceneIds = new Set();
        this.listeners = new Set();
        this.removalGuard = null;
        this.initialized = false;
        this.mutating = false;
        this.handleStorage = this.handleStorage.bind(this);
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

        const overlay = this.loadOverlay();
        issues.push(...overlay.issues);
        this.sourceOverrides = new Map(overlay.sourceOverrides.map((item) => [item.id, item]));
        this.sceneOverrides = new Map(overlay.sceneOverrides.map((item) => [item.id, item]));
        this.deletedBootstrapSourceIds = new Set(overlay.deletedBootstrapSourceIds);
        this.deletedBootstrapSceneIds = new Set(overlay.deletedBootstrapSceneIds);

        sources.forEach((source, index) => {
            this.baseSourceIds.add(source?.id);
            if (this.deletedBootstrapSourceIds.has(source?.id)) return;
            const record = this.createSourceRecord({
                ...source, ...this.sourceOverrides.get(source?.id),
                name: this.sourceOverrides.get(source?.id)?.name || source.name ||
                    sceneNamesBySource.get(source.id) || source.id
            }, "base");

            if (!record || !this.registerSourceRecord(record)) {
                issues.push({ reason: "base-source-registration-rejected", index });
                return;
            }

            registeredSourceCount += 1;
        });

        scenes.forEach((scene, index) => {
            this.baseSceneIds.add(scene?.id);
            if (this.deletedBootstrapSceneIds.has(scene?.id)) return;
            const override = this.sceneOverrides.get(scene?.id);
            const definition = this.createSceneDefinition({
                ...scene, ...override,
                renderer: override?.renderer || scene.renderer
            }, "base");

            const missingSource = definition?.renderer?.kind === "source" &&
                !this.sources.has(definition.renderer.sourceId);
            if (!definition || missingSource ||
                !this.registerSceneDefinition(definition)) {
                issues.push({ reason: "base-scene-registration-rejected", index });
                return;
            }

            registeredSceneCount += 1;
        });

        overlay.sources.forEach((source, index) => {
            if (this.sources.has(source.id) || !this.registerSourceRecord(source)) {
                issues.push({ reason: "overlay-registration-rejected", index });
                return;
            }
            this.operatorSourceIds.add(source.id);
            overlaySourceCount += 1;
        });
        overlay.scenes.forEach((scene, index) => {
            const source = this.sources.get(scene.renderer.sourceId);
            if (!source || this.definitions.has(scene.id) ||
                source.enabled !== false && !this.registerSceneDefinition(scene)) {
                issues.push({ reason: "overlay-registration-rejected", index });
                return;
            }
            if (source.enabled === false) this.definitions.set(scene.id, scene);
            this.operatorSceneIds.add(scene.id);
            overlaySceneCount += 1;
        });

        this.initialized = true;
        this.eventTarget?.addEventListener?.("storage", this.handleStorage);
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
        const definition = id ? this.definitions.get(id) ||
            this.runtimeDefinitions.get(id) || null : null;
        const source = definition?.renderer?.kind === "source"
            ? this.sources.get(definition.renderer.sourceId) : null;
        return source?.available === false || source?.kind === "hls" && source.enabled === false
            ? null : definition;
    }

    getDefinitions() {
        return Object.freeze(Array.from(this.definitions.values()).filter((definition) => {
            const source = definition.renderer.kind === "source"
                ? this.sources.get(definition.renderer.sourceId) : null;
            return source?.available !== false &&
                !(source?.kind === "hls" && source.enabled === false);
        }));
    }

    registerRuntimeDefinition(candidate) {
        const definition = this.createSceneDefinition(candidate, "runtime");
        if (!definition || this.definitions.has(definition.id)) return null;
        const current = this.runtimeDefinitions.get(definition.id);
        if (current) {
            if (current.renderer.kind !== "source" ||
                current.renderer.sourceId !== definition.renderer.sourceId) return null;
            if (current.name !== definition.name || current.type !== definition.type) {
                if (!this.studioStateManager.replaceScene(definition)) return null;
                this.runtimeDefinitions.set(definition.id, definition);
            }
            return this.getDefinition(definition.id);
        }
        if (!this.sources.has(definition.renderer.sourceId) ||
            !this.studioStateManager.registerScene(definition)) return null;
        this.runtimeDefinitions.set(definition.id, definition);
        return this.getDefinition(definition.id);
    }

    getMediaSources() {
        return Object.freeze(this.getSources()
            .filter((source) => source.kind === "media"));
    }

    getSources() {
        return Object.freeze(Array.from(this.sources.values())
            .filter((source) => ["media", "audio", "hls", "image"].includes(source.kind))
            .map((source) => {
                const scenes = Array.from(this.definitions.values()).filter(
                    (definition) => definition.renderer.kind === "source" &&
                        definition.renderer.sourceId === source.id
                );
                return Object.freeze({
                    id: source.id,
                    name: source.name,
                    kind: source.kind,
                    category: this.getSourceCategory(source.kind),
                    url: source.url || this.studioSourceManager.getSource(source.id)?.url || null,
                    assetId: source.assetId || null,
                    audioAssetId: source.audioAssetId || null,
                    stillAssetId: source.stillAssetId || null,
                    motionAssetId: source.motionAssetId || null,
                    audioUrl: source.audioUrl || null,
                    stillUrl: source.stillUrl || null,
                    motionUrl: source.motionUrl || null,
                    stillUnavailableReason: source.stillUnavailableReason || null,
                    motionUnavailableReason: source.motionUnavailableReason || null,
                    configRef: source.configRef || null,
                    origin: source.origin,
                    enabled: source.enabled !== false,
                    available: source.available !== false,
                    unavailableReason: source.unavailableReason || null,
                    removable: true,
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
            if (source.enabled !== false && !this.registerSceneDefinition(scene)) {
                this.sources.delete(source.id);
                this.studioSourceManager.unregisterSource(source.id);
                return this.failure("scene-registration-rejected");
            }
            if (source.enabled === false) this.definitions.set(scene.id, scene);

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

    addLiveSource({ name, url, enabled = true } = {}) {
        if (!this.initialized || this.mutating) return this.failure("catalog-unavailable");
        const normalizedName = this.normalizeString(name, MAX_NAME_LENGTH);
        const canonicalUrl = this.createHttpUrl(url, this.baseUrl);
        const uuid = this.createUuid();
        if (!normalizedName) return this.failure("invalid-name");
        if (!canonicalUrl) return this.failure("invalid-url");
        if (!uuid) return this.failure("id-generation-failed");
        const source = this.createSourceRecord({ id: `live-${uuid}`, name: normalizedName,
            kind: "hls", url: canonicalUrl, enabled: enabled === true }, "operator");
        const scene = this.createSceneDefinition({ id: `live-scene-${uuid}`,
            name: normalizedName, type: "LIVE",
            renderer: { kind: "source", sourceId: source?.id } }, "operator");
        return this.addOperatorPair(source, scene);
    }

    addSource({ kind, name, url, stillUrl, assetId, audioAssetId, stillAssetId,
        motionAssetId } = {}) {
        const normalizedKind = this.normalizeString(kind, 20)?.toLowerCase();
        const runtimeKind = ({ live: "hls", video: "media", audio: "audio", image: "image" })[normalizedKind];
        if (!runtimeKind) return this.failure("invalid-kind");
        if (!this.initialized || this.mutating) return this.failure("catalog-unavailable");
        const normalizedName = this.normalizeString(name, MAX_NAME_LENGTH);
        const hasAssetReference = runtimeKind === "audio" ? Boolean(audioAssetId) : Boolean(assetId);
        const canonicalUrl = hasAssetReference ? null : this.createHttpUrl(url, this.baseUrl);
        const canonicalStillUrl = runtimeKind === "audio" &&
            this.normalizeString(stillUrl, MAX_URL_LENGTH)
            ? this.createHttpUrl(stillUrl, this.baseUrl)
            : null;
        const uuid = this.createUuid();
        if (!normalizedName) return this.failure("invalid-name");
        if (!hasAssetReference && !canonicalUrl) return this.failure("invalid-url");
        if (runtimeKind === "audio" &&
            this.normalizeString(stillUrl, MAX_URL_LENGTH) && !canonicalStillUrl) {
            return this.failure("invalid-still-url");
        }
        if (!uuid) return this.failure("id-generation-failed");
        const source = this.createSourceRecord({
            id: `${normalizedKind}-${uuid}`, name: normalizedName, kind: runtimeKind,
            ...(runtimeKind === "audio"
                ? (audioAssetId ? { audioAssetId,
                    ...(stillAssetId ? { stillAssetId } : {}),
                    ...(motionAssetId ? { motionAssetId } : {}) }
                    : { audioUrl: canonicalUrl, ...(canonicalStillUrl ? { stillUrl: canonicalStillUrl } : {}) })
                : (assetId ? { assetId } : { url: canonicalUrl })),
            ...(runtimeKind === "hls" ? { enabled: true } : {})
        }, "operator");
        if (!source || !this.registerSourceRecord(source)) return this.failure("source-registration-rejected");
        this.operatorSourceIds.add(source.id);
        if (!this.persistOverlay()) {
            this.operatorSourceIds.delete(source.id);
            this.sources.delete(source.id);
            this.studioSourceManager.unregisterSource(source.id);
            return this.failure("persistence-failed");
        }
        this.notify();
        return Object.freeze({ ok: true, source });
    }

    addUrlAudio({ name, url } = {}) {
        return this.addUrlSourcePair({ name, url, kind: "audio", prefix: "audio", type: "AUDIO" });
    }

    addImage({ name, url } = {}) {
        return this.addUrlSourcePair({ name, url, kind: "image", prefix: "image", type: "IMAGE" });
    }

    addUrlSourcePair({ name, url, kind, prefix, type }) {
        if (!this.initialized || this.mutating) return this.failure("catalog-unavailable");
        const normalizedName = this.normalizeString(name, MAX_NAME_LENGTH);
        const canonicalUrl = this.createHttpUrl(url, this.baseUrl);
        const uuid = this.createUuid();
        if (!normalizedName) return this.failure("invalid-name");
        if (!canonicalUrl) return this.failure("invalid-url");
        if (!uuid) return this.failure("id-generation-failed");
        const source = this.createSourceRecord({
            id: `${prefix}-${uuid}`, name: normalizedName, kind,
            ...(kind === "audio" ? { audioUrl: canonicalUrl } : { url: canonicalUrl })
        }, "operator");
        const scene = this.createSceneDefinition({
            id: `${prefix}-scene-${uuid}`, name: normalizedName, type,
            renderer: { kind: "source", sourceId: source?.id }
        }, "operator");
        return this.addOperatorPair(source, scene);
    }

    createSceneForSource(sourceId, { name } = {}) {
        if (!this.initialized || this.mutating) return this.failure("catalog-unavailable");
        const id = this.normalizeString(sourceId, MAX_ID_LENGTH);
        const source = id ? this.sources.get(id) : null;
        const sceneName = this.normalizeString(name, MAX_NAME_LENGTH) || source?.name;
        const uuid = this.createUuid();
        if (!source) return this.failure("source-not-found");
        if (!sceneName) return this.failure("invalid-name");
        if (!uuid) return this.failure("id-generation-failed");
        const category = this.getSourceCategory(source.kind);
        const prefix = source.kind === "hls" ? "live" : source.kind === "media" ? "media" : source.kind;
        const scene = this.createSceneDefinition({
            id: `${prefix}-scene-${uuid}`,
            name: sceneName,
            type: category.toUpperCase(),
            renderer: { kind: "source", sourceId: id }
        }, "operator");
        if (!scene || !this.registerSceneDefinition(scene)) return this.failure("scene-registration-rejected");
        this.operatorSceneIds.add(scene.id);
        if (!this.persistOverlay()) {
            this.operatorSceneIds.delete(scene.id);
            this.definitions.delete(scene.id);
            this.studioStateManager.unregisterScene(scene.id);
            return this.failure("persistence-failed");
        }
        this.notify();
        return Object.freeze({ ok: true, source, scene });
    }

    updateSource(sourceId, { name, url, stillUrl, enabled, assetId, audioAssetId,
        stillAssetId, motionAssetId } = {}) {
        const id = this.normalizeString(sourceId, MAX_ID_LENGTH);
        const current = id ? this.sources.get(id) : null;
        if (!current) return this.failure("source-not-editable");
        const linkedScene = Array.from(this.definitions.values()).find(
            (scene) => scene.renderer.kind === "source" && scene.renderer.sourceId === id
        );
        if (current.kind === "hls" && linkedScene) {
            return this.updateLiveSource(id, { name, url, enabled: enabled !== false });
        }
        const hasActiveInstances = this.studioSourceManager.getActiveInstances()
            .some((item) => item.sourceId === id);
        const normalizedName = this.normalizeString(name, MAX_NAME_LENGTH);
        const hasAssetReference = current.kind === "audio" ? Boolean(audioAssetId) : Boolean(assetId);
        const canonicalUrl = hasAssetReference ? null : this.createHttpUrl(url, this.baseUrl);
        const normalizedStillUrl = this.normalizeString(stillUrl, MAX_URL_LENGTH);
        const canonicalStillUrl = current.kind === "audio" && normalizedStillUrl
            ? this.createHttpUrl(normalizedStillUrl, this.baseUrl)
            : null;
        if (!normalizedName) return this.failure("invalid-name");
        if (!hasAssetReference && !canonicalUrl) return this.failure("invalid-url");
        if (current.kind === "audio" && normalizedStillUrl && !canonicalStillUrl) {
            return this.failure("invalid-still-url");
        }
        const candidate = current.kind === "audio"
            ? (audioAssetId ? { id, name: normalizedName, kind: "audio", audioAssetId,
                ...(stillAssetId ? { stillAssetId } : {}),
                ...(motionAssetId ? { motionAssetId } : {}) }
                : { id, name: normalizedName, kind: "audio", audioUrl: canonicalUrl,
                    ...(canonicalStillUrl ? { stillUrl: canonicalStillUrl } : {}) })
            : current.kind === "hls"
            ? { id, name: normalizedName, kind: "hls", url: canonicalUrl, enabled: enabled !== false }
            : { id, name: normalizedName, kind: current.kind,
                ...(assetId ? { assetId } : { url: canonicalUrl }) };
        const next = this.createSourceRecord(candidate, current.origin);
        if (!next) return this.failure("source-update-rejected");
        if (hasActiveInstances && (current.kind !== "audio" ||
            next.audioUrl !== current.audioUrl)) {
            return this.failure("source-has-active-instances");
        }
        const runtimeUpdated = next.available === false
            ? (current.available === false || Boolean(this.studioSourceManager.unregisterSource(id)))
            : current.available === false
                ? Boolean(this.studioSourceManager.registerSource(next))
                : Boolean(this.studioSourceManager.replaceSource(next));
        if (!runtimeUpdated) return this.failure("source-update-rejected");
        const previousOverride = this.sourceOverrides.get(id);
        this.sources.set(id, next);
        if (this.baseSourceIds.has(id)) this.sourceOverrides.set(id, next);
        if (!this.persistOverlay()) {
            if (next.available === false && current.available !== false) {
                this.studioSourceManager.registerSource(current);
            }
            else if (next.available !== false && current.available === false) {
                this.studioSourceManager.unregisterSource(id);
            }
            else if (current.available !== false) this.studioSourceManager.replaceSource(current);
            this.sources.set(id, current);
            if (this.baseSourceIds.has(id)) {
                if (previousOverride) this.sourceOverrides.set(id, previousOverride);
                else this.sourceOverrides.delete(id);
            }
            return this.failure("persistence-failed");
        }
        this.notify();
        return Object.freeze({ ok: true, source: next });
    }

    updateLiveSource(sourceId, { name, url, enabled } = {}) {
        if (!this.initialized || this.mutating) return this.failure("catalog-unavailable");
        const id = this.normalizeString(sourceId, MAX_ID_LENGTH);
        const current = id ? this.sources.get(id) : null;
        if (!current || current.kind !== "hls") {
            return this.failure("source-not-editable");
        }
        const normalizedName = this.normalizeString(name, MAX_NAME_LENGTH);
        const canonicalUrl = this.createHttpUrl(url, this.baseUrl);
        if (!normalizedName) return this.failure("invalid-name");
        if (!canonicalUrl) return this.failure("invalid-url");
        const scene = Array.from(this.definitions.values()).find(
            (item) => item.renderer.kind === "source" && item.renderer.sourceId === id);
        if (enabled !== true && current.enabled !== false &&
            (scene && [this.studioStateManager.getPreviewSceneId(),
                this.studioStateManager.getProgramSceneId()].includes(scene.id) ||
                this.studioSourceManager.getActiveInstances().some(
                    (instance) => instance.sourceId === id))) {
            return this.failure("source-in-use");
        }
        const next = this.createSourceRecord({ id, name: normalizedName, kind: "hls",
            url: canonicalUrl, enabled: enabled === true }, current.origin);
        const nextScene = scene;
        this.mutating = true;
        try {
            const previousOverride = this.sourceOverrides.get(id);
            if (!this.studioSourceManager.replaceSource?.(next)) {
                return this.failure("source-update-rejected");
            }
            const wasEnabled = current.enabled !== false;
            if (scene && wasEnabled && !next.enabled) {
                this.studioStateManager.unregisterScene(scene.id);
            }
            if (scene && !wasEnabled && next.enabled) {
                this.studioStateManager.registerScene(nextScene);
            }
            this.sources.set(id, next);
            if (this.baseSourceIds.has(id)) this.sourceOverrides.set(id, next);
            if (scene) this.definitions.set(scene.id, nextScene);
            if (!this.persistOverlay()) {
                this.studioSourceManager.replaceSource(current);
                this.sources.set(id, current);
                if (this.baseSourceIds.has(id)) {
                    if (previousOverride) this.sourceOverrides.set(id, previousOverride);
                    else this.sourceOverrides.delete(id);
                }
                if (scene) this.definitions.set(scene.id, scene);
                return this.failure("persistence-failed");
            }
            this.notify();
            return Object.freeze({ ok: true, source: next, scene: nextScene });
        } finally { this.mutating = false; }
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
            if (source.enabled !== false && !this.registerSceneDefinition(scene)) {
                this.sources.delete(source.id);
                this.studioSourceManager.unregisterSource(source.id);
                return this.failure("scene-registration-rejected");
            }
            if (source.enabled === false) this.definitions.set(scene.id, scene);

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

    updateScene(sceneId, { name, sourceId } = {}) {
        if (!this.initialized || this.mutating) return this.failure("catalog-unavailable");
        const id = this.normalizeString(sceneId, MAX_ID_LENGTH);
        const current = id ? this.definitions.get(id) : null;
        if (!current) return this.failure("scene-not-found");
        if ([this.studioStateManager.getPreviewSceneId(),
            this.studioStateManager.getProgramSceneId()].includes(id)) {
            return this.failure("scene-in-use");
        }
        const normalizedName = this.normalizeString(name, MAX_NAME_LENGTH);
        const selectedSourceId = this.normalizeString(sourceId, MAX_ID_LENGTH);
        const source = selectedSourceId ? this.sources.get(selectedSourceId) : null;
        if (!normalizedName) return this.failure("invalid-name");
        if (!source) return this.failure("source-not-found");
        const next = this.createSceneDefinition({ id, name: normalizedName,
            type: this.getSourceCategory(source.kind).toUpperCase(),
            renderer: { kind: "source", sourceId: source.id } }, current.origin);
        if (!next || !this.studioStateManager.replaceScene?.(next)) {
            return this.failure("scene-update-rejected");
        }
        const previousOverride = this.sceneOverrides.get(id);
        this.definitions.set(id, next);
        if (this.baseSceneIds.has(id)) this.sceneOverrides.set(id, next);
        if (!this.persistOverlay()) {
            this.definitions.set(id, current);
            this.studioStateManager.replaceScene(current);
            if (this.baseSceneIds.has(id)) {
                if (previousOverride) this.sceneOverrides.set(id, previousOverride);
                else this.sceneOverrides.delete(id);
            }
            return this.failure("persistence-failed");
        }
        this.notify();
        return Object.freeze({ ok: true, scene: next });
    }

    removeScene(sceneId) {
        if (!this.initialized || this.mutating) return this.failure("catalog-unavailable");
        const id = this.normalizeString(sceneId, MAX_ID_LENGTH);
        const scene = id ? this.definitions.get(id) : null;
        if (!scene) return this.failure("scene-not-found");
        if (id === this.studioStateManager.getPreviewSceneId()) return this.failure("scene-in-preview");
        if (id === this.studioStateManager.getProgramSceneId()) return this.failure("scene-in-program");
        const blockedReason = this.removalGuard?.({ sourceId: null, sceneId: id });
        if (blockedReason) return this.failure(typeof blockedReason === "string"
            ? blockedReason : "scene-authorized");
        const previousOverlay = this.serializeOverlay();
        const previousOverride = this.sceneOverrides.get(id);
        if (!this.studioStateManager.unregisterScene(id)) return this.failure("scene-unregister-rejected");
        this.definitions.delete(id);
        this.operatorSceneIds.delete(id);
        if (this.baseSceneIds.has(id)) {
            this.sceneOverrides.delete(id);
            this.deletedBootstrapSceneIds.add(id);
        }
        if (!this.persistOverlay()) {
            this.definitions.set(id, scene);
            this.studioStateManager.registerScene(scene);
            if (scene.origin === "operator") this.operatorSceneIds.add(id);
            this.deletedBootstrapSceneIds.delete(id);
            if (previousOverride) this.sceneOverrides.set(id, previousOverride);
            this.writeOverlay(previousOverlay);
            return this.failure("persistence-failed");
        }
        this.notify();
        return Object.freeze({ ok: true, scene });
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
        const references = Array.from(this.definitions.values()).filter(
            (definition) => definition.renderer.kind === "source" &&
                definition.renderer.sourceId === id
        );
        if (references.some(({ id: sceneId }) =>
            sceneId === this.studioStateManager.getPreviewSceneId())) {
            return this.failure("source-in-preview");
        }
        if (references.some(({ id: sceneId }) =>
            sceneId === this.studioStateManager.getProgramSceneId())) {
            return this.failure("source-in-program");
        }
        if (references.length > 0) {
            return this.failure("source-still-referenced");
        }

        const blockedReason = this.removalGuard?.({ sourceId: id, sceneId: null });
        if (blockedReason) return this.failure(typeof blockedReason === "string"
            ? blockedReason : "source-authorized");
        if (this.studioSourceManager.getActiveInstances().some(
            (instance) => instance.sourceId === id
        )) {
            return this.failure("source-has-active-instances");
        }

        this.mutating = true;
        try {
            const previousOverlay = this.serializeOverlay();
            const previousOverride = this.sourceOverrides.get(id);
            this.sources.delete(id);
            this.operatorSourceIds.delete(id);
            if (this.baseSourceIds.has(id)) {
                this.sourceOverrides.delete(id);
                this.deletedBootstrapSourceIds.add(id);
            }

            if (!this.studioSourceManager.unregisterSource(id)) {
                this.sources.set(id, source);
                if (source.origin === "operator") this.operatorSourceIds.add(id);
                this.deletedBootstrapSourceIds.delete(id);
                if (previousOverride) this.sourceOverrides.set(id, previousOverride);
                return this.failure("source-unregister-rejected");
            }

            if (!this.persistOverlay()) {
                this.studioSourceManager.registerSource(source);
                this.sources.set(id, source);
                if (source.origin === "operator") this.operatorSourceIds.add(id);
                this.deletedBootstrapSourceIds.delete(id);
                if (previousOverride) this.sourceOverrides.set(id, previousOverride);
                this.writeOverlay(previousOverlay);
                return this.failure("persistence-failed");
            }

            this.notify();
            return Object.freeze({ ok: true, source });
        }
        finally {
            this.mutating = false;
        }
    }

    isAssetReferenced(assetId) {
        return this.getAssetReferences(assetId).length > 0;
    }

    getAssetReferences(assetId) {
        const id = this.normalizeString(assetId, MAX_ID_LENGTH);
        if (!id) return Object.freeze([]);
        return Object.freeze(Array.from(this.sources.values()).flatMap((source) => {
            const fields = ["assetId", "audioAssetId", "stillAssetId", "motionAssetId"]
                .filter((field) => source[field] === id);
            return fields.length ? [Object.freeze({ sourceId: source.id,
                sourceName: source.name, fields: Object.freeze(fields) })] : [];
        }));
    }

    registerSourceRecord(source) {
        if (!source || this.sources.has(source.id)) {
            return false;
        }
        if (source.available !== false && !this.studioSourceManager.registerSource(source)) return false;
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
            return this.emptyOverlay([{ reason: "overlay-read-failed" }]);
        }

        if (!value) {
            return this.emptyOverlay();
        }

        let parsed;
        try {
            parsed = JSON.parse(value);
        }
        catch {
            return this.emptyOverlay([{ reason: "overlay-invalid-json" }]);
        }

        const v1 = this.hasExactKeys(parsed, ["version", "sources", "scenes"]) && parsed.version === 1;
        const modern = this.hasExactKeys(parsed, ["version", "sources", "scenes", "sourceOverrides",
            "sceneOverrides", "deletedBootstrapSourceIds", "deletedBootstrapSceneIds"]) &&
            [2, 3].includes(parsed.version);
        if ((!v1 && !modern) ||
            !Array.isArray(parsed.sources) || !Array.isArray(parsed.scenes) ||
            parsed.sources.length > 500) {
            return this.emptyOverlay([{ reason: "overlay-invalid-schema" }]);
        }

        const sources = parsed.sources.map((item) =>
            this.createOverlaySource(item)
        );
        const scenes = parsed.scenes.map((item) =>
            this.createOverlayScene(item)
        );
        if (sources.some((item) => !item) || scenes.some((item) => !item)) {
            return this.emptyOverlay([{ reason: "overlay-invalid-record" }]);
        }

        const sourceById = new Map();
        for (const source of sources) {
            if (sourceById.has(source.id)) {
                return this.emptyOverlay([{ reason: "overlay-duplicate-id" }]);
            }
            sourceById.set(source.id, source);
        }

        const sceneIds = new Set();
        for (const scene of scenes) {
            if (sceneIds.has(scene.id)) {
                return this.emptyOverlay([{ reason: "overlay-invalid-reference" }]);
            }
            sceneIds.add(scene.id);
        }
        const sourceOverrides = modern ? parsed.sourceOverrides.map((item) =>
            this.createSourceRecord(item, "base")) : [];
        const sceneOverrides = modern ? parsed.sceneOverrides.map((item) =>
            this.createSceneDefinition(item, "base")) : [];
        const deletedBootstrapSourceIds = modern ? parsed.deletedBootstrapSourceIds : [];
        const deletedBootstrapSceneIds = modern ? parsed.deletedBootstrapSceneIds : [];
        if (sourceOverrides.some((item) => !item) || sceneOverrides.some((item) => !item) ||
            !this.validIdList(deletedBootstrapSourceIds) || !this.validIdList(deletedBootstrapSceneIds)) {
            return this.emptyOverlay([{ reason: "overlay-invalid-record" }]);
        }
        return { sources, scenes, sourceOverrides, sceneOverrides,
            deletedBootstrapSourceIds, deletedBootstrapSceneIds, issues: [] };
    }

    emptyOverlay(issues = []) {
        return { sources: [], scenes: [], sourceOverrides: [], sceneOverrides: [],
            deletedBootstrapSourceIds: [], deletedBootstrapSceneIds: [], issues };
    }

    validIdList(value) {
        return Array.isArray(value) && value.length <= 500 &&
            value.every((id, index) => this.normalizeString(id, MAX_ID_LENGTH) === id &&
                value.indexOf(id) === index);
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
        const audio = this.hasAllowedKeys(candidate,
            ["id", "name", "kind", "audioAssetId"],
            ["stillAssetId", "motionAssetId"]);
        const audioUrl = this.hasExactKeys(
            candidate,
            ["id", "name", "kind", "audioUrl"]
        );
        const audioUrlWithStill = this.hasExactKeys(
            candidate,
            ["id", "name", "kind", "audioUrl", "stillUrl"]
        );
        const image = this.hasExactKeys(
            candidate,
            ["id", "name", "kind", "url"]
        );
        if (candidate.kind === "media") {
            if ((!directUrl && !assetBacked) ||
                !this.isGeneratedSourceId(candidate.id, "media") &&
                !this.isGeneratedSourceId(candidate.id, "video")) {
                return null;
            }
        }
        else if (candidate.kind === "audio") {
            if ((!audio && !audioUrl && !audioUrlWithStill) ||
                !this.isGeneratedSourceId(candidate.id, "audio")) {
                return null;
            }
        }
        else if (candidate.kind === "image") {
            if ((!image && !assetBacked) || !this.isGeneratedSourceId(candidate.id, "image")) return null;
        }
        else if (candidate.kind === "hls") {
            const live = this.hasExactKeys(candidate,
                ["id", "name", "kind", "url", "enabled"]);
            if (!live || !this.isGeneratedSourceId(candidate.id, "live") ||
                typeof candidate.enabled !== "boolean") return null;
        }
        else {
            return null;
        }
        return this.createSourceRecord(candidate, "operator");
    }

    createOverlayScene(candidate) {
        if (!this.hasExactKeys(candidate, ["id", "name", "type", "renderer"]) ||
            !["MEDIA", "VIDEO", "AUDIO", "LIVE", "IMAGE"].includes(candidate.type) ||
            !["media", "live", "audio", "image"].some((kind) =>
                this.isGeneratedSceneId(candidate.id, kind)) ||
            !this.hasExactKeys(candidate.renderer, ["kind", "sourceId"]) ||
            candidate.renderer.kind !== "source" ||
            !this.normalizeString(candidate.renderer.sourceId, MAX_ID_LENGTH)) {
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
            const resolution = assetId ? this.resolveAsset(assetId, "video") : null;
            const asset = resolution?.ok ? resolution.asset : null;
            const url = asset
                ? this.createHttpUrl(asset.url)
                : this.createHttpUrl(candidate.url);
            if (assetId && !asset) return Object.freeze({ id, name, kind, assetId,
                available: false, unavailableReason: resolution?.reason || "asset-not-found", origin });
            return url ? Object.freeze({
                id,
                name,
                kind,
                url,
                ...(assetId ? { assetId } : {}),
                available: true,
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
            const motionAssetId = this.normalizeString(
                candidate.motionAssetId,
                MAX_ID_LENGTH
            );
            const audioResolution = audioAssetId ? this.resolveAsset(audioAssetId, "audio") : null;
            const stillResolution = stillAssetId ? this.resolveAsset(stillAssetId, "image") : null;
            const motionResolution = motionAssetId ? this.resolveAsset(motionAssetId, "video") : null;
            const audioAsset = audioResolution?.ok ? audioResolution.asset : null;
            const stillAsset = stillResolution?.ok ? stillResolution.asset : null;
            const motionAsset = motionResolution?.ok ? motionResolution.asset : null;
            const audioUrl = audioAsset
                ? this.createHttpUrl(audioAsset.url)
                : this.createHttpUrl(candidate.audioUrl);
            const stillUrl = stillAsset
                ? this.createHttpUrl(stillAsset.url)
                : this.createHttpUrl(candidate.stillUrl);
            const motionUrl = motionAsset ? this.createHttpUrl(motionAsset.url) : null;
            if (audioAssetId && !audioAsset) return Object.freeze({ id, name, kind,
                audioAssetId, ...(stillAssetId ? { stillAssetId } : {}),
                ...(motionAssetId ? { motionAssetId } : {}), available: false,
                unavailableReason: audioResolution?.reason || "asset-not-found", origin });
            if (!audioUrl || candidate.stillUrl && !stillUrl) {
                return null;
            }
            return Object.freeze({
                id,
                name,
                kind,
                audioUrl,
                ...(audioAssetId ? { audioAssetId } : {}),
                ...(stillAssetId ? { stillAssetId } : {}),
                ...(stillUrl ? { stillUrl } : {}),
                ...(stillAssetId && !stillAsset ? { stillAssetId,
                    stillUnavailableReason: stillResolution?.reason || "asset-not-found" } : {}),
                ...(motionAssetId ? { motionAssetId } : {}),
                ...(motionUrl ? { motionUrl } : {}),
                ...(motionAssetId && !motionAsset ? { motionUnavailableReason:
                    motionResolution?.reason || "asset-not-found" } : {}),
                available: true,
                origin
            });
        }
        if (kind === "image") {
            const assetId = this.normalizeString(candidate.assetId, MAX_ID_LENGTH);
            const resolution = assetId ? this.resolveAsset(assetId, "image") : null;
            const asset = resolution?.ok ? resolution.asset : null;
            const url = asset ? this.createHttpUrl(asset.url) : this.createHttpUrl(candidate.url);
            if (assetId && !asset) return Object.freeze({ id, name, kind, assetId,
                available: false, unavailableReason: resolution?.reason || "asset-not-found", origin });
            return url ? Object.freeze({ id, name, kind, url,
                ...(assetId ? { assetId } : {}), available: true, origin }) : null;
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
                enabled: candidate.enabled !== false,
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
            const logo = this.createHttpUrl(candidate.renderer.logo, this.baseUrl);
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
                stillAssetId,
                motionAssetId
            } = source;
            if (kind === "audio") {
                return audioAssetId
                    ? { id: sourceId, name, kind, audioAssetId,
                        ...(stillAssetId ? { stillAssetId } : {}),
                        ...(motionAssetId ? { motionAssetId } : {}) }
                    : { id: sourceId, name, kind, audioUrl: source.audioUrl,
                        ...(source.stillUrl ? { stillUrl: source.stillUrl } : {}) };
            }
            if (kind === "hls") {
                return { id: sourceId, name, kind, url, enabled: source.enabled !== false };
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
        const sourceOverrides = Array.from(this.sourceOverrides.values(), (source) =>
            this.serializeSource(source));
        const sceneOverrides = Array.from(this.sceneOverrides.values(), (scene) => ({
            id: scene.id, name: scene.name, type: scene.type, renderer: { ...scene.renderer }
        }));
        return JSON.stringify({ version: SCHEMA_VERSION, sources, scenes,
            sourceOverrides, sceneOverrides,
            deletedBootstrapSourceIds: Array.from(this.deletedBootstrapSourceIds),
            deletedBootstrapSceneIds: Array.from(this.deletedBootstrapSceneIds) });
    }

    serializeSource(source) {
        if (source.kind === "audio") return source.audioAssetId
            ? { id: source.id, name: source.name, kind: source.kind,
                audioAssetId: source.audioAssetId,
                ...(source.stillAssetId ? { stillAssetId: source.stillAssetId } : {}),
                ...(source.motionAssetId ? { motionAssetId: source.motionAssetId } : {}) }
            : { id: source.id, name: source.name, kind: source.kind,
                audioUrl: source.audioUrl, ...(source.stillUrl ? { stillUrl: source.stillUrl } : {}) };
        if (source.kind === "hls") return { id: source.id, name: source.name,
            kind: source.kind, ...(source.configRef ? { configRef: source.configRef } : { url: source.url }),
            enabled: source.enabled !== false };
        return source.assetId
            ? { id: source.id, name: source.name, kind: source.kind, assetId: source.assetId }
            : { id: source.id, name: source.name, kind: source.kind, url: source.url };
    }

    resolveAsset(assetId, expectedKind) {
        if (typeof this.assetResolver === "function") {
            const asset = this.assetResolver(assetId);
            if (!asset) return { ok: false, reason: "asset-not-found" };
            const accepted = expectedKind === "image" ? ["image", "still"] : [expectedKind];
            return accepted.includes(asset.kind)
                ? { ok: true, asset }
                : { ok: false, reason: "asset-kind-mismatch" };
        }
        return this.assetResolver?.resolve?.(assetId, { expectedKind }) ||
            { ok: false, reason: "asset-not-found" };
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

    handleStorage(event) {
        if (!this.initialized || this.mutating || event?.key !== STORAGE_KEY) return;
        const overlay = this.loadOverlay();
        if (overlay.issues.length) return;
        const incomingPairs = overlay.sources.map((source) => ({
            source,
            scene: overlay.scenes.find((scene) => scene.renderer.sourceId === source.id)
        })).filter((pair) => pair.scene);
        const incoming = new Map(incomingPairs.map((pair) => [pair.source.id, pair]));
        const currentLiveIds = Array.from(this.operatorSourceIds).filter(
            (id) => this.sources.get(id)?.kind === "hls");
        currentLiveIds.forEach((id) => {
            if (!incoming.has(id)) this.removeRuntimePairFromExternal(id);
        });
        incomingPairs.filter(({ source }) => source.kind === "hls").forEach(({ source, scene }) => {
            const current = this.sources.get(source.id);
            if (!current) {
                if (this.registerSourceRecord(source)) {
                    this.definitions.set(scene.id, scene);
                    if (source.enabled) this.studioStateManager.registerScene(scene);
                    this.operatorSourceIds.add(source.id); this.operatorSceneIds.add(scene.id);
                }
                return;
            }
            this.studioSourceManager.replaceSource?.(source);
            this.sources.set(source.id, source); this.definitions.set(scene.id, scene);
            if (current.enabled !== false && !source.enabled &&
                ![this.studioStateManager.getPreviewSceneId(), this.studioStateManager.getProgramSceneId()].includes(scene.id)) {
                this.studioStateManager.unregisterScene(scene.id);
            } else if (current.enabled === false && source.enabled) {
                this.studioStateManager.registerScene(scene);
            }
        });
        this.notify();
    }

    removeRuntimePairFromExternal(sourceId) {
        const source = this.sources.get(sourceId);
        const scene = Array.from(this.definitions.values()).find(
            (item) => item.renderer.kind === "source" && item.renderer.sourceId === sourceId);
        if (!source || !scene || source.enabled !== false ||
            [this.studioStateManager.getPreviewSceneId(), this.studioStateManager.getProgramSceneId()].includes(scene.id) ||
            this.studioSourceManager.getActiveInstances().some((item) => item.sourceId === sourceId)) return false;
        this.studioStateManager.unregisterScene(scene.id);
        if (!this.studioSourceManager.unregisterSource(sourceId)) return false;
        this.sources.delete(sourceId); this.definitions.delete(scene.id);
        this.operatorSourceIds.delete(sourceId); this.operatorSceneIds.delete(scene.id);
        return true;
    }

    destroy() {
        this.eventTarget?.removeEventListener?.("storage", this.handleStorage);
        this.listeners.clear();
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

    hasAllowedKeys(value, requiredKeys, optionalKeys = []) {
        if (!this.isPlainObject(value)) return false;
        const actual = Object.keys(value);
        return requiredKeys.every((key) => actual.includes(key)) &&
            actual.every((key) => requiredKeys.includes(key) || optionalKeys.includes(key));
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

    getSourceCategory(kind) {
        return ({ hls: "live", media: "video", audio: "audio", image: "image" })[kind] || kind;
    }
}
