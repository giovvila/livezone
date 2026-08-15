import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import StudioSlateSurface from "./renderers/StudioSlateSurface.js";
import StudioGraphicsLayer from "./renderers/StudioGraphicsLayer.js";

const PROGRAM_READINESS_TIMEOUT_MS = 12000;

export default class StudioRenderer {

    constructor({
        previewRoot,
        programRoot,
        studioStateManager,
        definitionRegistry,
        studioSourceManager,
        studioGraphicsManager
    }) {
        this.studioStateManager = studioStateManager;
        this.definitionRegistry = definitionRegistry;
        this.studioSourceManager = studioSourceManager;
        this.studioGraphicsManager = studioGraphicsManager;
        this.started = false;
        this.previewTransportListeners = new Set();
        this.previewTransportSnapshot = null;
        this.preview = this.createSlot(
            previewRoot,
            "No Preview selected",
            "preview"
        );
        this.program = this.createSlot(
            programRoot,
            "No Program selected",
            "program"
        );
        this.renderPreviewFromState = this.renderPreviewFromState.bind(this);
        this.renderProgramFromState = this.renderProgramFromState.bind(this);
    }

    start() {
        if (this.started) {
            return;
        }

        if (!this.preview.root || !this.program.root) {
            return;
        }

        EventBus.on(Events.STUDIO_PREVIEW_CHANGED, this.renderPreviewFromState);
        EventBus.on(Events.STUDIO_PROGRAM_CHANGED, this.renderProgramFromState);
        this.startGraphicsLayer(this.preview);
        this.startGraphicsLayer(this.program);
        this.started = true;
        this.renderPreviewFromState();
        this.renderProgramFromState();
    }

    destroy() {
        if (!this.started) {
            return;
        }

        EventBus.off(Events.STUDIO_PREVIEW_CHANGED, this.renderPreviewFromState);
        EventBus.off(Events.STUDIO_PROGRAM_CHANGED, this.renderProgramFromState);
        this.discardPreparedProgram();
        this.cancelProgramTransition();
        this.clearSlot(this.preview);
        this.clearSlot(this.program);
        this.preview.graphicsLayer?.destroy();
        this.program.graphicsLayer?.destroy();
        this.preview.graphicsLayer = null;
        this.program.graphicsLayer = null;
        this.preview.root.replaceChildren();
        this.program.root.replaceChildren();
        this.previewTransportListeners.clear();
        this.previewTransportSnapshot = null;
        this.started = false;
    }

    renderPreviewFromState() {
        this.renderSlot(
            this.preview,
            this.studioStateManager.getPreviewSceneId()
        );
    }

    renderProgramFromState(record = null) {
        const sceneId = this.studioStateManager.getProgramSceneId();

        if (this.program.prepared?.sceneId === sceneId &&
            this.program.prepared.ready) {
            this.activatePreparedProgram({
                sceneId,
                generation: this.program.prepared.generation,
                type: this.program.prepared.type,
                durationMs: this.program.prepared.durationMs
            });
            return;
        }

        this.discardPreparedProgram();
        this.cancelProgramTransition();
        this.renderSlot(this.program, sceneId);
    }

    async prepareProgramScene(
        sceneId,
        {
            generation,
            type = "cut",
            durationMs = 0,
            preparationContext = null
        } = {}
    ) {
        if (!this.started || !sceneId || generation === undefined ||
            !this.program.baseRoot) {
            return null;
        }

        this.discardPreparedProgram();

        const definition = this.definitionRegistry.getDefinition(sceneId);

        if (!definition) {
            return null;
        }

        const root = document.createElement("div");
        const renderer = this.createRenderer(
            definition,
            this.program,
            preparationContext
        );

        if (!renderer) {
            return null;
        }

        root.className = "studio-render-content";
        root.hidden = true;

        const prepared = {
            sceneId,
            generation,
            type,
            durationMs,
            ready: false,
            root,
            renderer
        };

        this.program.prepared = prepared;
        this.program.baseRoot.appendChild(root);

        try {
            await renderer.start(root);
            await renderer.waitUntilReady({
                timeoutMs: PROGRAM_READINESS_TIMEOUT_MS
            });
        }
        catch (error) {
            if (this.program.prepared === prepared) {
                this.discardPreparedProgram({ generation });
            }
            else {
                root.remove();
            }

            throw error;
        }

        if (!this.started || this.program.prepared !== prepared) {
            root.remove();
            return null;
        }

        prepared.ready = true;

        return Object.freeze({ sceneId, generation });
    }

