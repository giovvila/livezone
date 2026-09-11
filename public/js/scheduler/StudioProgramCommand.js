import trace from "../core/RuntimeTrace.js";

export default class StudioProgramCommand {
    constructor({ stateManager, catalog, transitionCoordinator, targetResolver = null } = {}) {
        this.stateManager = stateManager;
        this.catalog = catalog;
        this.transitionCoordinator = transitionCoordinator;
        this.targetResolver = targetResolver;
        this.supportsDeferredLiveCommit = true;
    }

    async execute({ sceneId, target = null, transition = "CUT", origin = "schedule",
        initialCueSeconds = null, initialPlayback = "playing", initialEnded = false, preservePreview = false, canCommit = null, livePreroll = null, beforeCommit = null } = {}) {
        const requestedTarget = target || (sceneId
            ? Object.freeze({ kind: "scene", id: sceneId }) : null);
        const resolved = requestedTarget?.kind === "source"
            ? this.targetResolver?.resolve(requestedTarget)
            : requestedTarget?.kind === "scene"
                ? { sceneId: requestedTarget.id,
                    definition: this.catalog?.getDefinition(requestedTarget.id) }
                : null;
        sceneId = resolved?.sceneId || null;
        if (this.stateManager?.canChangeProgram?.(sceneId,
            { source: origin, reason: "scheduled-take", path: "StudioProgramCommand.execute" }) === false)
            return this.failure("autolive-program-owned");
        trace.record("program-command", "execute", { sceneId, reason: origin });
        const definition = resolved?.definition || null;
        if (!definition) return this.failure(requestedTarget?.kind === "source"
            ? "unresolved-source" : "unresolved-scene");
        if (this.transitionCoordinator?.isBusy()) return this.failure("transition-busy");
        if (this.stateManager?.getProgramSceneId() === sceneId) {
            return Object.freeze({ ok: true, changed: false,
                reason: "already-program", sceneId });
        }

        if (!preservePreview && this.stateManager?.getPreviewSceneId() !== sceneId) {
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
            canCommit,
            beforeCommit,
            programTarget: preservePreview ? sceneId : null,
            type,
            durationMs: type === "dissolve" ? 400 : 0,
            source: origin,
            reason: "scheduled-take",
            preparationContext: origin === "dominant-live" && transportKind === "hls" && livePreroll
                ? Object.freeze({ livePreroll: { ...livePreroll,
                    isSourceOnline: typeof canCommit === "function" ? canCommit : () => true } })
                : cue === null ? null : Object.freeze({
                transportCueTime: cue,
                transportInitialPlayback: initialPlayback === "paused" ? "paused" : "playing",
                transportInitialEnded: initialEnded === true
            })
        });
        const diagnostics = result || this.transitionCoordinator?.getLastTransitionResult?.() || null;
        return result
            ? Object.freeze({ ok: true, changed: true, transition: type,
                diagnostics, sceneId })
            : this.failure(diagnostics?.reason || "program-commit-failed", diagnostics);
    }

    commitPrepared({ sceneId, generation, canCommit, beforeCommit } = {}) {
        const coordinator = this.transitionCoordinator;
        const prepared = coordinator?.studioRenderer?.program?.prepared;
        if (!coordinator?.started || coordinator.isBusy() || !prepared?.ready ||
            prepared.sceneId !== sceneId || prepared.generation !== generation || !canCommit?.())
            return this.failure("entry-commit-stale");
        trace.record("program-command", "entry-commit-start", { sceneId });
        const video = prepared.renderer?.video;
        if (["error", "stalled", "ended", "destroyed"].includes(prepared.renderer?.getHealth?.().state) ||
            video && (video.readyState < 2 || video.paused || video.ended))
            return this.failure("entry-candidate-no-longer-healthy");
        // Transfer ownership before synchronous Program subscribers can observe it.
        if (beforeCommit && beforeCommit() === false) return this.failure("entry-commit-stale");
        const record = this.stateManager.setProgramScene(sceneId, {
            source: "dominant-live", reason: "autolive-entry-complete" });
        if (record) trace.record("program-command", "entry-committed", { sceneId });
        return record ? { ok: true, sceneId } : this.failure("entry-commit-rejected");
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
