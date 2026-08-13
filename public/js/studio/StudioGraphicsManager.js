class StudioGraphicsManager {

    constructor() {
        this.graphics = new Map();
        this.visible = this.createConsumerMap(() => []);
        this.payloads = this.createConsumerMap(() => new Map());
        this.listeners = this.createConsumerMap(() => new Set());
        this.initialized = false;
    }

    initialize() {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
    }

    registerGraphic(definition) {
        const graphic = this.createCanonicalGraphic(definition);

        if (!this.initialized || !graphic || this.graphics.has(graphic.id)) {
            return null;
        }

        this.graphics.set(graphic.id, graphic);

        if (graphic.defaultVisible) {
            ["preview", "program"].forEach((consumer) => {
                this.visible[consumer].push(graphic.id);
            });
        }

        return this.createGraphicSnapshot(graphic);
    }

    getGraphic(graphicId) {
        const id = this.normalizeString(graphicId);
        const graphic = id ? this.graphics.get(id) : null;
        return graphic ? this.createGraphicSnapshot(graphic) : null;
    }

    getGraphics() {
        return Object.freeze(
            Array.from(this.graphics.values(), (graphic) =>
                this.createGraphicSnapshot(graphic)
            )
        );
    }

    getVisibleGraphics(consumer) {
        if (!this.isConsumer(consumer)) {
            return Object.freeze([]);
        }

        return Object.freeze(
            this.visible[consumer].map((graphicId) => Object.freeze({
                graphic: this.createGraphicSnapshot(this.graphics.get(graphicId)),
                payload: this.payloads[consumer].get(graphicId) || null
            }))
        );
    }

    show(graphicId, { consumer, payload = null } = {}) {
        const id = this.normalizeString(graphicId);

        if (!this.isConsumer(consumer) || !id || !this.graphics.has(id) ||
            this.visible[consumer].includes(id)) {
            return null;
        }

        this.visible[consumer].push(id);
        this.payloads[consumer].set(id, this.createPayloadSnapshot(payload));
        this.notify(consumer);
        return this.getVisibleGraphics(consumer);
    }

    hide(graphicId, { consumer } = {}) {
        const id = this.normalizeString(graphicId);

        if (!this.isConsumer(consumer) || !id) {
            return null;
        }

        const index = this.visible[consumer].indexOf(id);

        if (index === -1) {
            return null;
        }

        this.visible[consumer].splice(index, 1);
        this.payloads[consumer].delete(id);
        this.notify(consumer);
        return this.getVisibleGraphics(consumer);
    }

    subscribe(consumer, listener) {
        if (!this.isConsumer(consumer) || typeof listener !== "function") {
            return () => {};
        }

        this.listeners[consumer].add(listener);

        return () => {
            this.listeners[consumer].delete(listener);
        };
    }

    destroy() {
        ["preview", "program"].forEach((consumer) => {
            this.listeners[consumer].clear();
            this.visible[consumer] = [];
            this.payloads[consumer].clear();
        });

        this.graphics.clear();
        this.initialized = false;
    }

    notify(consumer) {
        const snapshot = this.getVisibleGraphics(consumer);
        this.listeners[consumer].forEach((listener) => listener(snapshot));
    }

    createCanonicalGraphic(definition) {
        if (!definition || typeof definition !== "object" ||
            Array.isArray(definition)) {
            return null;
        }

        const id = this.normalizeString(definition.id);
        const kind = this.normalizeString(definition.kind);
        const asset = this.normalizeString(definition.asset);
        const position = this.normalizeString(definition.position);

        if (!id || kind !== "image" || !asset || position !== "top-right" ||
            typeof definition.defaultVisible !== "boolean") {
            return null;
        }

        try {
            return Object.freeze({
                id,
                kind,
                asset: new URL(asset).href,
                position,
                defaultVisible: definition.defaultVisible
            });
        }
        catch {
            return null;
        }
    }

    createGraphicSnapshot(graphic) {
        return Object.freeze({
            id: graphic.id,
            kind: graphic.kind,
            asset: graphic.asset,
            position: graphic.position,
            defaultVisible: graphic.defaultVisible
        });
    }

    createPayloadSnapshot(payload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return null;
        }

        return this.cloneAndFreeze(payload);
    }

    cloneAndFreeze(value) {
        if (!value || typeof value !== "object") {
            return value;
        }

        if (Array.isArray(value)) {
            return Object.freeze(value.map((item) => this.cloneAndFreeze(item)));
        }

        return Object.freeze(
            Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                    key,
                    this.cloneAndFreeze(item)
                ])
            )
        );
    }

    createConsumerMap(factory) {
        return {
            preview: factory(),
            program: factory()
        };
    }

    isConsumer(consumer) {
        return consumer === "preview" || consumer === "program";
    }

    normalizeString(value) {
        if (typeof value !== "string") {
            return null;
        }

        const normalized = value.trim();
        return normalized || null;
    }
}

export default new StudioGraphicsManager();
