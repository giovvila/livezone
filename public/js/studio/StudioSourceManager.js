import StudioHlsSurface from "./renderers/StudioHlsSurface.js";
import StudioMediaSurface from "./renderers/StudioMediaSurface.js";

class StudioSourceManager {

    constructor() {
        this.sources = new Map();
        this.instances = new Map();
        this.technicalConfig = null;
        this.initialized = false;
        this.nextInstanceId = 1;
        this.sourceFactories = new Map([
            ["hls", (options) => new StudioHlsSurface(options)],
            ["media", (options) => new StudioMediaSurface(options)]
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

    createInstance(sourceId, { consumer } = {}) {
        const id = this.normalizeString(sourceId);

        if (!id || !["preview", "program"].includes(consumer)) {
            return null;
        }

        const definition = this.sources.get(id);

        if (!definition) {
            return null;
        }

        const sourceUrl = definition.kind === "hls"
            ? this.resolveConfigRef(definition.configRef)
            : definition.url;

        if (!sourceUrl) {
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
            instanceId,
            consumer,
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
            const configRef = this.normalizeString(definition.configRef);
            return configRef ? Object.freeze({ id, kind, configRef }) : null;
        }

        if (kind === "media") {
            const url = this.normalizeString(definition.url);

            if (!url) {
                return null;
            }

            try {
                return Object.freeze({
                    id,
                    kind,
                    url: new URL(url).href
                });
            }
            catch {
                return null;
            }
        }

        return null;
    }

    createSourceSnapshot(source) {
        return Object.freeze(
            source.kind === "hls"
                ? {
                    id: source.id,
                    kind: source.kind,
                    configRef: source.configRef
                }
                : {
                    id: source.id,
                    kind: source.kind,
                    url: source.url
                }
        );
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
