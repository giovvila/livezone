import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import { LIVE_SOURCE_RETRY_DELAY_MS } from "./LiveSourceMonitor.js";
import trace from "../core/RuntimeTrace.js";
import authorizationDiagnostics from "./AutoLiveAuthorizationDiagnostics.js";

export const ONLINE_STABLE_MS = 3000;
export const LOSS_GRACE_MS = LIVE_SOURCE_RETRY_DELAY_MS;

export default class DominantLiveController {
    constructor({ config, catalog, monitor, scheduler, command, targetResolver = null,
        eventBus = EventBus, prepareOnSourceOnline = false,
        clock = () => Date.now(), setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout, onlineStableMs = ONLINE_STABLE_MS,
        lossGraceMs = LOSS_GRACE_MS, uuidFactory = () => globalThis.crypto?.randomUUID?.(),
        probeDiagnosticsProvider = () => ({}), monotonicClock = () =>
            globalThis.performance?.now?.() ?? Date.now() } = {}) {
        Object.assign(this, { config, catalog, monitor, scheduler, command, targetResolver,
            eventBus, clock, prepareOnSourceOnline,
            onlineStableMs, lossGraceMs, uuidFactory });
        this.probeDiagnosticsProvider = typeof probeDiagnosticsProvider === "function"
            ? probeDiagnosticsProvider : () => ({});
        this.monotonicClock = monotonicClock;
        this.setTimer = (callback, delay) => setTimer(callback, delay);
        this.clearTimer = (id) => clearTimer(id); this.listeners = new Set();
        this.generation = 0; this.session = null; this.pendingSession = null; this.latched = false;
        this.stableTimer = null; this.lossTimer = null; this.lossGraceExpired = false;
        this.error = null;
        this.lastError = null;
        this.acquisitionState = "WAITING"; this.attemptGeneration = null;
        this.attemptDiagnostics = Object.freeze({});
        this.timeline = Object.freeze({});
        this.health = Object.freeze({ state: "IDLE", sourceId: null });
        this.schedulerSnapshot = scheduler?.getSnapshot?.() || null;
        this.handleProgramChanged = this.handleProgramChanged.bind(this);
        this.handlePreviewChanged = this.handlePreviewChanged.bind(this);
        this.handleTransitionSnapshot = this.handleTransitionSnapshot.bind(this);
    }
    start() { if (this.started || !this.config || !this.catalog || !this.monitor ||
        !this.scheduler || !this.command) return false; this.started = true;
        this.unsubscribeConfig = this.config.subscribe(() => this.reconcileConfiguration());
        this.unsubscribeCatalog = this.catalog.subscribe(() => this.reconcileConfiguration());
        this.unsubscribeHealth = this.monitor.subscribe((snapshot) => this.handleHealth(snapshot));
        this.unsubscribeScheduler = this.scheduler.subscribe((snapshot) => {
            this.schedulerSnapshot = snapshot; this.evaluate(); });
        this.unsubscribeTransition = this.command.transitionCoordinator?.subscribe?.(
            this.handleTransitionSnapshot);
        this.eventBus.on(Events.STUDIO_PROGRAM_CHANGED, this.handleProgramChanged);
        this.eventBus.on(Events.STUDIO_PREVIEW_CHANGED, this.handlePreviewChanged);
        this.logAuthorization();
        return true; }
    destroy() { if (!this.started) return; ++this.generation; this.clearTimers();
        this.unsubscribeConfig?.(); this.unsubscribeCatalog?.(); this.unsubscribeHealth?.();
        this.unsubscribeScheduler?.(); this.unsubscribeTransition?.();
        this.eventBus.off(Events.STUDIO_PROGRAM_CHANGED,
            this.handleProgramChanged);
        this.eventBus.off(Events.STUDIO_PREVIEW_CHANGED, this.handlePreviewChanged);
        this.monitor.destroy(); this.listeners.clear(); this.started = false; }
    subscribe(listener) { if (typeof listener !== "function") return () => {};
        this.listeners.add(listener); listener(this.getSnapshot()); return () => this.listeners.delete(listener); }
    refreshDiagnostics() { if (this.started) this.emit(); }
    getSnapshot() { const setting = this.config?.getSnapshot?.() || {};
        const scheduler=this.started?this.schedulerSnapshot:(this.scheduler?.getSnapshot?.()||this.schedulerSnapshot);
        const source = this.getAuthorizedSource(); const preflight = this.getPreflightDiagnostics();
        const status = !setting.armed || !source ? "DISARMED"
            : this.session ? (this.lossTimer || this.lossGraceExpired || this.programPlaybackLost ? "LOSS GRACE" : "ON AIR")
                : this.pendingSession ? "ACTIVATING"
                : this.acquisitionState === "RECOVERING" ? "RECOVERING"
                : this.acquisitionState === "BLOCKED" ? "ARMED — BLOCKED"
                    : this.error || this.acquisitionState === "ERROR" ? "ERROR"
                    : this.latched ? "ARMED — BLOCKED"
                    : this.acquisitionState === "ACQUIRING" ? "ARMED — ACQUIRING"
                    : this.acquisitionState === "READY" ? "ARMED — READY"
                    : !source ? "NO AUTHORIZED SOURCE"
                    : !scheduler?.enabled ? "WAITING FOR SCHEDULER"
                    : this.stableTimer ? "ARMED — ONLINE/STABILIZING"
                        : this.health.state === "ONLINE" ? "ARMED — WAITING"
                            : this.health.state === "CHECKING" ? "ARMED — CHECKING"
                                : this.health.sourceHealth && this.health.state === "ERROR" ? "ARMED — RETRY"
                                : "ARMED — WAITING";
        return Object.freeze({ armed: setting.armed === true,
            authorizedSourceId: setting.authorizedSourceId || null,
            authorizedSourceName: source?.name || null, health: this.health.state,
            status, session: this.session, diagnostics: Object.freeze({
                ...this.probeDiagnosticsProvider(),
                generation: this.generation,
                healthGeneration: this.health.generation ?? null,
                retryActive: this.health.retryActive === true,
                sourcePresenceReason: this.health.reason || null,
                sourcePresenceHttpStatus: this.health.httpStatus ?? null,
                sourcePresenceRetryAttempt: this.health.retryAttempt ?? null,
                sourcePresenceRetryDeadline: this.health.retryDeadline ?? null,
                stableTimerActive: this.stableTimer !== null,
                lossTimerActive: this.lossTimer !== null,
                lossGraceExpired: this.lossGraceExpired,
                programPlaybackLost: this.programPlaybackLost === true,
                sessionState: this.session ? "ACTIVE" : this.pendingSession ? "PENDING" : "NONE",
                recoveryState: this.schedulerSnapshot?.failure ? "ERROR"
                    : this.acquisitionState === "RECOVERING" ? "RECOVERING" : "IDLE",
                recoveryFailure: this.schedulerSnapshot?.failure?.reason || null,
                lastError: this.lastError,
                ...this.getTimelineDiagnostics(),
                acquisitionState: this.acquisitionState,
                latched: this.latched,
                ...preflight,
                ...this.attemptDiagnostics
            }) }); }
    getTimelineDiagnostics() { const now = this.monotonicClock();
        const elapsed = (value) => Number.isFinite(value) ? Math.max(0, Math.round(now - value)) : null;
        return Object.freeze({ ...this.timeline,
            lossElapsedMs: elapsed(this.timeline.lossAt),
            offlineElapsedMs: elapsed(this.timeline.offlineAt),
            retryElapsedMs: elapsed(this.timeline.retryAt),
            onlineElapsedMs: elapsed(this.timeline.onlineAt) }); }
    getPreflightDiagnostics() { const setting = this.config?.getSnapshot?.() || {};
        const source = this.getAuthorizedSource(); const scheduler = this.schedulerSnapshot;
        const target = this.resolveTarget(source); const sceneId = target?.sceneId || null;
        let waitingReason = null;
        if (!this.started) waitingReason = "WAITING_NOT_STARTED";
        else if (!setting.armed) waitingReason = "WAITING_ARMED_FALSE";
        else if (!source) waitingReason = "WAITING_SOURCE_INVALID";
        else if (this.session) waitingReason = "WAITING_SESSION_ACTIVE";
        else if (this.pendingSession) waitingReason = "WAITING_ACQUISITION_PENDING";
        else if (this.latched) waitingReason = "WAITING_LATCHED";
        else if (!scheduler?.enabled) waitingReason = "WAITING_SCHEDULER_DISABLED";
        else if (scheduler.interruptionContext) waitingReason = "WAITING_EXISTING_INTERRUPTION";
        else if (this.health.state !== "ONLINE") waitingReason = "WAITING_HEALTH_NOT_ONLINE";
        else if (this.stableTimer !== null) waitingReason = "WAITING_STABILIZING";
        else if (this.attemptGeneration === this.generation) waitingReason = "WAITING_ATTEMPT_RECORDED";
        return Object.freeze({ resolvedSourceId: source?.id || null,
            resolvedSceneId: sceneId, resolvedTarget: target?.kind || null,
            schedulerEnabled: scheduler?.enabled === true,
            schedulerStatus: scheduler?.status || null,
            activeItemId: scheduler?.activeItem?.id || null,
            interruptionState: scheduler?.interruptionContext ? "ACTIVE" : "NONE",
            currentProgramSceneId: this.command?.stateManager?.getProgramSceneId?.() || null,
            transitionBusy: this.command?.transitionCoordinator?.isBusy?.() === true,
            beginAttempted: false, beginResult: "NOT_CALLED", commandAttempted: false,
            commandResult: "NOT_CALLED", waitingReason }); }
    reconcileConfiguration() { if (!this.started) return; const setting = this.config.getSnapshot();
        this.config.logRead?.(this.catalog);
        const source = this.getAuthorizedSource(); const fingerprint = source
            ? `${source.id}:${source.enabled}:${source.url}` : null;
        const candidate = this.catalog.getSources().find(({ id }) => id === setting.authorizedSourceId);
        // An unresolved saved identity may precede catalog hydration or registration.
        // Revoke only a known invalid source or the removal of a previously resolved one.
        if (this.catalog.initialized !== false && setting.authorizedSourceId && !source &&
            (candidate || this.resolvedAuthorizedSourceId === setting.authorizedSourceId)) {
            this.resolvedAuthorizedSourceId = null;
            this.config.setAuthorizedSourceId(null);
            // Even a failed persistence write must stop an invalid source below.
            if (this.config.getSnapshot().authorizedSourceId === null) return;
        }
        if (source) this.resolvedAuthorizedSourceId = source.id;
        if (fingerprint !== this.sourceFingerprint) { ++this.generation; this.clearTimers();
            this.resetAttempt("WAITING");
            this.sourceFingerprint = fingerprint; this.health = Object.freeze({ state: "IDLE", sourceId: null });
            if (this.session) this.endSession("source-changed");
            source ? this.monitor.selectSource(source) : this.monitor.stop(); }
        if (!setting.armed) { this.latched = false; this.clearStableTimer(); this.resetAttempt("WAITING");
            if (this.pendingSession) { this.pendingSession = null;
                this.scheduler.endInterruption(this.clock()); }
            if (this.session) this.endSession("disarmed"); }
        this.evaluate(); this.logAuthorization(); }
    logAuthorization() {
        const setting = this.config.getSnapshot(); const source = this.getAuthorizedSource();
        (this.config.diagnostics || authorizationDiagnostics).record("AUTOLIVE_AUTH_CONTROLLER", {
            ...this.config.diagnosticContext?.(), armed: setting.armed,
            authorizedSourceId: setting.authorizedSourceId,
            state: this.getSnapshot().status,
            reason: !source ? "NO_AUTHORIZED_SOURCE" : !setting.armed ? "ARMED_FALSE" : "AUTHORIZED" });
    }
    getAuthorizedSource() { const id = this.config?.getSnapshot?.().authorizedSourceId;
        return this.catalog?.getSources?.().find((source) => source.id === id &&
            source.kind === "hls" && source.enabled !== false) || null; }
    resolveTarget(source) {
        const persistentSceneId = source?.sceneIds?.find((id) => this.catalog.getDefinition(id)) || null;
        if (persistentSceneId) return Object.freeze({ kind: "persistent-scene",
            sceneId: persistentSceneId });
        if (!source || source.kind !== "hls") return null;
        const runtime = this.targetResolver?.resolve?.({ kind: "source", id: source.id });
        return runtime?.sceneId ? Object.freeze({ kind: "runtime-source",
            sceneId: runtime.sceneId }) : null;
    }
    handleHealth(snapshot) { if (!this.started || snapshot.sourceId !== this.getAuthorizedSource()?.id) return;
        if (this.health.sourceHealth && !snapshot.sourceHealth ||
            snapshot.sourceHealth && Number.isFinite(this.health.generation) &&
            snapshot.generation <= this.health.generation ||
            Number.isFinite(snapshot.generation) && Number.isFinite(this.health.generation) &&
            snapshot.generation < this.health.generation ||
            snapshot.state === "ONLINE" && Number.isFinite(this.closedHealthGeneration) &&
            snapshot.generation <= this.closedHealthGeneration) {
            trace.record("autolive", "stale-health-rejected", { sourceId: snapshot.sourceId,
                state: snapshot.state, monitorGeneration: snapshot.generation, generation: this.generation });
            return;
        }
        trace.record("autolive", "health-transition", { state: snapshot.state,
            sourceId: snapshot.sourceId, monitorGeneration: snapshot.generation,
            generation: this.generation, sessionActive: Boolean(this.session),
            graceExpired: this.lossGraceExpired, graceDeadline: this.lossGraceDeadline,
            lossTimerActive: this.lossTimer !== null, uncertain: snapshot.uncertain === true });
        const previousState = this.health.state;
        if (snapshot.state !== "ONLINE") this.stabilityEpoch = (this.stabilityEpoch || 0) + 1;
        this.health = snapshot;
        const at = this.monotonicClock();
        if (["OFFLINE", "ERROR"].includes(snapshot.state)) this.timeline = Object.freeze({
            ...this.timeline, lossAt: ["OFFLINE", "ERROR"].includes(previousState)
                ? this.timeline.lossAt : at, offlineAt: at });
        else if (snapshot.state === "CHECKING" &&
            ["OFFLINE", "ERROR"].includes(previousState)) this.timeline = Object.freeze({
            ...this.timeline, retryAt: at });
        else if (snapshot.state === "ONLINE" && previousState !== "ONLINE") this.timeline = Object.freeze({
            ...this.timeline, onlineAt: at });
        if (snapshot.state !== "ONLINE") this.clearStableTimer();
        const confirmedLoss = snapshot.state === "OFFLINE" ||
            !snapshot.sourceHealth && snapshot.state === "ERROR";
        if (confirmedLoss) this.acquisitionEpoch = (this.acquisitionEpoch || 0) + 1;
        if (confirmedLoss || (snapshot.sourceHealth || snapshot.uncertain) && (snapshot.state === "CHECKING" ||
            snapshot.state === "ERROR" && snapshot.uncertain === true)) {
            this.clearStableTimer();
            if (confirmedLoss) this.latched = false;
            this.error = null;
            this.resetAttempt("WAITING");
            if (this.session && this.lossGraceExpired && confirmedLoss) {
                this.endSession("source-loss");
            }
            else if (this.session && this.lossTimer === null && this.getLossGraceDuration() !== null) { const generation = this.generation;
                const lossGraceDuration = this.getLossGraceDuration();
                const lossToken = this.lossToken = (this.lossToken || 0) + 1;
                this.lossGraceDeadline = this.clock() + lossGraceDuration;
                trace.record("autolive", "loss-grace-start", { generation,
                    graceDeadline: this.lossGraceDeadline });
                this.lossTimer = this.setTimer(() => {
                    if (lossToken !== this.lossToken || generation !== this.generation) return;
                    this.lossTimer = null;
                    trace.record("autolive", "loss-grace-expire", { generation,
                        state: this.health.state, sessionActive: Boolean(this.session) });
                    if (generation === this.generation && this.session &&
                        (this.health.state === "OFFLINE" || !this.health.sourceHealth && this.health.state === "ERROR")) {
                        this.endSession("source-loss");
                    }
                    else if (generation === this.generation && this.session &&
                        ["CHECKING", "ERROR"].includes(this.health.state)) {
                        this.lossGraceExpired = true;
                    }
                }, lossGraceDuration); } }
        else if (snapshot.state === "ONLINE") { this.lossToken = (this.lossToken || 0) + 1; if (this.lossTimer !== null) {
            trace.record("autolive", "loss-grace-cancel", { generation: this.generation,
                sourceId: snapshot.sourceId, monitorGeneration: snapshot.generation });
            this.clearTimer(this.lossTimer); this.lossTimer = null; }
            this.lossGraceDeadline = null;
            this.lossGraceExpired = false;
            this.evaluate(); }
        this.emit(); }
    getLossGraceDuration() { return this.lossGraceMs; }
    evaluate() { if (!this.started) return; const setting = this.config.getSnapshot();
        const source = this.getAuthorizedSource();
        if (!setting.armed || !source || this.session || this.pendingSession || this.closingSession || this.latched ||
            !this.schedulerSnapshot?.enabled ||
            Number.isFinite(this.closedHealthGeneration) && this.health.generation <= this.closedHealthGeneration ||
            this.schedulerSnapshot.interruptionContext || this.health.state !== "ONLINE" ||
            this.stableTimer !== null || this.attemptGeneration === this.generation) { this.emit(); return; }
        const generation = this.generation; this.timeline = Object.freeze({
            ...this.timeline, stabilizationAt: this.monotonicClock() });
        trace.record("autolive", "stabilizing", { generation, sourceId: source.id });
        const stabilizationToken = this.stabilizationToken = (this.stabilizationToken || 0) + 1;
        this.stableTimer = this.setTimer(() => {
            if (generation !== this.generation || stabilizationToken !== this.stabilizationToken ||
                this.health.state !== "ONLINE" || !this.started) return;
            this.stableTimer = null; this.acquisitionState = "READY"; this.emit();
            trace.record("autolive", "source-stabilization-complete", { generation, sourceId: source.id });
            void this.begin(source, generation); }, this.prepareOnSourceOnline && this.command.supportsDeferredLiveCommit ? 0 : this.onlineStableMs); this.emit(); }
    async begin(source, generation = this.generation) {
        if (!this.started || generation !== this.generation) return;
        trace.record("autolive", "acquisition-start", { generation, sourceId: source?.id,
            previousSceneId: this.command?.stateManager?.getProgramSceneId?.() });
        this.attemptGeneration = generation; this.acquisitionState = "ACQUIRING";
        this.timeline = Object.freeze({ ...this.timeline, acquisitionAt: this.monotonicClock() });
        const setting = this.config.getSnapshot(); const scheduler = this.scheduler.getSnapshot();
        const resolvedSource = this.getAuthorizedSource(); const target = this.resolveTarget(source);
        const sceneId = target?.sceneId || null;
        const busy = this.command?.transitionCoordinator?.isBusy?.() === true;
        this.attemptDiagnostics = Object.freeze({ healthGeneration: this.health.generation ?? null,
            attemptGeneration: generation, armedAtAttempt: setting.armed === true,
            authorizedSourceIdAtAttempt: setting.authorizedSourceId || null,
            resolvedSourceId: resolvedSource?.id || null, resolvedSceneId: sceneId,
            resolvedTarget: target?.kind || null,
            latchedAtAttempt: this.latched, schedulerEnabled: scheduler?.enabled === true,
            schedulerStatus: scheduler?.status || null, activeItemId: scheduler?.activeItem?.id || null,
            interruptionState: scheduler?.interruptionContext ? "ACTIVE" : "NONE",
            currentProgramSceneId: this.command?.stateManager?.getProgramSceneId?.() || null,
            transitionBusy: busy, beginAttempted: false, beginResult: "NOT_CALLED",
            commandAttempted: false, commandResult: "NOT_CALLED", contextType: null,
            previewReady: false, programCommitted: false,
            blockReason: null });
        this.emit();
        if (busy) {
            this.attemptGeneration = null;
            this.acquisitionState = "WAITING";
            return this.block("TRANSITION_BUSY", { commandResult: "NOT_CALLED" });
        }
        if (generation !== this.generation) return this.block("GENERATION");
        if (!setting.armed) return this.block("ARMED_FALSE");
        if (this.latched) return this.block("LATCHED");
        if (!resolvedSource || resolvedSource.id !== source?.id) return this.block("SOURCE_INVALID");
        if (!sceneId || !this.catalog.getDefinition(sceneId)) return this.block("TARGET_UNAVAILABLE");
        if (!scheduler?.enabled) return this.block("SCHEDULER_DISABLED");
        if (scheduler.interruptionContext) return this.block("EXISTING_INTERRUPTION");
        if (this.health.state !== "ONLINE") return this.block("HEALTH_NOT_ONLINE");
        const eligibility = this.scheduler.getInterruptionEligibility?.({
            origin: "dominant-live", allowEmptySlot: true
        });
        if (eligibility && !eligibility.allowed) return this.block(eligibility.reason || "SCHEDULER_REJECTED");
        const sessionId = this.uuidFactory?.() || `dominant-${this.clock()}`;
        const deferredCommit = this.command.supportsDeferredLiveCommit === true;
        this.updateAttempt({ beginAttempted: !deferredCommit,
            beginResult: deferredCommit ? "DEFERRED_UNTIL_STABLE" : "CALLED" });
        let context;
        try { context = deferredCommit ? null : this.scheduler.beginInterruption({ origin: "dominant-live", sessionId,
            allowEmptySlot: true }); }
        catch (error) { return this.block("BEGIN_THREW", { beginResult: "THREW" }); }
        if (!context && !deferredCommit) return this.block(eligibility?.reason || "BEGIN_RETURNED_NULL",
            { beginResult: "RETURNED_NULL" });
        this.updateAttempt({ beginResult: deferredCommit ? "DEFERRED_UNTIL_STABLE" : "RETURNED_CONTEXT",
            beginResultAt: this.monotonicClock(),
            contextType: context?.kind === "empty-slot" ? "EMPTY_SLOT" : "SCHEDULED_ITEM" });
        let session = Object.freeze({ sessionId, sourceId: source.id, sceneId, deferredCommit,
            origin: "dominant-live", startedAt: this.clock(), schedulerInterruptionContext: context,
            returnTarget: this.captureReturnTarget() });
        this.pendingSession = session; this.emit();
        this.updateAttempt({ commandAttempted: true, commandResult: "CALLED" });
        const acquisitionEpoch = this.acquisitionEpoch || 0;
        let result;
        try { result = await this.command.execute({ sceneId,
            transition: "CUT", origin: "dominant-live",
            livePreroll: { sourceId: source.id, windowMs: this.onlineStableMs,
                getHealthEpoch: () => this.stabilityEpoch || 0 },
            beforeCommit: deferredCommit ? () => {
                const context = this.scheduler.beginInterruption({ origin: "dominant-live", sessionId,
                    allowEmptySlot: true });
                if (!context) { const error = new Error("preroll-interruption-unavailable");
                    error.code = "preroll-interruption-unavailable"; throw error; }
                session = Object.freeze({ ...session, schedulerInterruptionContext: context,
                    returnTarget: Object.freeze({ ...this.captureReturnTarget(),
                        previewSceneId: session.returnTarget?.previewSceneId ?? null }) });
                this.pendingSession = session;
                this.updateAttempt({ beginAttempted: true, beginResult: "RETURNED_CONTEXT",
                    beginResultAt: this.monotonicClock() });
            } : null,
            canCommit: () => this.started && generation === this.generation &&
                acquisitionEpoch === (this.acquisitionEpoch || 0) &&
                this.config.getSnapshot().armed && this.health.state === "ONLINE" }); }
        catch (error) { this.pendingSession = null; void this.finishSession(session, "activation-failed");
            this.error = "command-threw"; this.acquisitionState = "ERROR"; this.latched = true;
            this.lastError = this.error;
            this.updateAttempt({ commandResult: "THREW", blockReason: "COMMAND_THREW" });
            this.emit(); return Object.freeze({ ok: false, reason: "COMMAND_THREW" }); }
        this.pendingSession = null;
        if (generation !== this.generation || !this.config.getSnapshot().armed) {
            void this.finishSession(session, "activation-cancelled"); return this.block(generation !== this.generation
                ? "GENERATION" : "ARMED_FALSE");
        }
        if (!result?.ok && result?.diagnostics?.programCommitted && this.health.sourceHealth) {
            // Once committed, player activation health cannot revoke source ownership.
            trace.record("autolive", "player-activation-degraded", { generation, sourceId: source.id });
            result = { ...result, ok: true };
        }
        if (!result?.ok && result?.diagnostics?.errorCode?.startsWith("preroll-") &&
            result.diagnostics.programCommitted !== true) {
            // The candidate never owned Program. Close its reservation without
            // issuing a return command or publishing an A -> A revision.
            if (session.schedulerInterruptionContext)
                this.scheduler.endInterruption(this.clock(), { reconcile: false });
            this.restorePreview(session.returnTarget?.previewSceneId);
            this.error = null; this.latched = false; this.resetAttempt("WAITING");
            trace.record("autolive", "preroll-retry", { sourceId: source.id, generation,
                reason: result.diagnostics.errorCode });
            this.monitor.refresh?.(); this.emit(); return result;
        }
        if (!result?.ok) { void this.finishSession(session, "activation-failed");
            this.error = result?.reason || "activation-failed";
            this.lastError = this.error;
            this.acquisitionState = "ERROR"; this.latched = true;
            this.updateAttempt({ commandResult: "REJECTED", blockReason: result?.reason || "COMMAND_REJECTED",
                previewReady: result?.diagnostics?.previewReady === true,
                programCommitted: result?.diagnostics?.programCommitted === true });
            this.emit(); return result; }
        this.error = null; this.session = session; this.acquisitionState = "ON_AIR";
        trace.record("autolive", "acquire", { sourceId: source.id, generation });
        this.restorePreview(session.returnTarget?.previewSceneId);
        this.updateAttempt({ commandResult: "SUCCESS", blockReason: null,
            commandResultAt: this.monotonicClock(), onAirAt: this.monotonicClock(),
            previewReady: result?.diagnostics?.previewReady !== false,
            programCommitted: result?.diagnostics?.programCommitted !== false }); this.emit(); return result; }
    block(reason, fields = {}) { this.pendingSession = null; this.acquisitionState = "BLOCKED";
        this.updateAttempt({ ...fields, blockReason: reason,
            errorAt: this.monotonicClock() }); this.emit();
        return Object.freeze({ ok: false, reason }); }
    updateAttempt(fields) { this.attemptDiagnostics = Object.freeze({ ...this.attemptDiagnostics, ...fields }); }
    resetAttempt(state = "WAITING") { this.attemptGeneration = null;
        this.acquisitionState = state; this.attemptDiagnostics = Object.freeze({}); }
    handleProgramChanged(record) {
        trace.record("autolive", "effective-program-transition", {
            sceneId: record?.currentSceneId, previousSceneId: record?.previousSceneId,
            sourceId: this.health.sourceId, sourceState: this.health.state,
            monitorGeneration: this.health.generation, generation: this.generation,
            ownershipState: this.session ? "ACTIVE" : this.pendingSession ? "PENDING" : "NONE",
            acquisitionState: this.acquisitionState, graceDeadline: this.lossGraceDeadline,
            graceExpired: this.lossGraceExpired });
        if (!this.session || record?.source === "dominant-live") return;
        this.latched = true; this.endSession("manual-override"); }
    handlePreviewChanged(record) {
        if (!this.session || record?.source === "dominant-live") return;
        this.session = Object.freeze({ ...this.session,
            returnTarget: Object.freeze({ ...this.session.returnTarget,
                previewSceneId: record?.currentSceneId ?? null }) });
    }
    handleTransitionSnapshot(snapshot) {
        if (!this.started || snapshot?.state !== "idle" || this.session || this.pendingSession ||
            this.health.state !== "ONLINE") return;
        if (this.attemptDiagnostics.blockReason === "TRANSITION_BUSY") {
            this.resetAttempt("WAITING");
            this.evaluate();
        }
    }
    endSession(reason = "ended") { if (!this.session) return false; const session = this.session;
        this.closedHealthGeneration = this.health.generation;
        trace.record("autolive", "session-close", { sourceId: session.sourceId,
            generation: this.generation, reason });
        this.session = null; this.programPlaybackLost = false; ++this.generation;
        this.resetAttempt(reason === "manual-override" ? "WAITING" : "RECOVERING");
        this.clearTimers();
        this.updateAttempt({ endReason: reason, endResult: "PENDING",
            recoveryResult: reason === "manual-override" ? "OPERATOR_OWNS_PROGRAM" : "REQUESTED" });
        void this.finishSession(session, reason);
        if (reason === "source-loss") this.monitor.refresh?.();
        this.emit(); return true; }
    captureReturnTarget() {
        const stateManager = this.command?.stateManager;
        const sceneId = stateManager?.getProgramSceneId?.() || null;
        const previewSceneId = stateManager?.getPreviewSceneId?.() || null;
        const definition = sceneId ? this.catalog?.getDefinition?.(sceneId) : null;
        const sourceId = definition?.renderer?.kind === "source"
            ? definition.renderer.sourceId : null;
        const sourceKind = sourceId ? this.catalog?.getSources?.().find(
            ({ id }) => id === sourceId)?.kind || null : null;
        const transport = this.scheduler?.programTransportProvider?.() || null;
        const cue = ["media", "audio"].includes(sourceKind) &&
            transport?.sourceId === sourceId && Number.isFinite(transport.currentTime) &&
            transport.currentTime >= 0 ? transport.currentTime : null;
        return Object.freeze({ sceneId, previewSceneId, sourceId, sourceKind,
            cueAtInterruption: cue });
    }
    async finishSession(session, reason) {
        if (!session) return false;
        if (session.deferredCommit && !session.schedulerInterruptionContext) {
            if (this.command.stateManager?.getPreviewSceneId?.() === session.sceneId)
                this.restorePreview(session.returnTarget?.previewSceneId);
            return false;
        }
        this.finishedSessions ??= new WeakSet();
        if (this.finishedSessions.has(session)) return false;
        this.finishedSessions.add(session);
        this.closingSession = true;
        const ended = this.scheduler.endInterruption(this.clock(), {
            reconcile: false
        });
        this.updateAttempt({ endReason: reason, endResult: ended ? "CLOSED" : "NO_CONTEXT",
            recoveryResult: reason === "manual-override" ? "OPERATOR_OWNS_PROGRAM" : "REQUESTED" });
        this.emit();
        if (reason === "manual-override") { this.closingSession = false; return true; }
        trace.record("autolive", "restore-start", { generation: this.generation,
            sourceId: session.returnTarget?.sourceId, initialTime: session.returnTarget?.cueAtInterruption });
        const restored = await this.restoreReturnTarget(session.returnTarget);
        trace.record("autolive", "restore-complete", { generation: this.generation,
            state: restored ? "restored" : "fallback" });
        this.updateAttempt({ recoveryResult: restored ? "RESTORED" : "SCHEDULER_FALLBACK" });
        if (!restored && this.scheduler.enabled !== false) {
            void this.scheduler.reconcile?.(true, { releaseWhenEmpty: true });
        }
        this.emit();
        this.closingSession = false;
        this.evaluate();
        return restored;
    }
    setProgramPlaybackLost(sessionId, lost) {
        if (!this.session || this.session.sessionId !== sessionId || this.programPlaybackLost === lost) return;
        this.programPlaybackLost = lost;
        trace.record("autolive", lost ? "program-loss" : "program-recovery", { sourceId: this.session.sourceId });
        this.emit();
    }
    async restoreReturnTarget(target) {
        // Returning is legal only after ownership has been explicitly closed.
        if (this.session || this.lossTimer !== null || this.lossGraceExpired) {
            trace.record("autolive", "restore-blocked-owned");
            return false;
        }
        if (!target?.sceneId) {
            const released = this.command?.release?.({ origin: "dominant-live",
                reason: "dominant-live-return-empty" });
            return released?.ok === true;
        }
        try {
            const result = await this.command.execute({ sceneId: target.sceneId,
                transition: "CUT", origin: "dominant-live",
                initialCueSeconds: target.cueAtInterruption });
            if (result?.ok) this.restorePreview(target.previewSceneId);
            return result?.ok === true;
        }
        catch {
            return false;
        }
    }
    restorePreview(sceneId) {
        const stateManager = this.command?.stateManager;
        const valid = sceneId === null || Boolean(stateManager?.getScene?.(sceneId));
        if (valid && stateManager?.getPreviewSceneId?.() !== sceneId) {
            stateManager.setPreviewScene?.(sceneId, { source: "dominant-live",
                reason: "dominant-live-preview-restore" });
        }
    }
    clearStableTimer() { this.stabilizationToken = (this.stabilizationToken || 0) + 1;
        if (this.stableTimer !== null) this.clearTimer(this.stableTimer); this.stableTimer = null; }
    clearTimers() { this.lossToken = (this.lossToken || 0) + 1; this.clearStableTimer(); if (this.lossTimer !== null) this.clearTimer(this.lossTimer);
        this.lossGraceDeadline = null;
        this.lossTimer = null; this.lossGraceExpired = false; }
    emit() { const snapshot = this.getSnapshot(); this.listeners.forEach((listener) => listener(snapshot)); }
}
