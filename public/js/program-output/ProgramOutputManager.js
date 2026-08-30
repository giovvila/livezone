import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import { validateProgramOutputSnapshot } from "./ProgramOutputContract.js";

export default class ProgramOutputManager {
    constructor({ stateManager, catalog, sourceManager, renderer,
        graphicsManager, transitionCoordinator, transport, now = () => Date.now() }) {
        Object.assign(this, { stateManager, catalog, sourceManager, renderer,
            graphicsManager, transitionCoordinator, transport, now });
        this.revision = 0;
        this.snapshot = null;
        this.started = false;
        this.programTransport = null;
        this.lastTransportSignature = null;
        this.publisherSessionId = globalThis.crypto?.randomUUID?.() ||
            `session-${this.now()}-${Math.random().toString(36).slice(2)}`;
        this.handleProgramChanged = this.handleProgramChanged.bind(this);
        this.handleGraphicsChanged = this.handleGraphicsChanged.bind(this);
        this.handleCatalogChanged = this.handleCatalogChanged.bind(this);
        this.handleProgramTransport = this.handleProgramTransport.bind(this);
    }

    start() {
        if (this.started) return;
        this.transport.start();
        EventBus.on(Events.STUDIO_PROGRAM_CHANGED, this.handleProgramChanged);
        this.unsubscribeGraphics = this.graphicsManager.subscribe(
            "program", this.handleGraphicsChanged
        );
        this.unsubscribeCatalog = this.catalog.subscribe?.(this.handleCatalogChanged) || null;
        this.unsubscribeTransport = this.renderer.subscribeProgramTransport(
            this.handleProgramTransport
        );
        this.started = true;
        this.publish("startup");
    }

    destroy() {
        if (!this.started) return;
        EventBus.off(Events.STUDIO_PROGRAM_CHANGED, this.handleProgramChanged);
        this.unsubscribeGraphics?.();
        this.unsubscribeCatalog?.();
        this.unsubscribeTransport?.();
        this.transport.destroy();
        this.started = false;
    }

    handleProgramChanged() {
        this.programTransport = this.renderer.getProgramTransport();
        this.lastTransportSignature = this.transportSignature(this.programTransport);
        this.publish("program");
    }

    handleGraphicsChanged() {
        if (this.started) this.publish("graphics");
    }

    handleCatalogChanged() {
        if (!this.started || !this.snapshot?.scene) return;
        const definition = this.catalog.getDefinition(this.snapshot.scene.id);
        const source = definition ? this.createSource(definition) : null;
        if (source && JSON.stringify(source) !== JSON.stringify(this.snapshot.source)) {
            this.publish("source");
        }
    }

    handleProgramTransport(snapshot) {
        this.programTransport = snapshot;
        const signature = this.transportSignature(snapshot);
        if (this.started && signature !== this.lastTransportSignature) {
            this.lastTransportSignature = signature;
            if (this.isPendingProgramSource(snapshot)) return;
            this.publish("playback");
        }
    }

    isPendingProgramSource(transport) {
        if (!transport?.sourceId || transport.sourceId === this.snapshot?.source?.id) {
            return false;
        }
        const sceneId = this.stateManager.getProgramSceneId();
        const definition = sceneId ? this.catalog.getDefinition(sceneId) : null;
        const source = definition ? this.createSource(definition) : null;
        return source?.id === transport.sourceId;
    }

