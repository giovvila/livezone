export default class StudioProgramCommand {
    constructor({ stateManager, catalog, transitionCoordinator } = {}) {
        this.stateManager = stateManager;
        this.catalog = catalog;
        this.transitionCoordinator = transitionCoordinator;
    }

    async execute({ sceneId, transition = "CUT", origin = "schedule" } = {}) {
        if (!this.catalog?.getDefinition(sceneId)) return this.failure("unresolved-scene");
        if (this.transitionCoordinator?.isBusy()) return this.failure("transition-busy");
        if (this.stateManager?.getProgramSceneId() === sceneId) {
            return Object.freeze({ ok: true, changed: false, reason: "already-program" });
        }

        if (this.stateManager?.getPreviewSceneId() !== sceneId) {
            const selected = this.stateManager?.setPreviewScene(sceneId, {
                source: origin, reason: "scheduled-preview"
            });
            if (!selected) return this.failure("preview-selection-failed");
        }

        const type = transition === "DISSOLVE" ? "dissolve" : "cut";
        const result = await this.transitionCoordinator?.transition({
            type,
            durationMs: type === "dissolve" ? 400 : 0,
            source: origin,
            reason: "scheduled-take"
        });
        return result
            ? Object.freeze({ ok: true, changed: true, transition: type })
            : this.failure("program-commit-failed");
    }

    failure(reason) { return Object.freeze({ ok: false, changed: false, reason }); }
}
