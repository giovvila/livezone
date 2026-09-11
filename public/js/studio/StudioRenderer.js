import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import StudioSlateSurface from "./renderers/StudioSlateSurface.js";
import StudioGraphicsLayer from "./renderers/StudioGraphicsLayer.js";
import { waitForLivePlaybackStability, LIVE_PLAYBACK_PROGRESS_GAP_MS } from "./LivePlaybackStability.js";
import trace from "../core/RuntimeTrace.js";
import PreviewProgramHandoff from "./PreviewProgramHandoff.js";

const PROGRAM_READINESS_TIMEOUT_MS = 12000;

export default class StudioRenderer {

    constructor({
        previewRoot,
        programRoot,
        studioStateManager,
        definitionRegistry,
        studioSourceManager,
        studioGraphicsManager,
        initialProgramContext = null
    }) {
        this.studioStateManager = studioStateManager;
        this.definitionRegistry = definitionRegistry;
        this.studioSourceManager = studioSourceManager;
        this.studioGraphicsManager = studioGraphicsManager;
        this.initialProgramContext = initialProgramContext;
        this.started = false;
        this.previewTransportListeners = new Set();
        this.programTransportListeners = new Set();
        this.previewTransportSnapshot = null;
        this.programTransportSnapshot = null;
        this.previewHandoff = null;
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
        this.previewProgramHandoff = null;
        this.clearSlot(this.preview);
        this.clearSlot(this.program);
        this.preview.graphicsLayer?.destroy();
        this.program.graphicsLayer?.destroy();
        this.preview.graphicsLayer = null;
        this.program.graphicsLayer = null;
        this.preview.root.replaceChildren();
        this.program.root.replaceChildren();
        this.previewTransportListeners.clear();
        this.programTransportListeners.clear();
        this.previewTransportSnapshot = null;
        this.programTransportSnapshot = null;
        this.previewHandoff = null;
        this.started = false;
    }

    renderPreviewFromState() {
        if (this.previewProgramHandoff) return;
        const sceneId = this.studioStateManager.getPreviewSceneId();
        const preparationContext = this.consumePreviewHandoff(sceneId);

        this.renderSlot(this.preview, sceneId, preparationContext);
    }

    renderProgramFromState(record = null) {
        const sceneId = this.studioStateManager.getProgramSceneId();
        const initialContext = this.initialProgramContext;
        this.initialProgramContext = null;

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
        this.renderSlot(this.program, sceneId, !record && initialContext?.sceneId === sceneId
            ? initialContext : null);
    }