    activatePreparedProgram({
        sceneId,
        generation,
        type = "cut",
        durationMs = 0
    } = {}) {
        const prepared = this.program.prepared;

        if (!prepared || prepared.sceneId !== sceneId ||
            prepared.generation !== generation) {
            return false;
        }

        const outgoingRenderer = this.program.renderer;
        const outgoingRoot = this.program.contentRoot ||
            this.program.baseRoot.firstElementChild;

        this.program.generation += 1;
        this.program.prepared = null;
        this.program.renderer = prepared.renderer;
        this.program.contentRoot = prepared.root;
        prepared.root.hidden = false;

        if (type !== "dissolve" || !outgoingRoot || durationMs <= 0) {
            this.program.baseRoot.replaceChildren(prepared.root);
            this.releaseRenderer(outgoingRenderer);
            this.program.activation = {
                sceneId,
                generation,
                promise: Promise.resolve(true)
            };
            return true;
        }

        const transition = this.createProgramTransition({
            sceneId,
            generation,
            durationMs,
            outgoingRenderer,
            outgoingRoot,
            incomingRenderer: prepared.renderer,
            incomingRoot: prepared.root
        });

        this.program.transition = transition;
        this.program.activation = {
            sceneId,
            generation,
            promise: transition.promise
        };
        this.startProgramDissolve(transition);
        return true;
    }

    async waitForProgramTransition({ toSceneId, generation } = {}) {
        const activation = this.program.activation;

        if (!activation || activation.sceneId !== toSceneId ||
            activation.generation !== generation) {
            return false;
        }

        const result = await activation.promise;

        if (this.program.activation === activation) {
            this.program.activation = null;
        }

        return result;
    }

    cancelProgramTransition({ generation } = {}) {
        const transition = this.program.transition;

        if (!transition || (generation !== undefined &&
            transition.generation !== generation)) {
            return false;
        }

        this.finishProgramTransition(transition);
        return true;
    }

    createProgramTransition({
        sceneId,
        generation,
        durationMs,
        outgoingRenderer,
        outgoingRoot,
        incomingRenderer,
        incomingRoot
    }) {
        let resolve;
        const promise = new Promise((settle) => {
            resolve = settle;
        });

        return {
            sceneId,
            generation,
            durationMs,
            outgoingRenderer,
            outgoingRoot,
            incomingRenderer,
            incomingRoot,
            animations: [],
            settled: false,
            resolve,
            promise
        };
    }

    startProgramDissolve(transition) {
        const {
            outgoingRoot,
            incomingRoot,
            durationMs
        } = transition;

        outgoingRoot.classList.add("studio-program-base-layer");
        incomingRoot.classList.add("studio-program-base-layer");
        outgoingRoot.style.opacity = "1";
        incomingRoot.style.opacity = "0";

        if (typeof outgoingRoot.animate !== "function" ||
            typeof incomingRoot.animate !== "function") {
            this.finishProgramTransition(transition);
            return;
        }

        try {
            transition.animations.push(outgoingRoot.animate(
                [{ opacity: 1 }, { opacity: 0 }],
                { duration: durationMs, easing: "linear", fill: "forwards" }
            ));
            transition.animations.push(incomingRoot.animate(
                [{ opacity: 0 }, { opacity: 1 }],
                { duration: durationMs, easing: "linear", fill: "forwards" }
            ));

            Promise.all(transition.animations.map((animation) =>
                animation.finished
            )).then(
                () => this.finishProgramTransition(transition),
                () => this.finishProgramTransition(transition)
            );
        }
        catch {
            this.finishProgramTransition(transition);
        }
    }

