import { LIVE_PROGRESS_STALL_MS } from "./LiveHlsHealthConsumer.js";
import trace from "../core/RuntimeTrace.js";
import { AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS, AUTOLIVE_PROGRAM_RECOVERY_ATTEMPT_MS } from "./AutoLivePostTakePolicy.js";

export const AUTO_LIVE_VISUAL_LOSS_MS = 2000;

// After external-HLS entry, the promoted Program is the playback authority.
// This observer belongs to the session, never to Technical Monitor or slate UI.
export default class AutoLiveActiveHealth {
    constructor(controller) {
        this.controller = controller;
        this.session = controller.session;
        this.generation = controller.generation;
        this.state = "ONLINE";
        this.projected = false;
        this.lastProgressAt = controller.clock();
        this.binding = 0;
        this.visualLost = false;
        this.uncertainSince = null;
        this.confirmedSince = null;
        this.sourceUnavailableSince = null;
        this.recoveryGeneration = 0;
    }
    current() {
        const c = this.controller;
        return !this.stopped && c.started && c.activeHealth === this &&
            (!c.executionOwnership || c.executionOwnership.valid()) &&
            c.generation === this.generation && c.session?.sessionId === this.session.sessionId &&
            c.session.phase === "LIVE";
    }
    publish(state, reason) {
        if (!this.current() || this.projected && state === this.state) return;
        this.state = state;
        // Construction is not an observation. Project the first actual progress
        // or uncertainty sample, then retain ordinary equal-state suppression.
        this.projected = true;
        this.controller.acceptActiveHealth(this, state, reason);
    }
    decision(reason, close = false) {
        const c = this.controller, video = this.surface?.video;
        trace.record("autolive-visual-health", "decision", {
            generation: this.generation, sessionId: this.session.sessionId, sourceId: this.session.sourceId,
            reason, currentTime: video?.currentTime, lastProgressAge: c.clock() - this.lastProgressAt,
            graceDeadline: this.confirmedSince === null ? undefined : this.confirmedSince + AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS,
            lossGeneration: c.lossToken,
            paused: video?.paused, ended: video?.ended, readyState: video?.readyState,
            networkState: video?.networkState, playerState: this.surface?.getHealth?.()?.state,
            hlsFatal: this.surface?.lastHlsErrorFatal,
            mode: !this.surface?.hls ? "native" : this.surface.lastHlsErrorFatal === undefined
                ? "hls-no-error-observed" : this.surface.lastHlsErrorFatal ? "hls-fatal" : "hls-nonfatal",
            sourceState: c.externalObservation?.state, state: this.visualLost ? "SHOWN" : "SUPPRESSED",
            ownershipState: close ? "YES" : "NO" });
    }
    uncertain(reason) {
        if (!this.current()) return;
        if (this.uncertainSince === null) this.uncertainSince = this.controller.clock();
        // Trace one attempted activation per disturbance, not every media event.
        if (this.lastUncertaintyTrace !== this.uncertainSince) {
            this.lastUncertaintyTrace = this.uncertainSince;
            this.decision(reason);
        }
    }
    canClose() {
        return this.current() && this.state === "OFFLINE" &&
            this.controller.externalObservation?.state !== "ONLINE" &&
            this.confirmedSince !== null && this.remainingLossMs() === 0 &&
            this.controller.clock() - this.lastProgressAt >= LIVE_PROGRESS_STALL_MS;
    }
    remainingLossMs() {
        return this.confirmedSince === null ? null : Math.max(0,
            this.confirmedSince + AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS - this.controller.clock());
    }
    resetConfirmation() {
        this.confirmedSince = null;
        const c = this.controller;
        if (c.lossTimer !== null || c.lossGraceExpired || c.lossGraceDeadline != null) {
            c.lossToken = (c.lossToken || 0) + 1;
            c.clearTimer(c.lossTimer); c.lossTimer = null;
            c.lossGraceDeadline = null; c.lossGraceExpired = false;
        }
    }
    check() {
        if (!this.current()) return;
        this.sampleProgress?.();
        const sourceState = this.controller.externalObservation?.state;
        if (sourceState === "ONLINE") {
            this.sourceUnavailableSince = null;
            this.resetConfirmation();
        } else if (this.sourceUnavailableSince === null) this.sourceUnavailableSince = this.controller.clock();
        const age = this.controller.clock() - this.lastProgressAt;
        if (age >= AUTO_LIVE_VISUAL_LOSS_MS && this.uncertainSince === null)
            this.uncertainSince = this.lastProgressAt;
        if (this.uncertainSince === null || this.controller.clock() - this.uncertainSince < AUTO_LIVE_VISUAL_LOSS_MS) return;
        const changed = !this.visualLost;
        this.visualLost = true;
        const newEpisode = sourceState !== "ONLINE" && this.confirmedSince === null;
        if (newEpisode) this.confirmedSince = Math.max(this.uncertainSince, this.sourceUnavailableSince);
        // Source observations corroborate the Program owner; they cannot cause
        // loss while Program advances, nor can a decode stall override ONLINE.
        const confirmed = age >= LIVE_PROGRESS_STALL_MS && sourceState !== "ONLINE" &&
            (sourceState === "OFFLINE" || age >= LIVE_PROGRESS_STALL_MS + this.controller.lossGraceMs);
        const state = confirmed ? "OFFLINE" : "CHECKING";
        if (changed || state !== this.state) this.decision(confirmed ? "persistent-loss-corroborated" : "sustained-playback-uncertainty");
        this.publish(state, confirmed ? "persistent-loss-corroborated" : "sustained-playback-uncertainty");
        // A source recovery may cancel confirmation while the visual slate stays.
        // A later source absence must arm a fresh deadline even if state is CHECKING.
        if (newEpisode && this.current() && this.controller.lossTimer === null && !this.controller.lossGraceExpired)
            this.controller.acceptActiveHealth(this, state, "new-continuous-loss-episode");
    }
    observe() {
        const c = this.controller, surface = c.renderer.program?.renderer;
        if (surface === this.surface) return;
        this.unbind?.();
        const binding = ++this.binding;
        const replacing = Boolean(this.surface);
        this.surface = surface;
        if (replacing) this.uncertain("program-consumer-replaced");
        const video = surface?.sourceId === this.session.sourceId ? surface.video : null;
        let lastTime = video?.currentTime;
        const valid = () => Boolean(video) && this.current() && binding === this.binding &&
            c.renderer.program?.renderer === surface && c.command.stateManager.getProgramSceneId() === this.session.sceneId;
        const progress = () => {
            if (!valid()) return;
            const time = video.currentTime;
            if (video.readyState >= 2 && !video.paused && !video.ended && time > lastTime + .01) {
                this.lastProgressAt = c.clock();
                if (surface.status || ["error", "ended"].includes(surface.getHealth?.()?.state))
                    surface.completeProgramRecovery?.();
                if (this.recoveryDeadline != null) {
                    trace.record("autolive-recovery", "progress-recovered", { sessionId: this.session.sessionId,
                        instanceId: surface.instanceId, consumerGeneration: this.recoveryGeneration });
                    this.recoveryDeadline = null;
                    ++this.recoveryGeneration;
                }
                this.resetConfirmation();
                this.uncertainSince = null;
                this.visualLost = false;
                c.activePlayback = { instanceId: surface.instanceId, lastProgressAt: this.lastProgressAt };
                this.publish("ONLINE", "active-program-progress");
            }
            lastTime = time;
        };
        this.sampleProgress = progress;
        const uncertain = event => { if (valid()) this.uncertain(event.type); };
        const events = { timeupdate: progress, waiting: uncertain, stalled: uncertain, error: uncertain, ended: uncertain };
        Object.entries(events).forEach(([name, fn]) => video?.addEventListener(name, fn));
        this.unbind = () => Object.entries(events).forEach(([name, fn]) => video?.removeEventListener(name, fn));
    }
    recoverProgram() {
        if (!this.current() || !this.visualLost) return;
        const c = this.controller, surface = c.renderer.program?.renderer;
        if (!surface || surface.sourceId !== this.session.sourceId) return;
        const failed = ["error", "ended"].includes(surface.getHealth?.()?.state) ||
            surface.video?.error || surface.video?.networkState === 3;
        if (!failed && this.recoveryDeadline == null) return;
        if (this.recoveryDeadline != null && c.clock() < this.recoveryDeadline) return;
        const generation = ++this.recoveryGeneration;
        const first = this.recoveryDeadline == null;
        // Install the bounded attempt before synchronous error callbacks can run.
        this.recoveryDeadline = c.clock() + AUTOLIVE_PROGRAM_RECOVERY_ATTEMPT_MS;
        const fields = { generation: c.generation, consumerGeneration: generation,
            sessionId: this.session.sessionId, sourceId: this.session.sourceId,
            instanceId: surface.instanceId, lossGeneration: c.lossToken,
            graceDeadline: c.lossGraceDeadline, remainingMs: this.remainingLossMs(),
            sourceState: c.externalObservation?.state, playerState: surface.getHealth?.()?.state,
            consumer: "program", authority: "active-program", retryDeadline: this.recoveryDeadline,
            reason: surface.getHealth?.()?.reason || "missing-playback-progress" };
        if (first && surface.hls) {
            trace.record("autolive-recovery", "retain-hls-attempt", fields);
            return;
        }
        if (first && !surface.hls && surface.recoverProgramPlayback) {
            trace.record("autolive-recovery", "native-reload", fields);
            void surface.recoverProgramPlayback();
            return;
        }
        trace.record("autolive-recovery", "replace-start", { ...fields, reason: "recovery-attempt-expired" });
        const starting = c.renderer.renderSlot(c.renderer.program, this.session.sceneId);
        this.observe();
        trace.record("autolive-recovery", "replacement-created", { ...fields,
            instanceId: c.renderer.program?.renderer?.instanceId });
        // Advancing playback, not start/play settlement, completes an attempt.
        Promise.resolve(starting).catch(() => {
            if (this.current() && generation === this.recoveryGeneration)
                trace.record("autolive-recovery", "replacement-start-failed", fields);
        });
    }
    start() {
        this.observe();
        const schedule = () => {
            const token = this.watchdogToken = (this.watchdogToken || 0) + 1;
            this.timer = this.controller.setTimer(() => {
                if (token !== this.watchdogToken || !this.current()) return;
                this.observe();
                this.check();
                this.recoverProgram();
                if (this.current()) schedule();
            }, 1000);
        };
        schedule();
    }
    destroy() {
        this.stopped = true; ++this.binding;
        ++this.watchdogToken;
        this.controller.clearTimer(this.timer);
        this.unbind?.();
    }
}
