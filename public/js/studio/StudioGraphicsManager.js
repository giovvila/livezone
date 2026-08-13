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
        return this.setGraphicState(graphicId, {
            consumer,
            visible: true,
            payload
        });
    }

    hide(graphicId, { consumer } = {}) {
        return this.setGraphicState(graphicId, {
            consumer,
            visible: false,
            payload: null
        });
    }

    setGraphicState(
        graphicId,
        { consumer, visible, payload = null } = {}
    ) {
        const id = this.normalizeString(graphicId);

        if (!this.isConsumer(consumer) || !id ||
            typeof visible !== "boolean") {
            return null;
        }

        const graphic = this.graphics.get(id);

        if (!graphic) {
            return null;
        }

        const index = this.visible[consumer].indexOf(id);
        const isVisible = index !== -1;

        if (!visible) {
            if (!isVisible) {
                return null;
            }

            this.visible[consumer].splice(index, 1);
            this.payloads[consumer].delete(id);
            this.notify(consumer);
            return this.getVisibleGraphics(consumer);
        }

        const canonicalPayload = this.createCanonicalPayload(graphic, payload);

        if (canonicalPayload === undefined) {
            return null;
        }

        if (isVisible && this.valuesEqual(
            this.payloads[consumer].get(id) || null,
            canonicalPayload
        )) {
            return null;
        }

        if (!isVisible) {
            this.visible[consumer].push(id);
        }

        this.payloads[consumer].set(id, canonicalPayload);
        this.notify(consumer);
        return this.getVisibleGraphics(consumer);
    }

    copyGraphicState(graphicId, { from, to } = {}) {
        const id = this.normalizeString(graphicId);

        if (!id || !this.graphics.has(id) || !this.isConsumer(from) ||
            !this.isConsumer(to) || from === to) {
            return null;
        }

        const visible = this.visible[from].includes(id);

        return this.setGraphicState(id, {
            consumer: to,
            visible,
            payload: visible ? this.payloads[from].get(id) || null : null
        });
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
        const position = this.normalizeString(definition.position);

        if (!id || typeof definition.defaultVisible !== "boolean") {
            return null;
        }

        if (kind === "image" && position === "top-right") {
            const asset = this.normalizeString(definition.asset);

            if (!asset) {
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

        if (kind === "lower-third" && position === "bottom-left") {
            return Object.freeze({
                id,
                kind,
                position,
                defaultVisible: definition.defaultVisible
            });
        }

        return null;
    }

    createGraphicSnapshot(graphic) {
        const snapshot = {
            id: graphic.id,
            kind: graphic.kind,
            position: graphic.position,
            defaultVisible: graphic.defaultVisible
        };

        if (graphic.kind === "image") {
            snapshot.asset = graphic.asset;
        }

        return Object.freeze(snapshot);
    }

    createCanonicalPayload(graphic, payload) {
        if (graphic.kind === "lower-third") {
            return this.createLowerThirdPayload(payload);
        }

        if (payload === null || payload === undefined) {
            return null;
        }

        if (typeof payload !== "object" || Array.isArray(payload)) {
            return null;
        }

        return this.cloneAndFreeze(payload);
    }

    createLowerThirdPayload(payload) {
        if (!payload || typeof payload !== "object" ||
            Array.isArray(payload) || typeof payload.title !== "string" ||
            (payload.subtitle !== undefined &&
                typeof payload.subtitle !== "string")) {
            return undefined;
        }

        const title = payload.title.trim();
        const subtitle = (payload.subtitle || "").trim();

        if (!title || Array.from(title).length > 80 ||
            Array.from(subtitle).length > 120) {
            return undefined;
        }

        return Object.freeze({ title, subtitle });
    }

    valuesEqual(left, right) {
        if (left === right) {
            return true;
        }

        if (!left || !right || typeof left !== "object" ||
            typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) {
            return false;
        }

        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);

        return leftKeys.length === rightKeys.length &&
            leftKeys.every((key) =>
                Object.prototype.hasOwnProperty.call(right, key) &&
                this.valuesEqual(left[key], right[key])
            );
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