    finishProgramTransition(transition) {
        if (!transition || transition.settled) {
            return;
        }

        transition.settled = true;
        transition.animations.forEach((animation) => {
            try {
                animation.cancel();
            }
            catch {
                // Promotion remains the deterministic fallback.
            }
        });
        transition.incomingRoot.style.opacity = "";
        transition.incomingRoot.classList.remove("studio-program-base-layer");
        transition.outgoingRoot.style.opacity = "";
        transition.outgoingRoot.classList.remove("studio-program-base-layer");
        this.program.baseRoot.replaceChildren(transition.incomingRoot);
        this.releaseRenderer(transition.outgoingRenderer);

        if (this.program.transition === transition) {
            this.program.transition = null;
        }

        transition.resolve(true);
    }

    discardPreparedProgram({ generation } = {}) {
        const prepared = this.program.prepared;

        if (!prepared || (generation !== undefined &&
            prepared.generation !== generation)) {
            return false;
        }

        this.program.prepared = null;
        this.releaseRenderer(prepared.renderer);
        prepared.root.remove();
        return true;
    }

    async renderSlot(slot, sceneId) {
        const generation = ++slot.generation;
        const outgoing = slot.renderer;

        slot.sceneId = sceneId;
        this.setSlotRenderer(slot, null);
        this.releaseRenderer(outgoing);
        slot.contentRoot = null;
        slot.baseRoot.replaceChildren();

        if (!sceneId) {
            this.showState(slot.baseRoot, slot.emptyMessage, "empty");
            return;
        }

        const definition = this.definitionRegistry.getDefinition(sceneId);

        if (!definition) {
            this.showState(slot.baseRoot, "Scene definition unavailable", "error");
            return;
        }

        const content = document.createElement("div");
        content.className = "studio-render-content";
        slot.contentRoot = content;
        slot.baseRoot.replaceChildren(content);

        try {
            const renderer = this.createRenderer(definition, slot);

            if (!renderer) {
                this.showState(slot.baseRoot, "Renderer unsupported", "error");
                return;
            }

            this.setSlotRenderer(slot, renderer);
            await renderer.start(content);

            if (slot.generation !== generation) {
                if (slot.renderer === renderer) {
                    this.setSlotRenderer(slot, null);
                }

                this.releaseRenderer(renderer);
            }
        }
        catch (error) {
            if (slot.generation !== generation) {
                return;
            }

            const failedRenderer = slot.renderer;
            this.setSlotRenderer(slot, null);
            this.releaseRenderer(failedRenderer);
            slot.contentRoot = null;
            this.showState(
                slot.baseRoot,
                error?.message === "Renderer unsupported"
                    ? "Renderer unsupported"
                    : "Live source unavailable",
                "error"
            );
        }
    }

    createRenderer(definition, slot, preparationContext = null) {
        if (definition.renderer.kind === "slate") {
            return new StudioSlateSurface(definition);
        }

        if (definition.renderer.kind === "source") {
            return this.studioSourceManager.createInstance(
                definition.renderer.sourceId,
                {
                    consumer: slot.consumer,
                    initialTime: preparationContext?.mediaCueTime
                }
            );
        }

        return null;
    }

    clearSlot(slot) {
        slot.generation += 1;
        if (slot === this.program) {
            this.cancelProgramTransition();
        }
        const renderer = slot.renderer;
        this.setSlotRenderer(slot, null);
        this.releaseRenderer(renderer);
        slot.contentRoot = null;
        slot.baseRoot?.replaceChildren();
    }

    showState(root, message, variant) {
        const state = document.createElement("div");
        state.className = `studio-render-state studio-render-state--${variant}`;
        state.textContent = message;
        root.replaceChildren(state);
    }

