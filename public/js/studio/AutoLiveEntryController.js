import DominantLiveController from "./DominantLiveController.js";
import { AUTO_LIVE_ENTRY_STABILITY_MS, AUTO_LIVE_ENTRY_ABANDONMENT_MS } from "./AutoLiveEntryPolicy.js";
import { LIVE_SOURCE_RETRY_DELAY_MS } from "./LiveSourceMonitor.js";
import trace from "../core/RuntimeTrace.js";
import AutoLiveActiveHealth from "./AutoLiveActiveHealth.js";

// Entry owns the interruption from the slate onward. The base controller retains
// the established post-TAKE source-loss, operator-override and return contract.
export default class AutoLiveEntryController extends DominantLiveController {
    constructor({ renderer, retainedProgramIdentityResolved = null, retainedProgram = null,
        entryStabilityMs = AUTO_LIVE_ENTRY_STABILITY_MS,
        entryAbandonmentMs = AUTO_LIVE_ENTRY_ABANDONMENT_MS, getProgramRevision = () => null, ...options }) {
        super(options);
        if (![entryStabilityMs, entryAbandonmentMs].every(value => Number.isFinite(value) && value > 0))
            throw new RangeError("AutoLive entry policy requires positive finite durations");
        Object.assign(this, { renderer, retainedProgramIdentityResolved, retainedProgram,
            entryStabilityMs, entryAbandonmentMs, getProgramRevision });
        this.entryAttempt = 0;
        this.entryElapsedMs = 0;
        this.entryHealthListeners = new Set();
        this.retainedAdoptionPending = retainedProgramIdentityResolved === true &&
            retainedProgram?.source?.kind === 'hls';
        this.retainedAdoptionDiagnostics = Object.freeze({state:'IDLE',reason:null});
    }
    start() {
        if (this.started) return true;
        this.removeProgramGuard = this.command.stateManager?.addProgramGuard?.(request => {
            const session = this.session;
            if (!session || session.phase !== "LIVE") return true;
            const allowed = request.sceneId === session.sceneId || request.source === "operator";
            this.traceHandoff(allowed ? "program-write-allowed" : "program-write-blocked", { reason: request.reason,
                consumer: request.source, mode: request.path, state: request.sceneId || "EMPTY",
                ownershipState: "ACTIVE", remainingMs: this.activeHealth?.remainingLossMs() });
            return allowed;
        });
        const started=super.start();
        if(started){
            this.retainedTransportUnsubscribe=this.renderer?.subscribeProgramTransport?.(()=>this.tryAdoptRetainedLive());
            this.tryAdoptRetainedLive();
        }
        return started;
    }
    tryAdoptRetainedLive(){
        if(!this.retainedAdoptionPending)return false;
        const adopted=this.adoptRetainedLive();
        if(adopted)this.retainedAdoptionPending=false;
        return adopted;
    }
    adoptRetainedLive(){
        const blocked = (reason, extra={}) => {
            this.retainedAdoptionDiagnostics=Object.freeze({state:'BLOCKED',reason,...extra});
            trace.record('autolive-handoff','retained-live-adoption-blocked',{reason,...extra});
            this.emit();
            return false;
        };
        if(!this.started)return blocked('NOT_STARTED');
        if(this.session)return blocked('SESSION_ALREADY_ACTIVE');
        if(this.pendingSession)return blocked('PENDING_SESSION');
        if(this.closingSession)return blocked('CLOSING_SESSION');
        const setting=this.config.getSnapshot();
        const source=this.getAuthorizedSource(),target=this.resolveTarget(source);
        const scheduler=this.schedulerSnapshot||this.scheduler?.getSnapshot?.()||null;
        if(!setting.armed)return blocked('ARMED_FALSE');
        if(!scheduler?.enabled)return blocked('SCHEDULER_DISABLED');
        if(scheduler.interruptionContext)return blocked('SCHEDULER_INTERRUPTED');
        if(!source)return blocked('AUTHORIZED_SOURCE_UNRESOLVED');
        if(!target?.sceneId)return blocked('TARGET_UNRESOLVED',{sourceId:source.id});
        const programSceneId=this.command.stateManager.getProgramSceneId();
        if(programSceneId!==target.sceneId)return blocked('PROGRAM_SCENE_MISMATCH',{sourceId:source.id,sceneId:programSceneId,targetSceneId:target.sceneId});
        const transport=this.renderer.getProgramTransport?.();
        const renderedSourceId=this.renderer?.program?.renderer?.sourceId??null;
        const rendererSceneId=this.renderer?.program?.sceneId??null;
        const transportSourceId=transport?.sourceId??null;
        const effectiveProgramSourceId=transportSourceId??renderedSourceId;
        if(effectiveProgramSourceId!==source.id)return blocked('PROGRAM_SOURCE_MISMATCH',{
            sourceId:source.id,
            programSourceId:effectiveProgramSourceId,
            transportSourceId,
            renderedSourceId,
            rendererSceneId,
            retainedPending:this.retainedAdoptionPending===true
        });
        const sessionId=this.uuidFactory?.()||`retained-${this.clock()}`;
        this.session=Object.freeze({sessionId,sourceId:source.id,sceneId:target.sceneId,phase:'LIVE',origin:'dominant-live-retained',
            startedAt:this.clock(),schedulerInterruptionContext:null,returnTarget:null,retained:true});
        this.acquisitionState='ON_AIR';
        this.retainedAdoptionDiagnostics=Object.freeze({state:'ADOPTED',reason:'BOOTSTRAP_RETAINED_LIVE'});
        this.traceHandoff('retained-live-adopted',{reason:'bootstrap-retained-live'});
        this.emit();
        return true;
    }
    reconcileConfiguration() {
        if(this.retainedAdoptionPending)this.tryAdoptRetainedLive();
        const armed = this.config.getSnapshot().armed === true;
        if (!armed) { this.cancelReacquisition(); this.reacquisitionSuppressed = false; }
        // Explicit re-arming authorizes a new entry even if the same external
        // monitor has remained ONLINE without emitting another transition.
        if (this.entryLastArmed === false && armed) this.closedHealthGeneration = undefined;
        this.entryLastArmed = armed;
        super.reconcileConfiguration();
    }
    getSnapshot() {
        const snapshot = super.getSnapshot();
        const preparing = this.session?.phase === "PREPARING";
        return Object.freeze({ ...snapshot, status: preparing ? "PREPARING" :
            this.reacquisitionSuppressed && this.config.getSnapshot().armed ? "ARMED — BLOCKED" : snapshot.status,
            phase: preparing ? "PREPARING" : this.session ? snapshot.status === "LOSS GRACE" ? "LOSS_GRACE" : "LIVE" : "CLOSED",
            diagnostics: Object.freeze({ ...snapshot.diagnostics,
                retainedAdoption: this.retainedAdoptionDiagnostics,
                entryElapsedMs: this.entryElapsedMs || 0,
                entryRequiredMs: this.entryStabilityMs,
                entryAbandonmentDeadline: this.entryAbandonmentDeadline ?? null }) });
    }
    evaluate() {
        if (this.retainedAdoptionPending) {
            const source = this.getAuthorizedSource();
            const target = this.resolveTarget(source);
            const programSceneId = this.command.stateManager.getProgramSceneId();
            if (source && target?.sceneId && programSceneId === target.sceneId) {
                this.tryAdoptRetainedLive();
                if (this.retainedAdoptionPending) {
                    this.emit();
                    return;
                }
            }
        }
        if (!this.started || this.session || this.pendingSession || this.closingSession || this.latched || this.reacquisitionSuppressed ||
            !this.config.getSnapshot().armed || !this.schedulerSnapshot?.enabled ||
            this.schedulerSnapshot.interruptionContext || this.health.state !== "ONLINE" ||
            this.command.transitionCoordinator?.isBusy() ||
            Number.isFinite(this.closedHealthGeneration) && this.health.generation <= this.closedHealthGeneration) {
            this.emit(); return;
        }
        const source = this.getAuthorizedSource(), target = this.resolveTarget(source);
        if (!source || !target?.sceneId || this.command.stateManager.getProgramSceneId() === target.sceneId) {
            this.emit(); return;
        }
        this.cancelReacquisition();
        // Refresh the authoritative transport before capturing; timeupdate may lag the decoder.
        this.renderer.program?.renderer?.notifyTransport?.();
        const returnTarget = this.captureReturnTarget();
        const transport = this.renderer.getProgramTransport?.();
        const sessionId = this.uuidFactory?.() || `entry-${this.clock()}`;
        // Set the pending marker before Scheduler's synchronous notifications.
        this.pendingSession = { sessionId };
        let context;
        try { context = this.scheduler.beginInterruption({ origin: "dominant-live", sessionId, allowEmptySlot: true }); }
        catch { this.error = "entry-interruption-failed"; this.latched = true; }
        finally { this.pendingSession = null; }
        if (!context) { this.emit(); return; }
        this.session = Object.freeze({ sessionId, sourceId: source.id, sceneId: target.sceneId,
            phase: "PREPARING", origin: "dominant-live", startedAt: this.clock(),
            schedulerInterruptionContext: context,
            returnTarget: Object.freeze({ ...returnTarget, playbackState: transport?.state || "playing" }) });
        this.entryElapsedMs = 0;
        this.updateAttempt({ beginAttempted: true, beginResult: "RETURNED_CONTEXT",
            commandAttempted: false, commandResult: "WAITING_ENTRY_GATE" });
        const interrupted = this.renderer.program?.renderer;
        if (interrupted?.pauseForInterruption) interrupted.pauseForInterruption(this.session.returnTarget);
        else { interrupted?.deactivateProgram?.(); interrupted?.video?.pause(); interrupted?.audio?.pause(); }
        this.markEntryUnavailable();
        trace.record("autolive-entry", "slate", { sourceId: source.id, sceneId: target.sceneId });
        this.traceHandoff("entry-begin", { reason: "authorized-source-online" });
        this.emit();
        void this.prepareEntry();
    }
    handleHealth(snapshot) {
        this.traceHandoff("health-observation", { state: snapshot.state, reason: snapshot.reason,
            sourceState: snapshot.state, monitorGeneration: snapshot.generation, sourceId: snapshot.sourceId });
        if (this.activeHealth?.current()) {
            if (snapshot.sourceHealth && snapshot.sourceId === this.session.sourceId &&
                (!Number.isFinite(this.externalObservation?.generation) || snapshot.generation > this.externalObservation.generation))
                this.externalObservation = snapshot;
            this.traceHandoff("monitor-observation-only", { reason: "active-program-authority",
                sourceState: snapshot.state, monitorGeneration: snapshot.generation });
            this.activeHealth.check();
            return;
        }
        if (this.session?.phase !== "PREPARING") return super.handleHealth(snapshot);
        if (snapshot.sourceId !== this.getAuthorizedSource()?.id ||
            this.health.sourceHealth && !snapshot.sourceHealth ||
            Number.isFinite(snapshot.generation) && Number.isFinite(this.health.generation) &&
                (snapshot.generation < this.health.generation || snapshot.sourceHealth && snapshot.generation === this.health.generation)) return;
        this.health = snapshot;
        if (snapshot.state !== "ONLINE") {
            if (snapshot.state === "OFFLINE" || snapshot.state === "ERROR" && !snapshot.uncertain)
                this.entryElapsedMs = 0;
            this.markEntryUnavailable();
        }
        this.entryHealthListeners.forEach(listener => listener());
        this.emit();
    }
    markEntryUnavailable() {
        if (this.session?.phase !== "PREPARING" || this.entryAbandonmentTimer != null) return;
        const sessionId = this.session.sessionId, generation = this.generation;
        const token = this.entryUnavailableToken = (this.entryUnavailableToken || 0) + 1;
        this.entryAbandonmentDeadline = this.clock() + this.entryAbandonmentMs;
        this.entryAbandonmentTimer = this.setTimer(() => {
            if (token !== this.entryUnavailableToken || this.session?.sessionId !== sessionId || this.session.phase !== "PREPARING" || generation !== this.generation) return;
            this.entryAbandonmentTimer = null;
            this.endSession("entry-unavailable");
        }, this.entryAbandonmentMs);
    }
    async prepareEntry() {
        const session = this.session;
        if (session?.phase !== "PREPARING") return;
        // A manual TAKE may be preparing a slow source. Never replace its candidate.
        if (this.command.transitionCoordinator?.isBusy()) {
            const generation = this.generation;
            this.entryRetryTimer = this.setTimer(() => {
                if (generation !== this.generation || this.session?.sessionId !== session.sessionId) return;
                this.entryRetryTimer = null;
                void this.prepareEntry();
            }, LIVE_SOURCE_RETRY_DELAY_MS);
            return;
        }
        const attempt = ++this.entryAttempt, generation = this.generation;
        const valid = () => this.started && this.session?.sessionId === session.sessionId &&
            this.session.phase === "PREPARING" && generation === this.generation && attempt === this.entryAttempt &&
            this.config.getSnapshot().armed && this.getAuthorizedSource()?.id === session.sourceId;
        this.entryAbort = new AbortController();
        const candidateGeneration = `entry-${session.sessionId}-${attempt}`;
        this.entryCandidateGeneration = candidateGeneration;
        try {
            await this.renderer.prepareProgramScene(session.sceneId, { generation: candidateGeneration,
                preparationContext: { livePreroll: { sourceId: session.sourceId, entryGate: true,
                    windowMs: this.entryStabilityMs, signal: this.entryAbort.signal,
                    isSourceOnline: () => valid() && this.health.state === "ONLINE",
                    getHealthEpoch: () => this.stabilityEpoch || 0,
                    getSourceHealth: () => this.health,
                    consumerGeneration: attempt,
                    subscribeSourceHealth: listener => {
                        this.entryHealthListeners.add(listener);
                        return () => this.entryHealthListeners.delete(listener);
                    },
                    onProgress: ({ elapsedMs, healthy }) => {
                        if (!valid()) return;
                        this.entryElapsedMs = elapsedMs;
                        if (healthy) {
                            this.entryUnavailableToken = (this.entryUnavailableToken || 0) + 1;
                            this.clearTimer(this.entryAbandonmentTimer); this.entryAbandonmentTimer = null;
                            this.entryAbandonmentDeadline = null;
                        } else this.markEntryUnavailable();
                        this.emit();
                    } } } });
            if (!valid()) return;
            this.traceHandoff("gate-complete");
            const result = this.command.commitPrepared({ sceneId: session.sceneId, generation: candidateGeneration,
                canCommit: () => valid() && this.health.state === "ONLINE" && this.entryElapsedMs >= this.entryStabilityMs,
                beforeCommit: () => {
                    if (!valid()) return false;
                    this.traceHandoff("commit-begin");
                    this.clearEntryWork(false);
                    this.session = Object.freeze({ ...session, phase: "LIVE" });
                    if (this.health.authority === "external-hls") {
                        this.externalObservation = this.health;
                        this.activeHealth = new AutoLiveActiveHealth(this);
                    }
                    this.activeConsumerGeneration = attempt;
                    this.activePlayback = { instanceId: this.renderer.program.prepared?.renderer?.instanceId,
                        lastProgressAt: this.clock() };
                    this.traceHandoff("entry-retired");
                    return true;
                } });
            if (!result.ok) {
                if (this.session?.sessionId === session.sessionId && this.session.phase === "LIVE")
                    this.endSession("activation-failed");
                throw new Error("entry-commit-rejected");
            }
            // A synchronous subscriber may have issued an operator TAKE. Never
            // resurrect its retired AutoLive session after dispatch returns.
            if (this.session?.sessionId !== session.sessionId || generation !== this.generation) return;
            this.traceHandoff("live-active");
            this.activeHealth?.start();
            this.acquisitionState = "ON_AIR";
            this.updateAttempt({ commandAttempted: true, commandResult: "SUCCESS", programCommitted: true });
            this.emit();
        } catch {
            if (!valid()) return;
            this.entryElapsedMs = 0;
            this.markEntryUnavailable();
            this.entryRetryTimer = this.setTimer(() => {
                this.entryRetryTimer = null;
                if (valid()) void this.prepareEntry();
            }, LIVE_SOURCE_RETRY_DELAY_MS);
            this.emit();
        }
    }
    clearEntryWork(discard = true) {
        ++this.entryAttempt;
        this.entryUnavailableToken = (this.entryUnavailableToken || 0) + 1;
        this.entryAbort?.abort(); this.entryAbort = null;
        this.clearTimer(this.entryRetryTimer); this.entryRetryTimer = null;
        this.clearTimer(this.entryAbandonmentTimer); this.entryAbandonmentTimer = null;
        this.entryAbandonmentDeadline = null;
        if (discard && this.entryCandidateGeneration) this.renderer.discardPreparedProgram({ generation: this.entryCandidateGeneration });
        this.entryCandidateGeneration = null;
    }
    endSession(reason) {
        if (!["manual-override", "disarmed", "source-changed", "runtime-stopped"].includes(reason) && this.activeHealth?.current()) {
            const owner = this.activeHealth;
            owner.check();
            if (this.activeHealth !== owner) return false;
            if (!owner.canClose()) {
                owner.decision("close-rejected-playback-or-source-evidence");
                return false;
            }
            owner.decision("confirmed-session-close", true);
            reason = "source-loss";
        }
        this.traceHandoff("close-request", { reason });
        this.traceClosedSessionId = this.session?.sessionId;
        this.traceCloseReason = reason;
        this.activeHealth?.destroy(); this.activeHealth = null;
        // Monitor and Program observer have separate event sequences. Restore
        // the source sequence before recording the closed acquisition epoch.
        if (this.externalObservation) {
            this.health = this.externalObservation;
            this.externalObservation = null;
        }
        this.clearEntryWork();
        return super.endSession(reason);
    }
    getLossGraceDuration() {
        return this.activeHealth?.current() ? this.activeHealth.remainingLossMs() : super.getLossGraceDuration();
    }
    acceptActiveHealth(owner, state, reason) {
        if (owner !== this.activeHealth || !owner.current()) return;
        this.traceHandoff("active-health", { state, reason });
        super.handleHealth(Object.freeze({ sourceId: owner.session.sourceId,
            sourceHealth: true, authority: "active-program", state,
            uncertain: state === "CHECKING", generation: (this.health.generation || 0) + 1, reason }));
    }
    async finishSession(session, reason) {
        if (this.session) {
            this.traceHandoff("session-cleanup-blocked-owned", { reason });
            return false;
        }
        const generation = this.generation;
        const result = await super.finishSession(session, reason);
        this.traceHandoff("return-finished", { reason, sessionId: session?.sessionId });
        if (!["source-loss", "entry-unavailable", "activation-failed"].includes(reason) ||
            !this.started || generation !== this.generation || this.session || this.latched ||
            !this.config.getSnapshot().armed || this.health.state !== "ONLINE") return result;
        // A still-ONLINE monitor need not emit another edge. A new full entry
        // gate is the freshness proof; do not wait forever on the closed epoch.
        this.cancelReacquisition();
        const retryToken = this.reacquisitionToken;
        this.traceHandoff("retry-scheduled", { retryDeadline: this.clock() + LIVE_SOURCE_RETRY_DELAY_MS });
        this.reacquisitionTimer = this.setTimer(() => {
            if (retryToken !== this.reacquisitionToken || !this.started || generation !== this.generation || this.session || this.latched ||
                !this.config.getSnapshot().armed || this.getAuthorizedSource()?.id !== session.sourceId) return;
            this.reacquisitionTimer = null;
            this.closedHealthGeneration = undefined;
            this.traceHandoff("retry-evaluate");
            this.evaluate();
        }, LIVE_SOURCE_RETRY_DELAY_MS);
        return result;
    }
    cancelReacquisition() {
        this.reacquisitionToken = (this.reacquisitionToken || 0) + 1;
        this.clearTimer(this.reacquisitionTimer); this.reacquisitionTimer = null;
    }
    traceHandoff(event, fields = {}) {
        const prepared = this.renderer?.program?.prepared;
        const surface = prepared?.sceneId === this.session?.sceneId ? prepared?.renderer : this.renderer?.program?.renderer;
        trace.record("autolive-handoff", event, {
            generation: this.generation, consumerGeneration: this.session?.phase === "LIVE" ? this.activeConsumerGeneration : this.entryAttempt,
            monitorGeneration: this.externalObservation?.generation ?? this.health.generation,
            hlsGeneration: this.externalObservation?.consumerGeneration ?? this.health.consumerGeneration,
            lossGeneration: this.lossToken,
            sceneId: this.command.stateManager.getProgramSceneId(),
            programSourceId: this.renderer?.program?.renderer?.sourceId,
            graceDeadline: this.lossGraceDeadline, graceExpired: this.lossGraceExpired,
            remainingMs: this.activeHealth?.remainingLossMs(),
            sourceId: this.session?.sourceId || this.getAuthorizedSource()?.id,
            sessionId: this.session?.sessionId ?? this.traceClosedSessionId, phase: this.session?.phase || "CLOSED",
            sourceState: this.health.state, authority: this.health.authority,
            playerState: surface?.getHealth?.().state, instanceId: surface?.instanceId,
            currentTime: surface?.video?.currentTime, revision: this.getProgramRevision(),
            playing: Boolean(surface?.video && !surface.video.paused && !surface.video.ended),
            playbackProgressing: Boolean(this.session?.phase === "LIVE" && this.activePlayback &&
                this.activePlayback.instanceId === surface?.instanceId &&
                this.clock() - this.activePlayback.lastProgressAt < this.lossGraceMs && !this.programPlaybackLost),
            lastHealthyAt: this.activePlayback?.lastProgressAt,
            ...fields });
    }
    async restoreReturnTarget(target) {
        this.traceHandoff("restore-request", { reason: this.traceCloseReason });
        if (this.session || this.lossTimer !== null || this.lossGraceExpired) return false;
        if (target?.sceneId && this.command.stateManager.getProgramSceneId() === target.sceneId) {
            const surface = this.renderer.program?.renderer;
            if (surface?.resumeFromInterruption) return surface.resumeFromInterruption(target);
            if (target.sourceKind === "hls") await surface?.activateProgram?.();
            return true;
        }
        if (!target?.sceneId) return super.restoreReturnTarget(target);
        const generation = this.generation;
        const result = await this.command.execute({ sceneId: target.sceneId, transition: "CUT",
            origin: "dominant-live", preservePreview: true, initialCueSeconds: target.cueAtInterruption,
            initialPlayback: target.playbackState === "playing" ? "playing" : "paused",
            initialEnded: target.playbackState === "ended",
            canCommit: () => !this.session && generation === this.generation });
        return result?.ok === true;
    }
    handleProgramChanged(record) {
        this.traceHandoff("program-changed", { sceneId: this.command.stateManager.getProgramSceneId(), reason: record?.reason,
            consumer: record?.source });
        if (record?.source !== "dominant-live" && (this.session || this.closingSession || this.reacquisitionTimer != null))
            this.reacquisitionSuppressed = true;
        if (this.reacquisitionTimer != null && record?.source !== "dominant-live") {
            this.cancelReacquisition(); this.latched = true;
        }
        // Invalidate a queued return as well as a pending entry on operator TAKE.
        if (!this.session && this.closingSession && record?.source !== "dominant-live") ++this.generation;
        super.handleProgramChanged(record);
    }
    destroy() {
        this.retainedAdoptionPending=false;
        this.retainedTransportUnsubscribe?.(); this.retainedTransportUnsubscribe=null;
        this.removeProgramGuard?.(); this.removeProgramGuard = null;
        this.activeHealth?.destroy(); this.activeHealth = null;
        this.cancelReacquisition();
        this.clearEntryWork();
        if (this.session?.phase === "PREPARING") this.endSession("runtime-stopped");
        super.destroy();
    }
}
