import StudioHlsSurface from "./renderers/StudioHlsSurface.js";

class StudioSourceManager {

    constructor() {
        this.sources = new Map();
        this.instances = new Map();
        this.technicalConfig = null;
        this.initialized = false;
        this.nextInstanceId = 1;
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

        const sourceUrl = this.resolveConfigRef(definition.configRef);

        if (!sourceUrl) {
            throw new Error("Studio source unavailable");
        }

        const instanceId = `studio-source-${this.nextInstanceId++}`;
        const instance = new StudioHlsSurface({
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
        const configRef = this.normalizeString(definition.configRef);

        if (!id || kind !== "hls" || !configRef) {
            return null;
        }

        return Object.freeze({ id, kind, configRef });
    }

    createSourceSnapshot(source) {
        return Object.freeze({
            id: source.id,
            kind: source.kind,
            configRef: source.configRef
        });
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