    releaseRenderer(renderer) {
        if (!renderer) {
            return;
        }

        if (!this.studioSourceManager.destroyInstance(renderer)) {
            renderer.destroy();
        }
    }

    subscribePreviewMediaTransport(listener) {
        if (typeof listener !== "function") {
            return () => {};
        }

        this.previewTransportListeners.add(listener);
        listener(this.previewTransportSnapshot);

        return () => {
            this.previewTransportListeners.delete(listener);
        };
    }

    getPreviewPreparationContext(sceneId) {
        if (!sceneId ||
            this.studioStateManager.getPreviewSceneId() !== sceneId ||
            this.preview.sceneId !== sceneId) {
            return null;
        }

        const renderer = this.getPreviewMediaRenderer();
        const snapshot = renderer?.getTransport();

        if (!snapshot || snapshot.consumer !== "preview") {
            return null;
        }

        const mediaCueTime = Number.isFinite(snapshot.currentTime) &&
            snapshot.currentTime >= 0
            ? snapshot.currentTime
            : 0;

        return Object.freeze({ mediaCueTime });
    }

    playPreviewMedia() {
        const renderer = this.getPreviewMediaRenderer();
        return renderer ? renderer.play() : Promise.resolve(false);
    }

    pausePreviewMedia() {
        const renderer = this.getPreviewMediaRenderer();
        return renderer ? renderer.pause() : false;
    }

    restartPreviewMedia() {
        const renderer = this.getPreviewMediaRenderer();
        return renderer ? renderer.restart() : false;
    }

    getPreviewMediaRenderer() {
        const renderer = this.preview.renderer;

        return renderer && typeof renderer.getTransport === "function" &&
            typeof renderer.subscribeTransport === "function" &&
            typeof renderer.play === "function" &&
            typeof renderer.pause === "function" &&
            typeof renderer.restart === "function"
            ? renderer
            : null;
    }

    setSlotRenderer(slot, renderer) {
        if (slot === this.preview) {
            slot.transportUnsubscribe?.();
            slot.transportUnsubscribe = null;
        }

        slot.renderer = renderer;

        if (slot !== this.preview) {
            return;
        }

        const mediaRenderer = this.getPreviewMediaRenderer();

        if (!mediaRenderer) {
            this.setPreviewTransportSnapshot(null);
            return;
        }

        slot.transportUnsubscribe = mediaRenderer.subscribeTransport(
            (snapshot) => {
                if (this.preview.renderer === mediaRenderer) {
                    this.setPreviewTransportSnapshot(snapshot);
                }
            }
        );
    }

    setPreviewTransportSnapshot(snapshot) {
        this.previewTransportSnapshot = snapshot;
        this.previewTransportListeners.forEach((listener) => {
            listener(snapshot);
        });
    }

    createSlot(root, emptyMessage, consumer) {
        return {
            root,
            emptyMessage,
            consumer,
            sceneId: null,
            generation: 0,
            renderer: null,
            contentRoot: null,
            baseRoot: null,
            graphicsRoot: null,
            graphicsLayer: null,
            prepared: null,
            transition: null,
            activation: null,
            transportUnsubscribe: null
        };
    }

    startGraphicsLayer(slot) {
        const composition = document.createElement("div");
        const baseRoot = document.createElement("div");
        const graphicsRoot = document.createElement("div");

        composition.className = "studio-composition";
        baseRoot.className = "studio-composition__base";
        graphicsRoot.className = "studio-composition__graphics";
        composition.append(baseRoot, graphicsRoot);
        slot.root.replaceChildren(composition);
        slot.baseRoot = baseRoot;
        slot.graphicsRoot = graphicsRoot;
        slot.graphicsLayer = new StudioGraphicsLayer({
            root: graphicsRoot,
            consumer: slot.consumer,
            graphicsManager: this.studioGraphicsManager
        });
        slot.graphicsLayer.start();
    }
}
