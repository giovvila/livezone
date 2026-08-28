import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import { createEmptySchedule, getActiveInterruptItem, getActiveItem,
    getActiveNormalItem, getNextBoundary, getNextItem } from "./ScheduleContract.js";
import { applyInterruptionShift, calculateEffectiveSchedule,
    RESUME_POLICIES } from "./ScheduleClock.js";

export default class SchedulerEngine {
    constructor({ command, catalog, eventBus = EventBus, clock = () => Date.now(),
        setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
        programTransportProvider = null, runtimeState = null } = {}) {
        this.command = command;
        this.catalog = catalog;
        this.eventBus = eventBus;
        this.clock = clock;
        this.setTimer = (callback, delay) => setTimer(callback, delay);
        this.clearTimer = (timerId) => clearTimer(timerId);
        this.programTransportProvider = typeof programTransportProvider === "function"
            ? programTransportProvider : () => null;
        this.runtimeState = runtimeState;
        this.schedule = createEmptySchedule();
        this.listeners = new Set();
        this.enabled = false;
        this.destroyed = false;
        this.timerId = null;
        this.attemptedKey = null;
        this.overrideItemId = null;
        this.failure = null;
        this.reconciling = false;
        this.pendingReconcile = false;
        this.pendingActivation = false;
        this.pendingReleaseWhenEmpty = false;
        this.runtimeShiftMs = new Map();
        this.interruptionContext = null;
        this.resumeCues = new Map();
        this.resumingItemId = null;
        this.handleProgramChanged = this.handleProgramChanged.bind(this);
        this.handleTimer = this.handleTimer.bind(this);
        this.eventBus.on(Events.STUDIO_PROGRAM_CHANGED, this.handleProgramChanged);
    }

    setSchedule(schedule) {
        const emptySlotContext = this.interruptionContext?.kind === "empty-slot"
            ? this.interruptionContext : null;
        this.schedule = schedule;
        this.attemptedKey = null;
        this.overrideItemId = null;
        this.failure = null;
        this.runtimeShiftMs.clear();
        this.interruptionContext = emptySlotContext;
        this.resumeCues.clear();
        this.resumingItemId = null;
        if (this.enabled) void this.reconcile(false);
        else this.emit();
    }

    restoreEnabledState() {
        return this.runtimeState?.load?.().enabled === true
            ? this.start({ persist: false })
            : false;
    }

    start({ persist = true } = {}) {
        if (this.destroyed || this.enabled) return false;
        this.enabled = true;
        if (persist) this.runtimeState?.save?.(true);
        void this.reconcile(true);
        return true;
    }

    stop({ persist = true } = {}) {
        if (!this.enabled) return false;
        this.enabled = false;
        if (persist) this.runtimeState?.save?.(false);
        this.clearBoundaryTimer();
        this.overrideItemId = null;
        this.failure = null;
        this.pendingReconcile = false;
        this.pendingActivation = false;
        this.pendingReleaseWhenEmpty = false;
        this.interruptionContext = null;
        this.resumeCues.clear();
        this.resumingItemId = null;
        this.emit();
        return true;
    }

    destroy() {
        if (this.destroyed) return;
        this.stop({ persist: false });
        this.eventBus.off(Events.STUDIO_PROGRAM_CHANGED, this.handleProgramChanged);
        this.listeners.clear();
        this.destroyed = true;
    }

    subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    getSnapshot(now = this.clock()) {
        const effectiveSchedule = this.getEffectiveSchedule();
        const activeItem = getActiveItem(effectiveSchedule, now);
        const nextItem = getNextItem(effectiveSchedule, now);
        let status = "OFF";
        if (this.enabled) status = this.failure ? "ERROR"
            : this.resumingItemId ? "RESUMING"
                : this.interruptionContext ? "INTERRUPTED"
            : this.overrideItemId === activeItem?.id ? "MANUAL OVERRIDE"
                : activeItem ? "ACTIVE" : "ARMED";
        return Object.freeze({ enabled: this.enabled, status, activeItem, nextItem,
            failure: this.failure, interruptionContext: this.interruptionContext,
            scheduledElapsedSeconds: activeItem
                ? Math.max(0, Math.floor((Number(now) - activeItem.startMs) / 1000)) : 0 });
    }

    getEffectiveSchedule() {
        return calculateEffectiveSchedule(this.schedule, this.runtimeShiftMs);
    }

