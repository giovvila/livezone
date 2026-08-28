import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export const ONLINE_STABLE_MS = 3000;
export const LOSS_GRACE_MS = 3000;

export default class DominantLiveController {
    constructor({ config, catalog, monitor, scheduler, command, eventBus = EventBus,
        clock = () => Date.now(), setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout, onlineStableMs = ONLINE_STABLE_MS,
        lossGraceMs = LOSS_GRACE_MS, uuidFactory = () => globalThis.crypto?.randomUUID?.(),
        probeDiagnosticsProvider = () => ({}), monotonicClock = () =>
            globalThis.performance?.now?.() ?? Date.now() } = {}) {
        Object.assign(this, { config, catalog, monitor, scheduler, command, eventBus, clock,
            onlineStableMs, lossGraceMs, uuidFactory });
        this.probeDiagnosticsProvider = typeof probeDiagnosticsProvider === "function"
            ? probeDiagnosticsProvider : () => ({});
        this.monotonicClock = monotonicClock;
        this.setTimer = (callback, delay) => setTimer(callback, delay);
        this.clearTimer = (id) => clearTimer(id); this.listeners = new Set();
        this.generation = 0; this.session = null; this.pendingSession = null; this.latched = false;
        this.stableTimer = null; this.lossTimer = null; this.error = null;
        this.lastError = null;
        this.acquisitionState = "WAITING"; this.attemptGeneration = null;
        this.attemptDiagnostics = Object.freeze({});
        this.timeline = Object.freeze({});
        this.health = Object.freeze({ state: "IDLE", sourceId: null });
        this.schedulerSnapshot = scheduler?.getSnapshot?.() || null;
        this.handleProgramChanged = this.handleProgramChanged.bind(this);
    }
    start() { if (this.started || !this.config || !this.catalog || !this.monitor ||
        !this.scheduler || !this.command) return false; this.started = true;
        this.unsubscribeConfig = this.config.subscribe(() => this.reconcileConfiguration());
        this.unsubscribeCatalog = this.catalog.subscribe(() => this.reconcileConfiguration());
        this.unsubscribeHealth = this.monitor.subscribe((snapshot) => this.handleHealth(snapshot));
        this.unsubscribeScheduler = this.scheduler.subscribe((snapshot) => {
            this.schedulerSnapshot = snapshot; this.evaluate(); });
        this.eventBus.on(Events.STUDIO_PROGRAM_CHANGED, this.handleProgramChanged);
        return true; }
    destroy() { if (!this.started) return; ++this.generation; this.clearTimers();
        this.unsubscribeConfig?.(); this.unsubscribeCatalog?.(); this.unsubscribeHealth?.();
        this.unsubscribeScheduler?.(); this.eventBus.off(Events.STUDIO_PROGRAM_CHANGED,
            this.handleProgramChanged); this.monitor.destroy(); this.listeners.clear(); this.started = false; }
    subscribe(listener) { if (typeof listener !== "function") return () => {};
        this.listeners.add(listener); listener(this.getSnapshot()); return () => this.listeners.delete(listener); }
    refreshDiagnostics() { if (this.started) this.emit(); }
    getSnapshot() { const setting = this.config?.getSnapshot?.() || {};
        const source = this.getAuthorizedSource(); const preflight = this.getPreflightDiagnostics();
        const status = !setting.armed ? "DISARMED"
            : this.session ? (this.lossTimer ? "LOSS GRACE" : "ON AIR")
                : this.pendingSession ? "ACTIVATING"
                : this.acquisitionState === "RECOVERING" ? "RECOVERING"
                : this.acquisitionState === "BLOCKED" ? "ARMED — BLOCKED"
                    : this.error || this.acquisitionState === "ERROR" ? "ERROR"
                    : this.latched ? "ARMED — BLOCKED"
                    : this.acquisitionState === "ACQUIRING" ? "ARMED — ACQUIRING"
                    : this.acquisitionState === "READY" ? "ARMED — READY"
                    : !source ? "NO AUTHORIZED SOURCE"
                    : !this.schedulerSnapshot?.enabled ? "WAITING FOR SCHEDULER"
                    : this.stableTimer ? "ARMED — ONLINE/STABILIZING"
                        : this.health.state === "ONLINE" ? "ARMED — WAITING"
                            : this.health.state === "CHECKING" ? "ARMED — CHECKING"
                                : "ARMED — WAITING";
        return Object.freeze({ armed: setting.armed === true,
            authorizedSourceId: setting.authorizedSourceId || null,
            authorizedSourceName: source?.name || null, health: this.health.state,
            status, session: this.session, diagnostics: Object.freeze({
                ...this.probeDiagnosticsProvider(),
                generation: this.generation,
                healthGeneration: this.health.generation ?? null,
                retryActive: this.health.retryActive === true,
                stableTimerActive: this.stableTimer !== null,
                lossTimerActive: this.lossTimer !== null,
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
        const sceneId = source?.sceneIds?.[0] || null; let waitingReason = null;
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
            resolvedSceneId: sceneId, schedulerEnabled: scheduler?.enabled === true,
            schedulerStatus: scheduler?.status || null,
            activeItemId: scheduler?.activeItem?.id || null,
            interruptionState: scheduler?.interruptionContext ? "ACTIVE" : "NONE",
            currentProgramSceneId: this.command?.stateManager?.getProgramSceneId?.() || null,
            transitionBusy: this.command?.transitionCoordinator?.isBusy?.() === true,
            beginAttempted: false, beginResult: "NOT_CALLED", commandAttempted: false,
            commandResult: "NOT_CALLED", waitingReason }); }
    reconcileConfiguration() { if (!this.started) return; const setting = this.config.getSnapshot();
        const source = this.getAuthorizedSource(); const fingerprint = source
            ? `${source.id}:${source.enabled}:${source.url}` : null;
        if (setting.authorizedSourceId && (!source || source.enabled === false)) {
            this.config.setAuthorizedSourceId(null); return;
        }
        if (fingerprint !== this.sourceFingerprint) { ++this.generation; this.clearTimers();
            this.resetAttempt("WAITING");
            this.sourceFingerprint = fingerprint; this.health = Object.freeze({ state: "IDLE", sourceId: null });
            if (this.session) this.endSession("source-changed");
            source ? this.monitor.selectSource(source) : this.monitor.stop(); }
        if (!setting.armed) { this.latched = false; this.clearStableTimer(); this.resetAttempt("WAITING");
            if (this.pendingSession) { this.pendingSession = null;
                this.scheduler.endInterruption(this.clock()); }
            if (this.session) this.endSession("disarmed"); }
        this.evaluate(); }
    getAuthorizedSource() { const id = this.config?.getSnapshot?.().authorizedSourceId;
        return this.catalog?.getSources?.().find((source) => source.id === id &&
            source.kind === "hls" && source.enabled !== false) || null; }
    handleHealth(snapshot) { if (!this.started || snapshot.sourceId !== this.getAuthorizedSource()?.id) return;
        const previousState = this.health.state;
        this.health = snapshot;
        const at = this.monotonicClock();
        if (["OFFLINE", "ERROR"].includes(snapshot.state)) this.timeline = Object.freeze({
            ...this.timeline, lossAt: ["OFFLINE", "ERROR"].includes(previousState)
                ? this.timeline.lossAt : at, offlineAt: at });
        else if (snapshot.state === "CHECKING" &&
            ["OFFLINE", "ERROR"].includes(previousState)) this.timeline = Object.freeze({
            ...this.timeline, retryAt: at });
        else if (snapshot.state === "ONLINE") this.timeline = Object.freeze({
            ...this.timeline, onlineAt: at });
        if (["OFFLINE", "ERROR"].includes(snapshot.state)) { this.clearStableTimer(); this.latched = false;
            this.error = null;
            this.resetAttempt("WAITING");
            if (this.session && this.lossTimer === null) { const generation = this.generation;
                this.lossTimer = this.setTimer(() => { this.lossTimer = null;
                    if (generation === this.generation && this.session &&
                        ["OFFLINE", "ERROR"].includes(this.health.state)) this.endSession("source-loss");
                }, this.lossGraceMs); } }
        else if (snapshot.state === "ONLINE") { if (this.lossTimer !== null) {
            this.clearTimer(this.lossTimer); this.lossTimer = null; }
            this.evaluate(); }
        this.emit(); }
    evaluate() { if (!this.started) return; const setting = this.config.getSnapshot();
        const source = this.getAuthorizedSource();
        if (!setting.armed || !source || this.session || this.pendingSession || this.latched ||
            !this.schedulerSnapshot?.enabled ||
            this.schedulerSnapshot.interruptionContext || this.health.state !== "ONLINE" ||
            this.stableTimer !== null || this.attemptGeneration === this.generation) { this.emit(); return; }
        const generation = this.generation; this.timeline = Object.freeze({
            ...this.timeline, stabilizationAt: this.monotonicClock() });
        this.stableTimer = this.setTimer(() => {
            this.stableTimer = null; this.acquisitionState = "READY"; this.emit();
            void this.begin(source, generation); }, this.onlineStableMs); this.emit(); }
    async begin(source, generation = this.generation) {
        this.attemptGeneration = generation; this.acquisitionState = "ACQUIRING";
        this.timeline = Object.freeze({ ...this.timeline, acquisitionAt: this.monotonicClock() });
        const setting = this.config.getSnapshot(); const scheduler = this.scheduler.getSnapshot();
        const resolvedSource = this.getAuthorizedSource(); const sceneId = source?.sceneIds?.[0] || null;
        const busy = this.command?.transitionCoordinator?.isBusy?.() === true;
        this.attemptDiagnostics = Object.freeze({ healthGeneration: this.health.generation ?? null,
            attemptGeneration: generation, armedAtAttempt: setting.armed === true,
            authorizedSourceIdAtAttempt: setting.authorizedSourceId || null,
            resolvedSourceId: resolvedSource?.id || null, resolvedSceneId: sceneId,
            latchedAtAttempt: this.latched, schedulerEnabled: scheduler?.enabled === true,
            schedulerStatus: scheduler?.status || null, activeItemId: scheduler?.activeItem?.id || null,
            interruptionState: scheduler?.interruptionContext ? "ACTIVE" : "NONE",
            currentProgramSceneId: this.command?.stateManager?.getProgramSceneId?.() || null,
            transitionBusy: busy, beginAttempted: false, beginResult: "NOT_CALLED",
            commandAttempted: false, commandResult: "NOT_CALLED", contextType: null,
            previewReady: false, programCommitted: false,
            blockReason: null });
        this.emit();
        if (generation !== this.generation) return this.block("GENERATION");
        if (!setting.armed) return this.block("ARMED_FALSE");
        if (this.latched) return this.block("LATCHED");
        if (!resolvedSource || resolvedSource.id !== source?.id) return this.block("SOURCE_INVALID");
        if (!sceneId || !this.catalog.getDefinition(sceneId)) return this.block("SCENE_MISSING");
        if (!scheduler?.enabled) return this.block("SCHEDULER_DISABLED");
        if (scheduler.interruptionContext) return this.block("EXISTING_INTERRUPTION");
        const eligibility = this.scheduler.getInterruptionEligibility?.({
            origin: "dominant-live", allowEmptySlot: true
        });
        if (eligibility && !eligibility.allowed) return this.block(eligibility.reason || "SCHEDULER_REJECTED");
        const sessionId = this.uuidFactory?.() || `dominant-${this.clock()}`;
        this.updateAttempt({ beginAttempted: true, beginResult: "CALLED" });
        let context;
        try { context = this.scheduler.beginInterruption({ origin: "dominant-live", sessionId,
            allowEmptySlot: true }); }
        catch (error) { return this.block("BEGIN_THREW", { beginResult: "THREW" }); }
        if (!context) return this.block(eligibility?.reason || "BEGIN_RETURNED_NULL",
            { beginResult: "RETURNED_NULL" });
        this.updateAttempt({ beginResult: "RETURNED_CONTEXT",
            beginResultAt: this.monotonicClock(),
            contextType: context.kind === "empty-slot" ? "EMPTY_SLOT" : "SCHEDULED_ITEM" });
        const session = Object.freeze({ sessionId, sourceId: source.id, sceneId,
            origin: "dominant-live", startedAt: this.clock(), schedulerInterruptionContext: context });
        this.pendingSession = session; this.emit();
        this.updateAttempt({ commandAttempted: true, commandResult: "CALLED" });
        let result;
        try { result = await this.command.execute({ sceneId, transition: "CUT", origin: "dominant-live" }); }
        catch (error) { this.pendingSession = null; this.scheduler.endInterruption(this.clock());
            this.error = "command-threw"; this.acquisitionState = "ERROR"; this.latched = true;
            this.lastError = this.error;
            this.updateAttempt({ commandResult: "THREW", blockReason: "COMMAND_THREW" });
            this.emit(); return Object.freeze({ ok: false, reason: "COMMAND_THREW" }); }
        this.pendingSession = null;
        if (generation !== this.generation || !this.config.getSnapshot().armed) {
            this.scheduler.endInterruption(this.clock()); return this.block(generation !== this.generation
                ? "GENERATION" : "ARMED_FALSE");
        }
        if (!result?.ok) { this.scheduler.endInterruption(this.clock()); this.error = result?.reason || "activation-failed";
            this.lastError = this.error;
            this.acquisitionState = "ERROR"; this.latched = true;
            this.updateAttempt({ commandResult: "REJECTED", blockReason: result?.reason || "COMMAND_REJECTED",
                previewReady: result?.diagnostics?.previewReady === true,
                programCommitted: result?.diagnostics?.programCommitted === true });
            this.emit(); return result; }
        this.error = null; this.session = session; this.acquisitionState = "ON_AIR";
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
    handleProgramChanged(record) { if (!this.session || record?.source === "dominant-live") return;
        this.latched = true; this.endSession("manual-override"); }
    endSession(reason = "ended") { if (!this.session) return false; this.session = null; ++this.generation;
        this.resetAttempt(reason === "manual-override" ? "WAITING" : "RECOVERING");
        this.clearTimers(); const ended = this.scheduler.endInterruption(this.clock(), {
            reconcile: reason !== "manual-override"
        });
        this.updateAttempt({ endReason: reason, endResult: ended ? "CLOSED" : "NO_CONTEXT",
            recoveryResult: reason === "manual-override" ? "OPERATOR_OWNS_PROGRAM" : "REQUESTED" });
        this.emit(); return true; }
    clearStableTimer() { if (this.stableTimer !== null) this.clearTimer(this.stableTimer); this.stableTimer = null; }
    clearTimers() { this.clearStableTimer(); if (this.lossTimer !== null) this.clearTimer(this.lossTimer); this.lossTimer = null; }
    emit() { const snapshot = this.getSnapshot(); this.listeners.forEach((listener) => listener(snapshot)); }
}
