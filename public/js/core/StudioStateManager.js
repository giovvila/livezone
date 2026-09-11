import EventBus from "./EventBus.js";
import Events from "./Events.js";

const STORAGE_KEY = "livezone.studio.selection.v1";
const SCHEMA_VERSION = 1;

export class StudioStateManager {

    constructor({ storage = null, eventTarget = globalThis } = {}) {
        this.scenes = new Map();
        this.previewSceneId = null;
        this.programSceneId = null;
        this.pendingSelection = null;
        this.storage = storage ?? this.getDefaultStorage();
        this.eventTarget = eventTarget;
        this.initialized = false;
        this.programGuards = new Set();
        this.handleStorage = this.handleStorage.bind(this);
    }

    initialize() {
        if (this.initialized) {
            return;
        }

        this.pendingSelection = this.loadSelection();
        this.eventTarget?.addEventListener?.("storage", this.handleStorage);
        this.initialized = true;
    }

    registerScene(scene) {
        const canonicalScene = this.createCanonicalScene(scene);

        if (!canonicalScene || this.scenes.has(canonicalScene.id)) {
            return null;
        }

        this.scenes.set(canonicalScene.id, canonicalScene);
        this.restoreRegisteredSelection(canonicalScene.id);

        EventBus.emit(
            Events.STUDIO_SCENE_REGISTERED,
            Object.freeze({
                scene: this.createSceneSnapshot(canonicalScene)
            })
        );

        return this.createSceneSnapshot(canonicalScene);
    }

    unregisterScene(sceneId) {
        const normalizedSceneId = this.normalizeRequiredString(sceneId);

        if (!normalizedSceneId) {
            return null;
        }

        const scene = this.scenes.get(normalizedSceneId);

        if (
            !scene ||
            normalizedSceneId === this.previewSceneId ||
            normalizedSceneId === this.programSceneId
        ) {
            return null;
        }

        this.scenes.delete(normalizedSceneId);

        EventBus.emit(
            Events.STUDIO_SCENE_UNREGISTERED,
            Object.freeze({
                scene: this.createSceneSnapshot(scene)
            })
        );

        return this.createSceneSnapshot(scene);
    }

    replaceScene(scene) {
        const canonicalScene = this.createCanonicalScene(scene);
        if (!canonicalScene || !this.scenes.has(canonicalScene.id)) return null;
        const previous = this.scenes.get(canonicalScene.id);
        this.scenes.set(canonicalScene.id, canonicalScene);
        EventBus.emit(Events.STUDIO_SCENE_UPDATED, Object.freeze({
            previousScene: this.createSceneSnapshot(previous),
            scene: this.createSceneSnapshot(canonicalScene)
        }));
        return this.createSceneSnapshot(canonicalScene);
    }

    getScene(sceneId) {
        const normalizedSceneId = this.normalizeRequiredString(sceneId);
        const scene = normalizedSceneId
            ? this.scenes.get(normalizedSceneId)
            : null;

        return scene ? this.createSceneSnapshot(scene) : null;
    }

    getScenes() {
        return Object.freeze(
            Array.from(
                this.scenes.values(),
                (scene) => this.createSceneSnapshot(scene)
            )
        );
    }

    getPreviewSceneId() {
        return this.previewSceneId;
    }

    getProgramSceneId() {
        return this.programSceneId;
    }
    addProgramGuard(guard) {
        this.programGuards.add(guard);
        return () => this.programGuards.delete(guard);
    }
    canChangeProgram(sceneId, { source = null, reason = null, path = "command" } = {}) {
        for (const guard of this.programGuards)
            if (guard({ sceneId, source, reason, path }) === false) return false;
        return true;
    }

    releaseProgram({ source = null, reason = null } = {}) {
        if (!this.canChangeProgram(null, { source, reason, path: "releaseProgram" })) return null;
        if (this.programSceneId === null) {
            return null;
        }

        const record = Object.freeze({
            previousSceneId: this.programSceneId,
            currentSceneId: null,
            source,
            reason,
            timestamp: new Date().toISOString()
        });

        this.programSceneId = null;
        this.persistSelection();
        EventBus.emit(Events.STUDIO_PROGRAM_CHANGED, record);

        return record;
    }

    setPreviewScene(
        sceneId,
        { source = null, reason = null } = {}
    ) {
        let nextSceneId = null;

        if (sceneId !== null) {
            nextSceneId = this.normalizeRequiredString(sceneId);

            if (!nextSceneId || !this.scenes.has(nextSceneId)) {
                return null;
            }
        }

        if (nextSceneId === this.previewSceneId) {
            return null;
        }

        const record = Object.freeze({
            previousSceneId: this.previewSceneId,
            currentSceneId: nextSceneId,
            source,
            reason,
            timestamp: new Date().toISOString()
        });

        this.previewSceneId = nextSceneId;
        this.persistSelection();

        EventBus.emit(Events.STUDIO_PREVIEW_CHANGED, record);

        return record;
    }

