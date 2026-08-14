export default class StudioTransitionCoordinator {

    constructor({ studioStateManager, studioRenderer } = {}) {
        if (!studioStateManager || !studioRenderer) {
            throw new TypeError(
                "StudioTransitionCoordinator requires state and renderer dependencies."
            );
        }

        this.studioStateManager = studioStateManager;
        this.studioRenderer = studioRenderer;
        this.listeners = new Set();
        this.snapshot = this.createIdleSnapshot();
        this.started = false;
        this.busy = false;
        this.generation = 0;
    }

    start() {
        if (this.started) {
            return;
        }

        this.started = true;
    }

    destroy() {
        if (!this.started) {
            return;
        }

        const generation = this.generation;

        this.started = false;
        this.busy = false;
        this.generation += 1;
        this.studioRenderer.discardPreparedProgram({ generation });
        this.studioRenderer.cancelProgramTransition({ generation });
        this.snapshot = this.createIdleSnapshot();
        this.listeners.clear();
    }

    cut(options = {}) {
        return this.transition({
            ...options,
            type: "cut",
            durationMs: 0
        });
    }

    dissolve(options = {}) {
        return this.transition({
            ...options,
            type: "dissolve",
            durationMs: options.durationMs ?? 400
        });
    }

    async transition({
        type = "cut",
        durationMs,
        source = null,
        reason = null
    } = {}) {
        const normalizedDuration = type === "cut"
            ? 0
            : durationMs ?? 400;
        const supported = type === "cut"
            ? durationMs === undefined || durationMs === 0
            : type === "dissolve" &&
                Number.isFinite(normalizedDuration) &&
                normalizedDuration >= 200 && normalizedDuration <= 1500;

        if (!this.started || this.busy || !supported) {
            return null;
        }

        const fromSceneId = this.studioStateManager.getProgramSceneId();
        const toSceneId = this.studioStateManager.getPreviewSceneId();

        if (!toSceneId || !this.studioStateManager.getScene(toSceneId) ||
            toSceneId === fromSceneId) {
            return null;
        }

        const generation = ++this.generation;

        this.busy = true;
        this.setSnapshot(Object.freeze({
            state: "running",
            type,
            fromSceneId,
            toSceneId,
            startedAt: new Date().toISOString(),
            durationMs: normalizedDuration
        }));

        try {
            const prepared = await this.studioRenderer.prepareProgramScene(
                toSceneId,
                {
                    generation,
                    type,
                    durationMs: normalizedDuration
                }
            );

            if (!this.isCurrent(generation) || !prepared) {
                this.studioRenderer.discardPreparedProgram({ generation });
                return null;
            }

            if (this.studioStateManager.getPreviewSceneId() !== toSceneId) {
                this.studioRenderer.discardPreparedProgram({ generation });
                return null;
            }

            const record = this.studioStateManager.take({ source, reason });

            if (!record || this.studioStateManager.getProgramSceneId() !== toSceneId) {
                this.studioRenderer.discardPreparedProgram({ generation });
                return null;
            }

            const completed = await this.studioRenderer
                .waitForProgramTransition({ toSceneId, generation });

            if (!completed || !this.isCurrent(generation)) {
                return null;
            }

            return Object.freeze({
                type,
                fromSceneId,
                toSceneId,
                timestamp: record.timestamp
            });
        }
        catch {
            this.studioRenderer.discardPreparedProgram({ generation });
            this.studioRenderer.cancelProgramTransition({ generation });
            return null;
        }
        finally {
            if (this.isCurrent(generation)) {
                this.busy = false;
                this.setSnapshot(this.createIdleSnapshot());
            }
        }
    }

    getSnapshot() {
        return this.snapshot;
    }

    isBusy() {
        return this.busy;
    }

    subscribe(listener) {
        if (typeof listener !== "function") {
            return () => {};
        }

        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    setSnapshot(snapshot) {
        this.snapshot = snapshot;
        this.listeners.forEach((listener) => listener(snapshot));
    }

    createIdleSnapshot() {
        return Object.freeze({
            state: "idle",
            type: null,
            fromSceneId: null,
            toSceneId: null,
            startedAt: null,
            durationMs: 0
        });
    }

    isCurrent(generation) {
        return this.started && this.generation === generation;
    }
}
