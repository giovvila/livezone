import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import StudioHlsSurface from "./renderers/StudioHlsSurface.js";
import StudioSlateSurface from "./renderers/StudioSlateSurface.js";

export default class StudioRenderer {

    constructor({
        previewRoot,
        programRoot,
        studioStateManager,
        definitionRegistry,
        technicalConfig
    }) {
        this.studioStateManager = studioStateManager;
        this.definitionRegistry = definitionRegistry;
        this.technicalConfig = technicalConfig;
        this.started = false;
        this.preview = this.createSlot(previewRoot, "No Preview selected");
        this.program = this.createSlot(programRoot, "No Program selected");
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
        this.clearSlot(this.preview);
        this.clearSlot(this.program);
        this.started = false;
    }

    renderPreviewFromState() {
        this.renderSlot(
            this.preview,
            this.studioStateManager.getPreviewSceneId()
        );
    }

    renderProgramFromState() {
        this.renderSlot(
            this.program,
            this.studioStateManager.getProgramSceneId()
        );
    }

    async renderSlot(slot, sceneId) {
        const generation = ++slot.generation;

        slot.renderer?.destroy();
        slot.renderer = null;
        slot.root.replaceChildren();

        if (!sceneId) {
            this.showState(slot.root, slot.emptyMessage, "empty");
            return;
        }

        const definition = this.definitionRegistry.getDefinition(sceneId);

        if (!definition) {
            this.showState(slot.root, "Scene definition unavailable", "error");
            return;
        }

        const content = document.createElement("div");
        content.className = "studio-render-content";
        slot.root.replaceChildren(content);

        try {
            const renderer = this.createRenderer(definition, content, slot, generation);

            if (!renderer) {
                this.showState(slot.root, "Renderer unsupported", "error");
                return;
            }

            slot.renderer = renderer;
            await renderer.start(content);

            if (slot.generation !== generation) {
                renderer.destroy();
            }
        }
        catch (error) {
            if (slot.generation !== generation) {
                return;
            }

            slot.renderer?.destroy();
            slot.renderer = null;
            this.showState(
                slot.root,
                error?.message === "Renderer unsupported"
                    ? "Renderer unsupported"
                    : "Live source unavailable",
                "error"
            );
        }
    }

    createRenderer(definition, content, slot, generation) {
        if (definition.renderer.kind === "slate") {
            return new StudioSlateSurface(definition);
        }

        if (definition.renderer.kind === "hls") {
            const sourceUrl = this.resolveConfigRef(
                definition.renderer.source.configRef
            );

            if (!sourceUrl) {
                throw new Error("Live source unavailable");
            }

            return new StudioHlsSurface({
                sourceUrl,
                onError: () => {
                    if (slot.generation === generation) {
                        content.classList.add("studio-render-content--error");
                    }
                }
            });
        }

        return null;
    }

    resolveConfigRef(reference) {
        if (typeof reference !== "string" || !reference.trim()) {
            return null;
        }

        let value = this.technicalConfig;

        for (const key of reference.split(".")) {
            if (!key || !value || typeof value !== "object" ||
                !Object.prototype.hasOwnProperty.call(value, key)) {
                return null;
            }

            value = value[key];
        }

        return typeof value === "string" && value.trim()
            ? value.trim()
            : null;
    }

    clearSlot(slot) {
        slot.generation += 1;
        slot.renderer?.destroy();
        slot.renderer = null;
        slot.root?.replaceChildren();
    }

    showState(root, message, variant) {
        const state = document.createElement("div");
        state.className = `studio-render-state studio-render-state--${variant}`;
        state.textContent = message;
        root.replaceChildren(state);
    }

    createSlot(root, emptyMessage) {
        return {
            root,
            emptyMessage,
            generation: 0,
            renderer: null
        };
    }
}