    getCurrentEffectiveAuthority(now = this.clock()) {
        if (!this.enabled) return Object.freeze({ mode: "none", item: null,
            sceneId: null, effectiveStart: null, effectiveEnd: null });
        const effectiveSchedule = this.getEffectiveSchedule();
        const active = getActiveItem(effectiveSchedule, now);
        if (this.overrideItemId && this.overrideItemId === active?.id) {
            const boundary = getNextBoundary(effectiveSchedule, now);
            return Object.freeze({ mode: "manual-override", item: null,
                sceneId: null, effectiveStart: null,
                effectiveEnd: Number.isFinite(boundary) ? boundary : null });
        }
        if (!active || active.skipped) return Object.freeze({ mode: "none",
            item: null, sceneId: null, effectiveStart: null, effectiveEnd: null });
        return Object.freeze({ mode: "scheduled", item: active,
            sceneId: active.sceneId, effectiveStart: active.startMs,
            effectiveEnd: active.endMs });
    }

    getInterruptionEligibility({ now = this.clock(), allowEmptySlot = false } = {}) {
        const snapshot = this.getSnapshot(now);
        if (this.interruptionContext) return Object.freeze({ allowed: false,
            reason: "EXISTING_INTERRUPTION", activeItemId: snapshot.activeItem?.id || null,
            status: snapshot.status });
        const interruptedItem = getActiveNormalItem(this.getEffectiveSchedule(), now);
        if (!interruptedItem) return allowEmptySlot
            ? Object.freeze({ allowed: true, reason: null, mode: "EMPTY_SLOT",
                activeItemId: null, status: snapshot.status })
            : Object.freeze({ allowed: false, reason: "NO_ACTIVE_ITEM",
                activeItemId: snapshot.activeItem?.id || null, status: snapshot.status });
        return Object.freeze({ allowed: true, reason: null,
            mode: "SCHEDULED_ITEM", activeItemId: interruptedItem.id, status: snapshot.status });
    }

    beginInterruption({ now = this.clock(), interruptionItem = null,
        origin = interruptionItem ? "scheduler" : "external", sessionId = null,
        allowEmptySlot = false } = {}) {
        if (this.interruptionContext) return null;
        const effectiveSchedule = this.getEffectiveSchedule();
        const interruptedItem = getActiveNormalItem(effectiveSchedule, now);
        if (!interruptedItem && !allowEmptySlot) return null;
        if (!interruptedItem) {
            this.interruptionContext = Object.freeze({ interruptedItemId: null,
                sceneId: null, sourceId: null, sourceKind: null, interruptionItemId: null,
                kind: "empty-slot", origin, sessionId, interruptedAt: Number(now),
                cueAtInterruption: null, scheduledStart: null, scheduledEnd: null,
                resumePolicy: null });
            this.emit(); return this.interruptionContext;
        }
        const transport = this.programTransportProvider() || null;
        const definition = this.catalog?.getDefinition(interruptedItem.sceneId);
        const sourceId = definition?.renderer?.kind === "source"
            ? definition.renderer.sourceId : null;
        const sourceKind = sourceId ? this.catalog.getSources?.().find(({ id }) =>
            id === sourceId)?.kind || null : null;
        const cue = ["media", "audio"].includes(sourceKind) &&
            transport?.sourceId === sourceId && Number.isFinite(transport.currentTime) &&
            transport.currentTime >= 0 ? transport.currentTime : null;
        this.interruptionContext = Object.freeze({
            interruptedItemId: interruptedItem.id,
            sceneId: interruptedItem.sceneId,
            sourceId,
            sourceKind,
            interruptionItemId: interruptionItem?.id || null,
            kind: interruptionItem ? "scheduled" : "external",
            origin,
            sessionId,
            interruptedAt: Number(now),
            cueAtInterruption: cue,
            scheduledStart: interruptedItem.startMs,
            scheduledEnd: interruptedItem.endMs,
            resumePolicy: interruptedItem.resumePolicy
        });
        this.emit();
        return this.interruptionContext;
    }

    endInterruption(now = this.clock(), { reconcile = true } = {}) {
        const context = this.interruptionContext;
        if (!context) return null;
        const endedAt = Number(now);
        const durationMs = Math.max(0, endedAt - context.interruptedAt);
        if (context.resumePolicy === RESUME_POLICIES.SHIFT) {
            this.runtimeShiftMs = applyInterruptionShift(
                this.runtimeShiftMs, context.interruptedItemId, durationMs);
        }
        const recoveryActive = getActiveItem(this.getEffectiveSchedule(), endedAt);
        if (Number.isFinite(context.cueAtInterruption) &&
            recoveryActive?.id === context.interruptedItemId) {
            this.resumeCues.set(context.interruptedItemId, context.cueAtInterruption);
        }
        else if (context.interruptedItemId) {
            this.resumeCues.delete(context.interruptedItemId);
        }
        this.interruptionContext = null;
        this.attemptedKey = null;
        if (reconcile && this.enabled) void this.reconcile(true, { releaseWhenEmpty: true });
        else this.emit();
        return Object.freeze({ ...context, endedAt, durationMs });
    }

