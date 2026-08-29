import StudioHlsSurface from "./renderers/StudioHlsSurface.js";
import StudioMediaSurface from "./renderers/StudioMediaSurface.js";
import StudioAudioSurface from "./renderers/StudioAudioSurface.js";
import StudioImageSurface from "./renderers/StudioImageSurface.js";

class StudioSourceManager {

    constructor() {
        this.sources = new Map();
        this.instances = new Map();
        this.technicalConfig = null;
        this.initialized = false;
        this.nextInstanceId = 1;
        this.sourceFactories = new Map([
            ["hls", (options) => new StudioHlsSurface(options)],
            ["media", (options) => new StudioMediaSurface(options)],
            ["audio", (options) => new StudioAudioSurface(options)],
            ["image", (options) => new StudioImageSurface(options)]
        ]);
    }

    initialize(technicalConfig) {
        if (this.initialized) {
            return;
        }

        this.technicalConfig = technicalConfig;
        this.initialized = true;
    }

    registerSource(definition) {
        const source = this.createCanonicalSource(definition);

        if (!this.initialized || !source || this.sources.has(source.id)) {
            return null;
        }

        this.sources.set(source.id, source);
        return this.createSourceSnapshot(source);
    }

    getSource(sourceId) {
        const id = this.normalizeString(sourceId);
        const source = id ? this.sources.get(id) : null;
        return source ? this.createSourceSnapshot(source) : null;
    }

    getSources() {
        return Object.freeze(
            Array.from(this.sources.values(), (source) =>
                this.createSourceSnapshot(source)
            )
        );
    }

    unregisterSource(sourceId) {
        const id = this.normalizeString(sourceId);

        if (!id || !this.sources.has(id) ||
            Array.from(this.instances.values()).some(
                (instance) => instance.sourceId === id
            )) {
            return null;
        }

        const source = this.sources.get(id);
        this.sources.delete(id);
        return this.createSourceSnapshot(source);
    }

    replaceSource(definition) {
        const source = this.createCanonicalSource(definition);

        if (!this.initialized || !source || !this.sources.has(source.id)) {
            return null;
        }

        const active = Array.from(this.instances.values()).filter(
            (instance) => instance.sourceId === source.id
        );
        if (active.length && active.some((instance) =>
            typeof instance.updateSourceDefinition !== "function" ||
            instance.updateSourceDefinition(source) !== true)) {
            return null;
        }

        this.sources.set(source.id, source);
        return this.createSourceSnapshot(source);
    }

    createInstance(sourceId, { consumer, initialTime, initialPlayback,
        initialEnded } = {}) {
        const id = this.normalizeString(sourceId);

        if (!id || !["preview", "program"].includes(consumer)) {
            return null;
        }

        const definition = this.sources.get(id);

        if (!definition) {
            return null;
        }

        const sourceUrl = definition.kind === "hls" && definition.configRef
            ? definition.resolvedUrl
            : definition.url;

        if (definition.kind !== "audio" && !sourceUrl) {
            throw new Error("Studio source unavailable");
        }

        const instanceId = `studio-source-${this.nextInstanceId++}`;
        const factory = this.sourceFactories.get(definition.kind);

        if (!factory) {
            return null;
        }

        const instance = factory({
            sourceId: definition.id,
            sourceUrl,
            audioUrl: definition.audioUrl,
            stillUrl: definition.stillUrl,
            instanceId,
            consumer,
            initialTime,
            initialPlayback: initialPlayback ??
                (definition.kind === "audio" && consumer === "preview"
                    ? "paused"
                    : "playing"),
            initialEnded: initialEnded === true,
            onDestroyed: () => {
                this.instances.delete(instanceId);
            }
        });

        this.instances.set(instanceId, instance);
        return instance;
    }

    destroyInstance(instance) {
        if (!instance || !this.instances.has(instance.instanceId)) {
            return false;
        }

        instance.destroy();
        this.instances.delete(instance.instanceId);
        return true;
    }

