import { AUTO_LIVE_ENTRY_ID, AUTO_LIVE_ENTRY_TITLE, AUTO_LIVE_ENTRY_MESSAGE } from "./AutoLiveEntrySlate.js";
import { AUTO_LIVE_LOSS_SLATE_ID } from "./AutoLiveLossSlate.js";
import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import { validateProgramOutputSnapshot } from "./ProgramOutputContract.js";
import trace, { programTraceFields } from "../core/RuntimeTrace.js";

export default class ProgramOutputManager {
    constructor({ stateManager, catalog, sourceManager, renderer,
        graphicsManager, transitionCoordinator, transport, initialProgramContext = null,
        now = () => Date.now() }) {
        Object.assign(this, { stateManager, catalog, sourceManager, renderer,
            graphicsManager, transitionCoordinator, transport, now });
        this.revision = 0;
        this.snapshot = null;
        this.started = false;
        this.programTransport = null;
        this.lastTransportSignature = null;
        this.pendingProgramPublishReason = null;
        this.initialProgramContext = initialProgramContext;
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
        this.publishWhenProgramReady("startup");
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
        this.autoLiveEntrySlate = null;
        this.autoLiveLossSlate = null;
        this.initialProgramContext = null;
        this.programTransport = this.renderer.getProgramTransport();
        this.lastTransportSignature = this.transportSignature(this.programTransport);
        this.publishWhenProgramReady("program");
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
            if (!this.pendingProgramPublishReason &&
                this.isPendingProgramSource(snapshot)) return;
            if (this.pendingProgramPublishReason) {
                if (!this.isProgramTransportReady(snapshot)) return;
                const reason = this.pendingProgramPublishReason || "playback";
                this.pendingProgramPublishReason = null;
                this.publish(reason);
                return;
            }
            this.publish("playback");
        }
    }

    publishWhenProgramReady(reason) {
        if (this.shouldAwaitProgramTransport()) {
            this.pendingProgramPublishReason = reason;
            return null;
        }
        this.pendingProgramPublishReason = null;
        return this.publish(reason);
    }

    shouldAwaitProgramTransport() {
        const sceneId = this.stateManager.getProgramSceneId();
        if (!sceneId) return false;
        const definition = this.catalog.getDefinition(sceneId);
        const source = definition ? this.createSource(definition) : null;
        return source && ["media", "audio"].includes(source.kind) &&
            !this.isProgramTransportReady(this.programTransport, source.id);
    }

    isProgramTransportReady(transport, expectedSourceId = null) {
        if (!transport || (expectedSourceId &&
            transport.sourceId !== expectedSourceId)) return false;
        if (transport.state === "paused" &&
            this.initialProgramContext?.transportInitialPlayback === "paused" &&
            transport.sourceId === this.initialProgramContext.sourceId) return true;
        if (transport.state === "paused" && this.renderer.program?.renderer?.initialPlayback === "paused") return true;
        return ["playing", "ended", "error"].includes(transport.state);
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
        if (this.autoLiveEntrySlate) return this.publishEntrySlate();
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
            overlays: this.createOverlays(),
            transition
        });
        if (!snapshot) {
            trace.record("program-output", "snapshot-rejected", { reason });
            return null;
        }
        this.snapshot = snapshot;
        trace.record("program-output", "publish-attempt", { ...programTraceFields(snapshot), reason });
        this.transport.publish(snapshot);
        return snapshot;
    }

    setAutoLiveEntrySlate(value) {
        if (JSON.stringify(value) === JSON.stringify(this.autoLiveEntrySlate ?? null)) return;
        this.autoLiveEntrySlate = value;
        if (this.started) this.publish("program");
    }

    publishEntrySlate() {
        const entry = this.autoLiveEntrySlate;
        const committedAt = new Date(entry.startedAt).toISOString();
        const snapshot = validateProgramOutputSnapshot({ version: 1, revision: ++this.revision,
            publisherSessionId: this.publisherSessionId, publishedAt: new Date(this.now()).toISOString(), committedAt,
            scene: { id: AUTO_LIVE_ENTRY_ID + "-" + entry.sessionId, name: "AutoLive entry", type: "SLATE" },
            source: { id: AUTO_LIVE_ENTRY_ID, kind: "break", title: AUTO_LIVE_ENTRY_TITLE,
                message: AUTO_LIVE_ENTRY_MESSAGE, logoUrl: entry.logoUrl },
            playback: { initialTime: 0, duration: null, playing: false, ended: false, state: "ready", startedAt: committedAt },
            graphics: { items: [] }, overlays: {}, transition: { type: "cut", durationMs: 0 } });
        if (!snapshot) { trace.record("program-output", "entry-snapshot-rejected"); return null; }
        this.snapshot = snapshot;
        trace.record("program-output", "publish-attempt", { ...programTraceFields(snapshot), reason: "entry" });
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
            overlays: this.createOverlays(),
            transition: { type: "cut", durationMs: 0 }
        });
        if (!snapshot) return null;
        this.snapshot = snapshot;
        trace.record("program-output", "publish-attempt", { ...programTraceFields(snapshot), reason });
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

    setAutoLiveLossSlate(value) {
        if (JSON.stringify(value) === JSON.stringify(this.autoLiveLossSlate)) return;
        this.autoLiveLossSlate = value;
        if (this.started) this.publish("graphics");
    }

    createGraphics() {
        const loss = this.autoLiveLossSlate;
        if (loss && loss.sceneId === this.stateManager.getProgramSceneId() &&
            this.catalog.getDefinition(loss.sceneId)?.renderer?.sourceId === loss.sourceId) {
            return { items: [{ id: AUTO_LIVE_LOSS_SLATE_ID, kind: "image",
                position: "top-left", url: loss.logoUrl }] };
        }
        const items = this.graphicsManager.getVisibleGraphics("program")
            .filter(({ graphic }) => graphic.kind !== "text-crawl")
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

    createOverlays() {
        const entry = this.graphicsManager.getVisibleGraphics("program")
            .find(({ graphic }) => graphic.kind === "text-crawl");
        return entry?.payload ? { textCrawl: { ...entry.payload } } : {};
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