    setProgramScene(sceneId, { source = null, reason = null } = {}) {
        if (!this.canChangeProgram(sceneId, { source, reason, path: "setProgramScene" })) return null;
        if (!this.scenes.has(sceneId) || this.programSceneId === sceneId) return null;
        const record = Object.freeze({ previousSceneId: this.programSceneId,
            currentSceneId: sceneId, source, reason, timestamp: new Date().toISOString() });
        this.programSceneId = sceneId;
        this.persistSelection();
        EventBus.emit(Events.STUDIO_PROGRAM_CHANGED, record);
        return record;
    }

    take({ source = null, reason = null } = {}) {
        if (!this.canChangeProgram(this.previewSceneId, { source, reason, path: "take" })) return null;
        if (
            !this.previewSceneId ||
            !this.scenes.has(this.previewSceneId) ||
            this.previewSceneId === this.programSceneId
        ) {
            return null;
        }

        const incomingProgramSceneId = this.previewSceneId;
        const outgoingProgramSceneId = this.programSceneId;
        const timestamp = new Date().toISOString();
        const programRecord = Object.freeze({
            previousSceneId: outgoingProgramSceneId,
            currentSceneId: incomingProgramSceneId,
            source,
            reason,
            timestamp
        });
        const previewRecord = Object.freeze({
            previousSceneId: incomingProgramSceneId,
            currentSceneId: outgoingProgramSceneId,
            source,
            reason,
            timestamp
        });

        this.programSceneId = incomingProgramSceneId;
        this.previewSceneId = outgoingProgramSceneId;
        this.persistSelection();

        EventBus.emit(Events.STUDIO_PROGRAM_CHANGED, programRecord);
        EventBus.emit(Events.STUDIO_PREVIEW_CHANGED, previewRecord);

        return programRecord;
    }

    restoreRegisteredSelection(sceneId) {
        if (!this.pendingSelection) {
            return;
        }

        if (this.pendingSelection.previewSceneId === sceneId) {
            this.previewSceneId = sceneId;
        }

        if (this.pendingSelection.programSceneId === sceneId) {
            if (!this.canChangeProgram(sceneId, { source: "storage", path: "restoreRegisteredSelection" })) return;
            this.programSceneId = sceneId;
        }
    }

    persistSelection() {
        try {
            this.storage?.setItem?.(STORAGE_KEY, JSON.stringify({
                version: SCHEMA_VERSION,
                previewSceneId: this.previewSceneId,
                programSceneId: this.programSceneId
            }));
        }
        catch {
            // Selection remains usable in memory when storage is unavailable.
        }
    }

    loadSelection(value = undefined) {
        try {
            const raw = value === undefined
                ? this.storage?.getItem?.(STORAGE_KEY)
                : value;

            if (!raw) {
                return null;
            }

            const selection = JSON.parse(raw);
            const validId = (id) => id === null ||
                typeof id === "string" && id.trim() === id && id.length > 0;

            if (!selection || typeof selection !== "object" ||
                Array.isArray(selection) || selection.version !== SCHEMA_VERSION ||
                !validId(selection.previewSceneId) ||
                !validId(selection.programSceneId)) {
                return null;
            }

            return Object.freeze({
                previewSceneId: selection.previewSceneId,
                programSceneId: selection.programSceneId
            });
        }
        catch {
            return null;
        }
    }

    handleStorage(event) {
        if (!this.initialized || event?.key !== STORAGE_KEY) {
            return;
        }

        const selection = this.loadSelection(event.newValue);

        if (!selection) {
            return;
        }

        this.pendingSelection = selection;
        this.applyExternalSelection("previewSceneId", selection.previewSceneId,
            Events.STUDIO_PREVIEW_CHANGED);
        this.applyExternalSelection("programSceneId", selection.programSceneId,
            Events.STUDIO_PROGRAM_CHANGED);
    }

    applyExternalSelection(property, sceneId, eventName) {
        const nextSceneId = sceneId === null || this.scenes.has(sceneId)
            ? sceneId
            : null;
        if (property === "programSceneId" && !this.canChangeProgram(nextSceneId,
            { source: "storage", reason: "external-selection", path: "applyExternalSelection" })) return;

        if (nextSceneId === this[property]) {
            return;
        }

        const record = Object.freeze({
            previousSceneId: this[property],
            currentSceneId: nextSceneId,
            source: "storage",
            reason: "external-selection",
            timestamp: new Date().toISOString()
        });
        this[property] = nextSceneId;
        EventBus.emit(eventName, record);
    }

    getDefaultStorage() {
        try {
            return globalThis.localStorage;
        }
        catch {
            return null;
        }
    }

    createCanonicalScene(scene) {
        if (!scene || typeof scene !== "object") {
            return null;
        }

        const id = this.normalizeRequiredString(scene.id);
        const name = this.normalizeRequiredString(scene.name);
        const type = this.normalizeRequiredString(scene.type);

        if (!id || !name || !type) {
            return null;
        }

        return Object.freeze({ id, name, type });
    }

    createSceneSnapshot(scene) {
        return Object.freeze({
            id: scene.id,
            name: scene.name,
            type: scene.type
        });
    }

    normalizeRequiredString(value) {
        if (typeof value !== "string") {
            return null;
        }

        const normalized = value.trim();

        return normalized || null;
    }

}

export default new StudioStateManager();
