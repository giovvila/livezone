export default class StudioProgramCommand {
    constructor({ stateManager, catalog, transitionCoordinator, targetResolver = null } = {}) {
        this.stateManager = stateManager;
        this.catalog = catalog;
        this.transitionCoordinator = transitionCoordinator;
        this.targetResolver = targetResolver;
    }

    async execute({ sceneId, target = null, transition = "CUT", origin = "schedule",
        initialCueSeconds = null } = {}) {
        const requestedTarget = target || (sceneId
            ? Object.freeze({ kind: "scene", id: sceneId }) : null);
        const resolved = requestedTarget?.kind === "source"
            ? this.targetResolver?.resolve(requestedTarget)
            : requestedTarget?.kind === "scene"
                ? { sceneId: requestedTarget.id,
                    definition: this.catalog?.getDefinition(requestedTarget.id) }
                : null;
        sceneId = resolved?.sceneId || null;
        const definition = resolved?.definition || null;
        if (!definition) return this.failure(requestedTarget?.kind === "source"
            ? "unresolved-source" : "unresolved-scene");
        if (this.transitionCoordinator?.isBusy()) return this.failure("transition-busy");
        if (this.stateManager?.getProgramSceneId() === sceneId) {
            return Object.freeze({ ok: true, changed: false,
                reason: "already-program", sceneId });
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
        const diagnostics = result || this.transitionCoordinator?.getLastTransitionResult?.() || null;
        return result
            ? Object.freeze({ ok: true, changed: true, transition: type,
                diagnostics, sceneId })
            : this.failure(diagnostics?.reason || "program-commit-failed", diagnostics);
    }

    release({ origin = "scheduler", reason = "no-current-authority" } = {}) {
        const previousSceneId = this.stateManager?.getProgramSceneId?.() || null;
        if (previousSceneId === null) {
            return Object.freeze({ ok: true, changed: false, reason: "already-empty" });
        }
        const record = this.stateManager?.releaseProgram?.({ source: origin, reason });
        return record
            ? Object.freeze({ ok: true, changed: true, previousSceneId })
            : this.failure("program-release-failed");
    }

    failure(reason, diagnostics = null) {
        return Object.freeze({ ok: false, changed: false, reason, diagnostics });
    }

    getTransportKind(definition) {
        if (definition?.renderer?.kind !== "source") return null;
        return this.catalog.getSources?.().find(({ id }) =>
            id === definition.renderer.sourceId)?.kind || null;
    }

    getRuntimeSceneId(target) {
        return target?.kind === "scene" ? target.id
            : this.targetResolver?.getRuntimeSceneId(target) || null;
    }
}
