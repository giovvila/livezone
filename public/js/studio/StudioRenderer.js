import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import StudioSlateSurface from "./renderers/StudioSlateSurface.js";
import StudioGraphicsLayer from "./renderers/StudioGraphicsLayer.js";

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
        this.clearSlot(this.preview);
        this.clearSlot(this.program);
        this.preview.graphicsLayer?.destroy();
        this.program.graphicsLayer?.destroy();
        this.preview.graphicsLayer = null;
        this.program.graphicsLayer = null;
        this.preview.root.replaceChildren();
        this.program.root.replaceChildren();
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

        if (this.program.prepared?.sceneId === sceneId) {
            this.activatePreparedProgram({
                sceneId,
                generation: this.program.prepared.generation
            });
            return;
        }

        this.discardPreparedProgram();
        this.renderSlot(this.program, sceneId);
    }

    async prepareProgramScene(sceneId, { generation } = {}) {
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
        const renderer = this.createRenderer(definition, this.program);

        if (!renderer) {
            return null;
        }

        root.className = "studio-render-content";
        root.hidden = true;

        const prepared = {
            sceneId,
            generation,
            root,
            renderer
        };

        this.program.prepared = prepared;
        this.program.baseRoot.appendChild(root);

        try {
            await renderer.start(root);
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

        return Object.freeze({ sceneId, generation });
    }

    activatePreparedProgram({ sceneId, generation } = {}) {
        const prepared = this.program.prepared;

        if (!prepared || prepared.sceneId !== sceneId ||
            prepared.generation !== generation) {
            return false;
        }

        const outgoing = this.program.renderer;

        this.program.generation += 1;
        this.program.prepared = null;
        this.program.renderer = prepared.renderer;
        prepared.root.hidden = false;
        this.program.baseRoot.replaceChildren(prepared.root);
        this.releaseRenderer(outgoing);
        return true;
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

        this.releaseRenderer(slot.renderer);
        slot.renderer = null;
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
        slot.baseRoot.replaceChildren(content);

        try {
            const renderer = this.createRenderer(definition, slot);

            if (!renderer) {
                this.showState(slot.baseRoot, "Renderer unsupported", "error");
                return;
            }

            slot.renderer = renderer;
            await renderer.start(content);

            if (slot.generation !== generation) {
                this.releaseRenderer(renderer);
            }
        }
        catch (error) {
            if (slot.generation !== generation) {
                return;
            }

            this.releaseRenderer(slot.renderer);
            slot.renderer = null;
            this.showState(
                slot.baseRoot,
                error?.message === "Renderer unsupported"
                    ? "Renderer unsupported"
                    : "Live source unavailable",
                "error"
            );
        }
    }

    createRenderer(definition, slot) {
        if (definition.renderer.kind === "slate") {
            return new StudioSlateSurface(definition);
        }

        if (definition.renderer.kind === "source") {
            return this.studioSourceManager.createInstance(
                definition.renderer.sourceId,
                { consumer: slot.consumer }
            );
        }

        return null;
    }

    clearSlot(slot) {
        slot.generation += 1;
        this.releaseRenderer(slot.renderer);
        slot.renderer = null;
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

    createSlot(root, emptyMessage, consumer) {
        return {
            root,
            emptyMessage,
            consumer,
            generation: 0,
            renderer: null,
            baseRoot: null,
            graphicsRoot: null,
            graphicsLayer: null,
            prepared: null
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