    publish(reason) {
        const sceneId = this.stateManager.getProgramSceneId();
        if (!sceneId) return this.publishEmpty(reason);
        const scene = this.stateManager.getScene(sceneId);
        const definition = this.catalog.getDefinition(sceneId);
        if (!scene || !definition) return null;
        const source = this.createSource(definition);
        if (!source) return null;
        const nowIso = new Date(this.now()).toISOString();
        const transition = this.createTransition(reason);
        const playback = ["graphics", "source"].includes(reason) && this.snapshot &&
            this.snapshot.scene.id === scene.id &&
            this.snapshot.source.id === source.id
            ? this.snapshot.playback
            : this.createPlayback(source.kind, nowIso);
        const snapshot = validateProgramOutputSnapshot({
            version: 1,
            revision: ++this.revision,
            publisherSessionId: this.publisherSessionId,
            publishedAt: nowIso,
            committedAt: reason === "program" || !this.snapshot
                ? nowIso : this.snapshot.committedAt,
            scene,
            source,
            playback,
            graphics: this.createGraphics(),
            transition
        });
        if (!snapshot) return null;
        this.snapshot = snapshot;
        this.transport.publish(snapshot);
        return snapshot;
    }

    publishEmpty(reason) {
        const nowIso = new Date(this.now()).toISOString();
        const snapshot = validateProgramOutputSnapshot({
            version: 1,
            revision: ++this.revision,
            publisherSessionId: this.publisherSessionId,
            publishedAt: nowIso,
            committedAt: reason === "program" || !this.snapshot
                ? nowIso : this.snapshot.committedAt,
            scene: null,
            source: null,
            playback: { initialTime: 0, duration: null, playing: false,
                ended: false, state: "ready", startedAt: nowIso },
            graphics: { items: [] },
            transition: { type: "cut", durationMs: 0 }
        });
        if (!snapshot) return null;
        this.snapshot = snapshot;
        this.transport.publish(snapshot);
        return snapshot;
    }

    createSource(definition) {
        if (definition.renderer.kind === "slate") {
            return { id: definition.id, kind: "break",
                title: definition.renderer.title, message: definition.renderer.message,
                logoUrl: definition.renderer.logo };
        }
        const source = this.sourceManager.getSource(definition.renderer.sourceId);
        if (!source) return null;
        if (source.kind === "audio") return {
            id: source.id, kind: source.kind,
            audioUrl: source.audioUrl,
            ...(source.stillUrl ? { stillUrl: source.stillUrl } : {}),
            ...(source.motionUrl ? { motionUrl: source.motionUrl } : {})
        };
        return { id: source.id, kind: source.kind, url: source.url };
    }

    createPlayback(kind, nowIso) {
        const transport = this.programTransport;
        if (!["media", "audio"].includes(kind) || !transport) {
            return { initialTime: 0, duration: null, playing: kind === "hls",
                ended: false, state: kind === "hls" ? "playing" : "ready",
                startedAt: nowIso };
        }
        const playing = transport.state === "playing" && !transport.ended;
        return {
            initialTime: Number.isFinite(transport.currentTime)
                ? Math.max(0, transport.currentTime) : 0,
            duration: Number.isFinite(transport.duration)
                ? Math.max(0, transport.duration) : null,
            playing,
            ended: Boolean(transport.ended),
            state: ["playing", "paused", "ended", "error"].includes(transport.state)
                ? transport.state : "ready",
            startedAt: nowIso
        };
    }

    createGraphics() {
        const items = this.graphicsManager.getVisibleGraphics("program")
            .map(({ graphic, payload }) => graphic.kind === "image"
                ? { id: graphic.id, kind: graphic.kind,
                    position: payload?.position || graphic.position,
                    url: payload?.asset || graphic.asset }
                : payload ? { id: graphic.id, kind: graphic.kind,
                    position: graphic.position, title: payload.title,
                    subtitle: payload.subtitle || "" } : null)
            .filter(Boolean);
        return { items };
    }

    createTransition(reason) {
        if (reason !== "program") return { type: "cut", durationMs: 0 };
        const active = this.transitionCoordinator.getSnapshot();
        return active.state === "running" && active.type === "dissolve"
            ? { type: "dissolve", durationMs: 400 }
            : { type: "cut", durationMs: 0 };
    }

    transportSignature(value) {
        return value ? `${value.sourceId}|${value.state}|${value.ended}` : "none";
    }
}
