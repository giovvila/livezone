import { LIVE_PROGRESS_STALL_MS } from "./LiveHlsHealthConsumer.js";
import trace from "../core/RuntimeTrace.js";
import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import { AUTO_LIVE_LOSS_LOGO, createAutoLiveLossSlate } from "../program-output/AutoLiveLossSlate.js";

export default class AutoLiveLossPresentation {
    constructor({ controller, output, root, stateManager, renderer = null, eventBus = EventBus,
        logoUrl = AUTO_LIVE_LOSS_LOGO, setTimer = setTimeout, clearTimer = clearTimeout }) {
        Object.assign(this, { controller, output, root, stateManager, renderer, eventBus, logoUrl });
        this.setTimer = (fn, ms) => setTimer(fn, ms);
        this.clearTimer = id => clearTimer(id);
        this.presentation = null;
        this.handleProgramChanged = () => { this.stopObserving(); this.setPresentation(null); };
    }
    start() {
        trace.record("loss-slate", "binding-start");
        this.eventBus.on(Events.STUDIO_PROGRAM_CHANGED, this.handleProgramChanged);
        this.unsubscribe = this.controller.subscribe(snapshot => this.update(snapshot));
    }
    update(snapshot) {
        const session = snapshot.session;
        this.observeProgram(session);
        const losing = this.controller.activeHealth?.current()
            ? this.controller.activeHealth.visualLost
            : snapshot.diagnostics.lossTimerActive || snapshot.diagnostics.lossGraceExpired ||
                this.controller.getSnapshot().diagnostics.programPlaybackLost;
        if (session && losing && this.stateManager.getProgramSceneId() === session.sceneId) {
            this.setPresentation({ sceneId: session.sceneId, sourceId: session.sourceId,
                sessionId: session.sessionId, logoUrl: this.logoUrl });
        } else if (!session && (this.controller.closingSession || snapshot.diagnostics.endReason === "source-loss") &&
            this.presentation?.sceneId === this.stateManager.getProgramSceneId()) {
            // Keep the safe picture until the return actually commits.
        } else this.setPresentation(null);
    }
    observeProgram(session) {
        const surface = this.renderer?.program?.renderer;
        if (!session || surface?.sourceId !== session.sourceId) { this.stopObserving(); return; }
        if (this.observedSurface === surface && this.observedSession === session.sessionId) return;
        this.stopObserving();
        this.observedSurface = surface; this.observedSession = session.sessionId;
        this.controller.traceHandoff?.("active-player-observed");
        const generation = this.observerGeneration;
        const video = surface.video;
        let lastTime = video?.currentTime;
        const current = () => generation === this.observerGeneration && this.controller.session?.sessionId === session.sessionId &&
            this.renderer.program.renderer === surface && this.stateManager.getProgramSceneId() === session.sceneId;
        const lost = () => {
            if (!current()) return;
            if (this.controller.activeHealth?.current()) return;
            this.clearTimer(this.progressTimer); this.progressTimer = null;
            this.controller.setProgramPlaybackLost(session.sessionId, true);
        };
        const armWatchdog = () => {
            this.clearTimer(this.progressTimer);
            if (this.controller.activeHealth?.current()) return;
            this.progressTimer = this.setTimer(lost, LIVE_PROGRESS_STALL_MS);
        };
        const progress = () => {
            if (!current()) return;
            const time = video.currentTime;
            if (video.readyState >= 2 && !video.paused && !video.ended && time > lastTime + 0.01) {
                this.controller.activePlayback = { instanceId: surface.instanceId,
                    lastProgressAt: this.controller.clock() };
                armWatchdog();
                this.controller.setProgramPlaybackLost(session.sessionId, false);
            }
            lastTime = time;
        };
        const fatal = () => { lost();
            if (this.controller.activeHealth?.current()) return;
            if (current() && this.recoveryTimer == null && this.renderer.renderSlot) {
                this.recoveryTimer = this.setTimer(() => {
                    if (!current()) return;
                    this.recoveryTimer = null;
                    // Rebuild only the failed HLS player. No Program command or ownership change.
                    void this.renderer.renderSlot(this.renderer.program, session.sceneId);
                    this.observeProgram(this.controller.session);
                }, 1000);
            }
        };
        const events = { waiting: lost, stalled: lost, ended: fatal, error: fatal, timeupdate: progress };
        Object.entries(events).forEach(([name, fn]) => video?.addEventListener(name, fn));
        this.unsubscribePlayer = () => Object.entries(events).forEach(([name, fn]) => video?.removeEventListener(name, fn));
        armWatchdog();
        this.unsubscribeHealth = surface.subscribeHealth?.(health => {
            if (health.state === "error" || health.state === "ended") fatal();
            else if (health.state === "stalled") lost();
        });
    }
    stopObserving() {
        this.observerGeneration = (this.observerGeneration || 0) + 1;
        this.unsubscribePlayer?.(); this.unsubscribeHealth?.();
        this.unsubscribePlayer = this.unsubscribeHealth = null;
        this.clearTimer(this.progressTimer); this.progressTimer = null;
        this.clearTimer(this.recoveryTimer); this.recoveryTimer = null;
        this.observedSurface = this.observedSession = null;
    }
    setPresentation(value) {
        if (JSON.stringify(value) === JSON.stringify(this.presentation)) return;
        this.presentation = value;
        trace.record("loss-slate", value ? "show-request" : "hide-request", {
            sourceId: value?.sourceId, sceneId: value?.sceneId, sessionId: value?.sessionId,
            revision: this.output.revision, phase: this.controller.session?.phase || "CLOSED" });
        this.controller.traceHandoff?.(value ? "loss-request" : "loss-cleared");
        this.element?.remove(); this.element = null;
        if (value && this.root) {
            this.element = createAutoLiveLossSlate(value.logoUrl);
            this.root.appendChild(this.element);
            trace.record("loss-slate", "control-rendered", { sceneId: value.sceneId });
        }
        this.output.setAutoLiveLossSlate(value);
    }
    destroy() {
        this.stopObserving();
        this.unsubscribe?.();
        this.eventBus.off(Events.STUDIO_PROGRAM_CHANGED, this.handleProgramChanged);
        this.setPresentation(null);
    }
}