    async prepareProgramScene(
        sceneId,
        {
            generation,
            type = "cut",
            durationMs = 0,
            preparationContext = null,
            reusePreview = false
        } = {}
    ) {
        if (!this.started || !sceneId || generation === undefined ||
            !this.program.baseRoot) {
            return null;
        }

        this.discardPreparedProgram();

        if (reusePreview) {
            const handoff = PreviewProgramHandoff.reserve(this, sceneId, { generation, type, durationMs });
            if (handoff) {
                this.program.prepared = handoff.prepared;
                return Object.freeze({ sceneId, generation });
            }
        }

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
        const preroll = preparationContext?.livePreroll;
        root.hidden = !preroll;
        if (preroll) Object.assign(root.style, { position: "absolute", inset: "0",
            opacity: ".001", pointerEvents: "none" });

        const prepared = {
            sceneId,
            generation,
            type,
            durationMs,
            ready: false,
            preserveConnectedRoot: Boolean(preroll),
            root,
            renderer
        };

        this.program.prepared = prepared;
        this.program.baseRoot.appendChild(root);

        try {
            if (preroll) {
                if (renderer.sourceId !== preroll.sourceId ||
                    this.studioSourceManager.getSource(preroll.sourceId)?.kind !== "hls") {
                    const error = new Error("preroll-source-mismatch"); error.code = "preroll-source-mismatch"; throw error;
                }
                const startedAt = Date.now();
                trace.record("preroll", "surface-created", { sourceId: preroll.sourceId, generation });
                const starting = renderer.start(root);
                const ready = renderer.waitUntilReady({ timeoutMs: PROGRAM_READINESS_TIMEOUT_MS });
                const video = renderer.video;
                const mediaEvents = ["loadedmetadata", "loadeddata", "canplay", "seeked", "waiting", "error"];
                const observe = event => trace.record("normal-take", event.type, {
                    sceneId, generation, sourceId: renderer.sourceId, currentTime: video?.currentTime,
                    duration: video?.duration, readyState: video?.readyState, networkState: video?.networkState });
                mediaEvents.forEach(name => video?.addEventListener(name, observe));
                // Startup may have a pending native play promise. Media readiness
                // remains the bounded authority, while setup rejection is observed.
                try { await Promise.race([ready, Promise.resolve(starting).then(() => ready)]); }
                finally { mediaEvents.forEach(name => video?.removeEventListener(name, observe)); }
                trace.record("preroll", "first-frame", { sourceId: preroll.sourceId, generation });
                await waitForLivePlaybackStability(renderer, { ...preroll,
                    // A late but valid first frame must still receive a complete
                    // stability window plus the existing permitted progress-event gap.
                    // Early candidates retain their existing 12s overall bound.
                    timeoutMs: preroll.entryGate ? null : Math.max(PROGRAM_READINESS_TIMEOUT_MS - (Date.now() - startedAt),
                        preroll.windowMs + LIVE_PLAYBACK_PROGRESS_GAP_MS) });
            } else {
                const preparationStartedAt = Date.now();
                renderer.beginProgramPreparation?.();
                const recordMedia = (event, surface) => {
                    const video = surface?.video || surface?.audio;
                    const instances = this.studioSourceManager.getActiveInstances?.() || [];
                    trace.record("normal-take", event, { sceneId, generation,
                        sourceId: surface?.sourceId, instanceId: surface?.instanceId,
                        consumer: surface?.consumer, currentTime: video?.currentTime, duration: video?.duration,
                        readyState: video?.readyState, networkState: video?.networkState,
                        paused: video?.paused, ended: video?.ended, seeking: video?.seeking,
                        videoWidth: video?.videoWidth, videoHeight: video?.videoHeight,
                        state: surface?.readinessState,
                        videoElements: instances.reduce((count, item) => count + Number(Boolean(item.video)) + Number(Boolean(item.motion)), 0),
                        audioElements: instances.filter(item => item.audio).length,
                        pendingAudioPlays: surface?.pendingAudioPlays || 0,
                        pendingMotionPlay: Boolean(surface?.motionPlayPending),
                        motionDeferred: Boolean(surface?.preparingProgram && surface?.motion),
                        endpointMatch: (surface?.sourceUrl || surface?.audioUrl) ===
                            (this.preview.renderer?.sourceUrl || this.preview.renderer?.audioUrl) });
                    if (surface?.motion) {
                        trace.record("normal-take", `${event}-motion`, {
                        sourceId: surface.sourceId, instanceId: `${surface.instanceId}-motion`, generation,
                        currentTime: surface.motion.currentTime, duration: surface.motion.duration,
                        readyState: surface.motion.readyState, networkState: surface.motion.networkState,
                        muted: surface.motion.muted, paused: surface.motion.paused,
                        loop: surface.motion.loop, seeking: surface.motion.seeking,
                        endpointMatch: surface.motionUrl === this.preview.renderer?.motionUrl,
                        pendingMotionPlay: Boolean(surface.motionPlayPending), motionDeferred: Boolean(surface.preparingProgram) });
                        for (let index = 0; index < Math.min(surface.motion.buffered?.length || 0, 8); index++)
                            trace.record("normal-take", "motion-buffered-range", { instanceId: `${surface.instanceId}-motion`,
                                rangeIndex: index, rangeStart: surface.motion.buffered.start(index), rangeEnd: surface.motion.buffered.end(index) });
                    }
                    for (let index = 0; index < Math.min(video?.buffered?.length || 0, 8); index++)
                        trace.record("normal-take", "buffered-range", { instanceId: surface.instanceId,
                            rangeIndex: index, rangeStart: video.buffered.start(index), rangeEnd: video.buffered.end(index) });
                };
                recordMedia("preview-before-prepare", this.preview.renderer);
                // play() may remain pending while the browser fetches metadata
                // or seeks. Start the readiness deadline without awaiting play.
                const starting = renderer.start(root);
                const ready = renderer.waitUntilReady({ timeoutMs: PROGRAM_READINESS_TIMEOUT_MS });
                const mediaEvents = ["loadedmetadata", "loadeddata", "canplay", "playing", "timeupdate", "seeking", "seeked", "waiting", "error"];
                const observe = event => recordMedia(event.type, renderer);
                const video = renderer.video || renderer.audio;
                mediaEvents.forEach(name => video?.addEventListener(name, observe));
                recordMedia("program-created", renderer);
                Promise.resolve(starting).then(() => recordMedia("startup-settled", renderer), () => {});
                trace.record("normal-take", "prepare-start", { sceneId, generation,
                    sourceId: renderer.sourceId, readyState: renderer.video?.readyState,
                    networkState: renderer.video?.networkState });
                try { await Promise.race([ready, Promise.resolve(starting).then(() => ready)]); }
                catch (error) {
                    trace.record("normal-take", "required-media-failed", { sourceId: renderer.sourceId,
                        instanceId: renderer.instanceId, kind: renderer.audio ? "audio" : renderer.video ? "video" : "image",
                        reason: error?.code || "preparation-failed", requestDurationMs: Date.now() - preparationStartedAt });
                    throw error;
                }
                finally { mediaEvents.forEach(name => video?.removeEventListener(name, observe)); }
                recordMedia("preview-after-prepare", this.preview.renderer);
                trace.record("normal-take", "prepare-ready", { sceneId, generation,
                    requestDurationMs: Date.now() - preparationStartedAt,
                    sourceId: renderer.sourceId, currentTime: renderer.video?.currentTime,
                    readyState: renderer.video?.readyState, networkState: renderer.video?.networkState });
            }
        }
        catch (error) {
            if (this.program.prepared === prepared) {
                this.discardPreparedProgram({ generation });
            }
            else {
                root.remove();
            }

            if (preroll && !error.code?.startsWith("preroll-")) error.code = "preroll-preparation-failed";
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

        if (prepared.handoff) {
            if (!prepared.handoff.staged) return false;
            prepared.handoff.committed = true;
        }
        this.program.generation += 1;
        this.program.prepared = null;
        this.program.sceneId = sceneId;
        this.setSlotRenderer(this.program, prepared.renderer);
        this.program.contentRoot = prepared.root;
        prepared.root.hidden = false;
        if (prepared.root.style) Object.assign(prepared.root.style, { position: "", inset: "",
            opacity: "", pointerEvents: "" });
        outgoingRenderer?.deactivateProgram?.();
        if (prepared.renderer.initialPlayback !== "paused") void prepared.renderer.activateProgram?.();

        if (type !== "dissolve" || !outgoingRoot || durationMs <= 0) {
            if (prepared.preserveConnectedRoot) {
                // The warmed video is already connected here. Do not detach and
                // reinsert it during CUT: retain its media lifecycle continuously.
                for (const child of [...this.program.baseRoot.children])
                    if (child !== prepared.root) child.remove();
            } else this.program.baseRoot.replaceChildren(prepared.root);
            trace.record("preroll", "surface-promoted", { sceneId,
                sourceId: prepared.renderer.sourceId, instanceId: prepared.renderer.instanceId });
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
        transition.previewHandoff = Boolean(prepared.handoff);
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
        if (transition.previewHandoff) {
            for (const child of [...this.program.baseRoot.children])
                if (child !== transition.incomingRoot) child.remove();
        } else this.program.baseRoot.replaceChildren(transition.incomingRoot);
        this.releaseRenderer(transition.outgoingRenderer);

        if (this.program.transition === transition) {
            this.program.transition = null;
        }

        transition.resolve(true);
    }

    stagePreparedProgram({ generation } = {}) {
        const prepared = this.program.prepared;
        return !prepared?.handoff || (prepared.generation === generation && prepared.handoff.stage());
    }

    completePreviewProgramHandoff({ generation, render = true } = {}) {
        const handoff = this.previewProgramHandoff;
        if (!handoff || handoff.prepared.generation !== generation) return;
        this.previewProgramHandoff = null;
        if (render && this.started && handoff.committed) this.renderPreviewFromState();
    }

    discardPreparedProgram({ generation } = {}) {
        const prepared = this.program.prepared;

        if (!prepared || (generation !== undefined &&
            prepared.generation !== generation)) {
            return false;
        }

        this.program.prepared = null;
        if (prepared.handoff) {
            prepared.handoff.rollback();
            return true;
        }
        this.releaseRenderer(prepared.renderer);
        prepared.root.remove();
        return true;
    }

    async renderSlot(slot, sceneId, preparationContext = null) {
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
            const renderer = this.createRenderer(
                definition,
                slot,
                preparationContext
            );

            if (!renderer) {
                this.showState(slot.baseRoot, "Renderer unsupported", "error");
                return;
            }

            this.setSlotRenderer(slot, renderer);
            await renderer.start(content);

            if (slot === this.program && preparationContext) {
                await renderer.waitUntilReady?.({ timeoutMs: PROGRAM_READINESS_TIMEOUT_MS });
            }

            if (slot === this.program && slot.generation === generation &&
                preparationContext?.transportInitialPlayback !== "paused") {
                void renderer.activateProgram?.();
            }

            if (slot.generation !== generation) {
                // Preview startup may settle after ownership was transferred.
                // Its stale continuation must not release the current Program.
                if (slot === this.preview && this.program.renderer === renderer &&
                    renderer.consumer === "program") return;
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
                    initialTime: preparationContext?.transportCueTime ??
                        preparationContext?.transportInitialTime ??
                        preparationContext?.mediaCueTime ??
                        preparationContext?.mediaInitialTime,
                    initialPlayback:
                        preparationContext?.transportInitialPlayback ??
                        preparationContext?.mediaInitialPlayback,
                    initialEnded: preparationContext?.transportInitialEnded ??
                        preparationContext?.mediaInitialEnded
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
        return this.subscribePreviewTransport(listener);
    }

    subscribePreviewTransport(listener) {
        if (typeof listener !== "function") {
            return () => {};
        }

        this.previewTransportListeners.add(listener);
        listener(this.previewTransportSnapshot);

        return () => {
            this.previewTransportListeners.delete(listener);
        };
    }

    subscribeProgramTransport(listener) {
        if (typeof listener !== "function") return () => {};
        this.programTransportListeners.add(listener);
        listener(this.programTransportSnapshot);
        return () => this.programTransportListeners.delete(listener);
    }

    getProgramTransport() {
        return this.programTransportSnapshot;
    }

    getPreviewPreparationContext(sceneId) {
        if (!sceneId ||
            this.studioStateManager.getPreviewSceneId() !== sceneId ||
            this.preview.sceneId !== sceneId) {
            return null;
        }

        const renderer = this.getPreviewTransportRenderer();
        const snapshot = renderer?.getTransport();

        if (!snapshot || snapshot.consumer !== "preview") {
            return null;
        }

        const transportCueTime = Number.isFinite(snapshot.currentTime) &&
            snapshot.currentTime >= 0
            ? snapshot.currentTime
            : 0;

        return Object.freeze({ transportCueTime });
    }

    captureProgramPreviewHandoff(sceneId, { generation } = {}) {
        this.previewHandoff = null;

        if (!sceneId || generation === undefined ||
            this.studioStateManager.getProgramSceneId() !== sceneId ||
            this.program.sceneId !== sceneId) {
            return null;
        }

        const snapshot = this.program.renderer?.getTransport?.();

        if (!snapshot || snapshot.consumer !== "program") {
            return null;
        }

        const transportDuration = Number.isFinite(snapshot.duration) &&
            snapshot.duration >= 0 ? snapshot.duration : null;
        const transportInitialEnded = snapshot.ended === true;
        const capturedTime = Number.isFinite(snapshot.currentTime) &&
            snapshot.currentTime >= 0
            ? snapshot.currentTime
            : 0;
        const transportInitialTime = transportInitialEnded &&
            transportDuration !== null
            ? transportDuration : capturedTime;
        const preparationContext = Object.freeze({
            transportInitialTime,
            transportInitialPlayback: "paused",
            transportInitialEnded
        });

        this.previewHandoff = Object.freeze({
            sceneId,
            generation,
            preparationContext
        });

        return preparationContext;
    }

    consumePreviewHandoff(sceneId) {
        const handoff = this.previewHandoff;
        this.previewHandoff = null;

        if (!handoff || handoff.sceneId !== sceneId) {
            return null;
        }

        return handoff.preparationContext;
    }

    discardPreviewHandoff({ generation } = {}) {
        const handoff = this.previewHandoff;

        if (!handoff || (generation !== undefined &&
            handoff.generation !== generation)) {
            return false;
        }

        this.previewHandoff = null;
        return true;
    }

    playPreviewMedia() {
        return this.playPreviewTransport();
    }

    playPreviewTransport() {
        const renderer = this.getPreviewTransportRenderer();
        return renderer ? renderer.play() : Promise.resolve(false);
    }

    pausePreviewMedia() {
        return this.pausePreviewTransport();
    }

    pausePreviewTransport() {
        const renderer = this.getPreviewTransportRenderer();
        return renderer ? renderer.pause() : false;
    }

    restartPreviewMedia() {
        return this.restartPreviewTransport();
    }

    restartPreviewTransport() {
        const renderer = this.getPreviewTransportRenderer();
        return renderer ? renderer.restart() : false;
    }

    getPreviewMediaRenderer() {
        return this.getPreviewTransportRenderer();
    }

    getPreviewTransportRenderer() {
        const renderer = this.preview.renderer;

        return renderer && typeof renderer.getTransport === "function" &&
            typeof renderer.subscribeTransport === "function" &&
            typeof renderer.play === "function" &&
            typeof renderer.pause === "function" &&
            typeof renderer.restart === "function"
            ? renderer
            : null;
    }

    isSceneInUse(sceneId) {
        if (!sceneId) {
            return false;
        }

        return this.preview.sceneId === sceneId ||
            this.program.sceneId === sceneId ||
            this.program.prepared?.sceneId === sceneId ||
            this.program.activation?.sceneId === sceneId;
    }

    setSlotRenderer(slot, renderer) {
        slot.transportUnsubscribe?.();
        slot.transportUnsubscribe = null;

        slot.renderer = renderer;

        const mediaRenderer = slot === this.preview
            ? this.getPreviewTransportRenderer()
            : renderer && typeof renderer.getTransport === "function" &&
                typeof renderer.subscribeTransport === "function"
                ? renderer : null;

        if (!mediaRenderer) {
            if (slot === this.preview) this.setPreviewTransportSnapshot(null);
            else this.setProgramTransportSnapshot(null);
            return;
        }

        slot.transportUnsubscribe = mediaRenderer.subscribeTransport(
            (snapshot) => {
                if (slot.renderer === mediaRenderer && slot === this.preview) {
                    this.setPreviewTransportSnapshot(snapshot);
                }
                else if (slot.renderer === mediaRenderer) {
                    this.setProgramTransportSnapshot(snapshot);
                }
            }
        );
    }

    setProgramTransportSnapshot(snapshot) {
        this.programTransportSnapshot = snapshot ? Object.freeze({ ...snapshot }) : null;
        this.programTransportListeners.forEach((listener) =>
            listener(this.programTransportSnapshot));
    }

    setPreviewTransportSnapshot(snapshot) {
        this.previewTransportSnapshot = this.createPreviewTransportSnapshot(
            snapshot
        );
        this.previewTransportListeners.forEach((listener) => {
            listener(this.previewTransportSnapshot);
        });
    }

    createPreviewTransportSnapshot(snapshot) {
        if (!snapshot) {
            return null;
        }

        const sceneId = this.preview.sceneId;
        const definition = this.definitionRegistry.getDefinition(sceneId);

        if (!definition || definition.renderer.kind !== "source" ||
            definition.renderer.sourceId !== snapshot.sourceId) {
            return null;
        }

        return Object.freeze({
            ...snapshot,
            sceneId,
            displayName: definition.name || snapshot.sourceId,
            sourceKind: this.studioSourceManager.getSource(
                snapshot.sourceId
            )?.kind || null
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