    getActiveInstances() {
        return Object.freeze(Array.from(this.instances.values()));
    }

    destroy() {
        Array.from(this.instances.values()).forEach((instance) => {
            instance.destroy();
        });

        this.instances.clear();
        this.sources.clear();
        this.technicalConfig = null;
        this.initialized = false;
        this.nextInstanceId = 1;
    }

    resolveConfigRef(reference) {
        const configRef = this.normalizeString(reference);

        if (!configRef) {
            return null;
        }

        let value = this.technicalConfig;

        for (const key of configRef.split(".")) {
            if (!key || !value || typeof value !== "object" ||
                !Object.prototype.hasOwnProperty.call(value, key)) {
                return null;
            }

            value = value[key];
        }

        return this.normalizeString(value);
    }

    createCanonicalSource(definition) {
        if (!definition || typeof definition !== "object" ||
            Array.isArray(definition)) {
            return null;
        }

        const id = this.normalizeString(definition.id);
        const kind = this.normalizeString(definition.kind);

        if (!id || !kind) {
            return null;
        }

        if (kind === "hls") {
            const hasConfigRef = Object.prototype.hasOwnProperty.call(
                definition,
                "configRef"
            );
            const hasUrl = Object.prototype.hasOwnProperty.call(
                definition,
                "url"
            );
            const configRef = this.normalizeString(definition.configRef);
            const url = this.normalizeString(definition.url);

            if (hasConfigRef === hasUrl) {
                return null;
            }

            if (hasConfigRef) {
                if (!configRef) {
                    return null;
                }

                const resolvedUrl = this.createHttpUrl(
                    this.resolveConfigRef(configRef)
                );

                return resolvedUrl
                    ? Object.freeze({ id, kind, configRef, resolvedUrl })
                    : null;
            }

            if (!url) {
                return null;
            }

            const canonicalUrl = this.createHttpUrl(url);

            return canonicalUrl
                ? Object.freeze({ id, kind, url: canonicalUrl })
                : null;
        }

        if (kind === "media") {
            const url = this.normalizeString(definition.url);

            if (!url) {
                return null;
            }

            const canonicalUrl = this.createHttpUrl(url);

            return canonicalUrl
                ? Object.freeze({ id, kind, url: canonicalUrl })
                : null;
        }

        if (kind === "image") {
            const url = this.createHttpUrl(definition.url);
            return url ? Object.freeze({ id, kind, url }) : null;
        }

        if (kind === "audio") {
            const audioUrl = this.createHttpUrl(definition.audioUrl);
            const stillUrl = this.createHttpUrl(definition.stillUrl);

            return audioUrl
                ? Object.freeze({ id, kind, audioUrl, ...(stillUrl ? { stillUrl } : {}) })
                : null;
        }

        return null;
    }

    createSourceSnapshot(source) {
        if (source.kind === "audio") {
            return Object.freeze({
                id: source.id,
                kind: source.kind,
                audioUrl: source.audioUrl,
                stillUrl: source.stillUrl || null
            });
        }

        return Object.freeze(
            source.kind === "hls" && source.configRef
                ? {
                    id: source.id,
                    kind: source.kind,
                    configRef: source.configRef,
                    url: source.resolvedUrl
                }
                : {
                    id: source.id,
                    kind: source.kind,
                    url: source.url
                }
        );
    }

    createHttpUrl(value) {
        const url = this.normalizeString(value);

        if (!url) {
            return null;
        }

        try {
            const parsed = new URL(url);
            return parsed.protocol === "http:" || parsed.protocol === "https:"
                ? parsed.href
                : null;
        }
        catch {
            return null;
        }
    }

    normalizeString(value) {
        if (typeof value !== "string") {
            return null;
        }

        const normalized = value.trim();
        return normalized || null;
    }
}

export default new StudioSourceManager();
