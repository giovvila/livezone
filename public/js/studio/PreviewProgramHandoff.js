import trace from "../core/RuntimeTrace.js";

// A reservation borrows Preview until the synchronous state commit. It never
// owns or destroys the surface; ownership changes only after revalidation.
export default class PreviewProgramHandoff {
    static reserve(renderer, sceneId, options) {
        const slot = renderer.preview;
        const surface = slot.renderer;
        const definition = renderer.definitionRegistry.getDefinition(sceneId);
        const primary = surface?.video || surface?.audio;
        if (!slot.contentRoot || slot.sceneId !== sceneId || !surface || surface.destroyed ||
            (surface.sourceId && definition?.renderer?.sourceId !== surface.sourceId) ||
            (surface.sourceId && surface.consumer !== "preview") ||
            (surface.sourceId && surface.readinessState !== "ready") ||
            ["error", "stalled", "ended", "destroyed"].includes(surface.getHealth?.()?.state) ||
            (primary && (primary.readyState < 2 || primary.seeking || primary.ended))) return null;
        return new PreviewProgramHandoff(renderer, sceneId, options);
    }

    constructor(renderer, sceneId, options) {
        this.owner = renderer;
        this.previewGeneration = renderer.preview.generation;
        this.surface = renderer.preview.renderer;
        this.root = renderer.preview.contentRoot;
        this.initialPlayback = this.surface.initialPlayback;
        this.prepared = { ...options, sceneId, renderer: this.surface, root: this.root,
            ready: true, preserveConnectedRoot: true, handoff: this };
    }

    stage() {
        const r = this.owner;
        if (r.preview.renderer !== this.surface || r.preview.contentRoot !== this.root ||
            r.preview.generation !== this.previewGeneration ||
            r.studioStateManager.getPreviewSceneId() !== this.prepared.sceneId ||
            !PreviewProgramHandoff.reserve(r, this.prepared.sceneId, {})) return false;
        this.staged = true;
        try {
            r.program.baseRoot.appendChild(this.root);
            if (this.surface.sourceId && !r.studioSourceManager.transferInstanceConsumer(
                this.surface, "preview", "program")) throw new Error("handoff-owner-invalid");
            this.surface.consumer = "program";
            this.surface.initialPlayback = "playing";
            r.setSlotRenderer(r.preview, null);
            r.preview.contentRoot = null;
            r.preview.sceneId = null;
            ++r.preview.generation;
            r.previewProgramHandoff = this;
            trace.record("preview-handoff", "ownership-transferred", {
                sceneId: this.prepared.sceneId, generation: this.prepared.generation,
                instanceId: this.surface.instanceId, sourceId: this.surface.sourceId,
                consumer: this.surface.consumer,
                currentTime: (this.surface.video || this.surface.audio)?.currentTime });
            return true;
        } catch {
            this.rollback();
            return false;
        }
    }

    rollback() {
        if (!this.staged || this.committed) return;
        const r = this.owner;
        if (this.surface.sourceId) r.studioSourceManager.transferInstanceConsumer(
            this.surface, "program", "preview");
        this.surface.consumer = "preview";
        this.surface.initialPlayback = this.initialPlayback;
        r.preview.baseRoot.appendChild(this.root);
        r.preview.contentRoot = this.root;
        r.preview.sceneId = this.prepared.sceneId;
        r.preview.generation = this.previewGeneration;
        r.setSlotRenderer(r.preview, this.surface);
        if (r.previewProgramHandoff === this) r.previewProgramHandoff = null;
        this.staged = false;
    }
}