    async reconcile(allowActivateCurrent = true, { releaseWhenEmpty = false } = {}) {
        if (!this.enabled || this.destroyed) return;
        if (this.reconciling) {
            this.pendingReconcile = true;
            this.pendingActivation ||= allowActivateCurrent;
            this.pendingReleaseWhenEmpty ||= releaseWhenEmpty;
            return;
        }

        this.reconciling = true;
        this.clearBoundaryTimer();
        try {
            const now = this.clock();
            let effectiveSchedule = this.getEffectiveSchedule();
            const activeInterrupt = getActiveInterruptItem(effectiveSchedule, now);
            if (activeInterrupt && !this.interruptionContext) {
                this.beginInterruption({ now, interruptionItem: activeInterrupt });
            }
            let endedInterruption = null;
            if (!activeInterrupt && this.interruptionContext?.kind === "scheduled") {
                endedInterruption = this.endInterruption(now, { reconcile: false });
                effectiveSchedule = this.getEffectiveSchedule();
            }
            const active = getActiveItem(effectiveSchedule, now);

            if (endedInterruption && active?.id !== endedInterruption.interruptedItemId) {
                this.resumeCues.delete(endedInterruption.interruptedItemId);
            }

            if (["external", "empty-slot"].includes(this.interruptionContext?.kind)) return;

            if (this.overrideItemId && this.overrideItemId !== active?.id) this.overrideItemId = null;
            const key = active ? `${active.id}:${active.startMs}` : null;
            if (allowActivateCurrent && !active && releaseWhenEmpty) {
                const result = this.command.release?.({ origin: "scheduler",
                    reason: "interruption-ended-empty-slot" });
                this.failure = result?.ok ? null : Object.freeze({ itemId: null,
                    reason: result?.reason || "program-release-failed" });
            }
            if (allowActivateCurrent && active && this.overrideItemId !== active.id &&
                this.attemptedKey !== key) {
                this.attemptedKey = key;
                if (!this.catalog?.getDefinition(active.sceneId)) {
                    this.failure = Object.freeze({ itemId: active.id, reason: "unresolved-scene" });
                }
                else {
                    const resumeCue = this.resumeCues.get(active.id);
                    const scheduledElapsedSeconds = Math.max(0, (now - active.startMs) / 1000);
                    this.resumingItemId = Number.isFinite(resumeCue) ? active.id : null;
                    if (this.resumingItemId) this.emit();
                    const result = await this.command.execute({
                        sceneId: active.sceneId, transition: active.transition, origin: "scheduler",
                        scheduledElapsedSeconds,
                        initialCueSeconds: Number.isFinite(resumeCue)
                            ? resumeCue : scheduledElapsedSeconds
                    });
                    if (result?.ok) this.resumeCues.delete(active.id);
                    this.resumingItemId = null;
                    this.failure = result?.ok ? null : Object.freeze({
                        itemId: active.id, reason: result?.reason || "command-failed"
                    });
                }
            }
        }
        catch {
            this.resumingItemId = null;
            const active = getActiveItem(this.schedule, this.clock());
            this.failure = Object.freeze({ itemId: active?.id || null, reason: "command-failed" });
        }
        finally {
            this.reconciling = false;
            this.emit();
            if (!this.enabled || this.destroyed) return;
            if (this.pendingReconcile) {
                const activate = this.pendingActivation;
                const release = this.pendingReleaseWhenEmpty;
                this.pendingReconcile = false;
                this.pendingActivation = false;
                this.pendingReleaseWhenEmpty = false;
                void this.reconcile(activate, { releaseWhenEmpty: release });
            }
            else {
                this.scheduleBoundary();
            }
        }
    }

    handleProgramChanged(record) {
        if (!this.enabled || record?.source === "scheduler" ||
            record?.source === this.interruptionContext?.origin) return;
        const active = getActiveItem(this.getEffectiveSchedule(), this.clock());
        if (active) {
            this.overrideItemId = active.id;
            this.failure = null;
            this.emit();
        }
    }

    handleTimer() { this.timerId = null; void this.reconcile(true); }

    scheduleBoundary() {
        if (!this.enabled || this.timerId !== null) return;
        const now = this.clock();
        const boundary = getNextBoundary(this.getEffectiveSchedule(), now);
        if (boundary !== null) this.timerId = this.setTimer(this.handleTimer, Math.max(0, boundary - now));
    }

    clearBoundaryTimer() {
        if (this.timerId !== null) this.clearTimer(this.timerId);
        this.timerId = null;
    }

    emit() { const snapshot = this.getSnapshot(); this.listeners.forEach((listener) => listener(snapshot)); }
}
