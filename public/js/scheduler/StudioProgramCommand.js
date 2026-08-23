export default class StudioProgramCommand {
    constructor({ stateManager, catalog, transitionCoordinator } = {}) {
        this.stateManager = stateManager;
        this.catalog = catalog;
        this.transitionCoordinator = transitionCoordinator;
    }

    async execute({ sceneId, transition = "CUT", origin = "schedule",
        initialCueSeconds = null } = {}) {
        const definition = this.catalog?.getDefinition(sceneId);
        if (!definition) return this.failure("unresolved-scene");
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
        const transportKind = this.getTransportKind(definition);
        const cue = ["media", "audio"].includes(transportKind) &&
            Number.isFinite(initialCueSeconds) && initialCueSeconds >= 0
            ? initialCueSeconds : null;
        const result = await this.transitionCoordinator?.transition({
            type,
            durationMs: type === "dissolve" ? 400 : 0,
            source: origin,
            reason: "scheduled-take",
            preparationContext: cue === null ? null : Object.freeze({
                transportCueTime: cue,
                transportInitialPlayback: "playing",
                transportInitialEnded: false
            })
        });
        return result
            ? Object.freeze({ ok: true, changed: true, transition: type })
            : this.failure("program-commit-failed");
    }

    failure(reason) { return Object.freeze({ ok: false, changed: false, reason }); }

    getTransportKind(definition) {
        if (definition?.renderer?.kind !== "source") return null;
        return this.catalog.getSources?.().find(({ id }) =>
            id === definition.renderer.sourceId)?.kind || null;
    }
}
