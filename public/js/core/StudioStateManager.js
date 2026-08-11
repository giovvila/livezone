import EventBus from "./EventBus.js";
import Events from "./Events.js";

class StudioStateManager {

    constructor() {
        this.scenes = new Map();
        this.previewSceneId = null;
        this.programSceneId = null;
        this.initialized = false;
    }

    initialize() {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
    }

    registerScene(scene) {
        const canonicalScene = this.createCanonicalScene(scene);

        if (!canonicalScene || this.scenes.has(canonicalScene.id)) {
            return null;
        }

        this.scenes.set(canonicalScene.id, canonicalScene);

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

        EventBus.emit(Events.STUDIO_PREVIEW_CHANGED, record);

        return record;
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
