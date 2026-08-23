import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import { createEmptySchedule, getActiveItem, getNextBoundary, getNextItem } from "./ScheduleContract.js";

export default class SchedulerEngine {
    constructor({ command, catalog, eventBus = EventBus, clock = () => Date.now(),
        setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
        this.command = command;
        this.catalog = catalog;
        this.eventBus = eventBus;
        this.clock = clock;
        this.setTimer = (callback, delay) => setTimer(callback, delay);
        this.clearTimer = (timerId) => clearTimer(timerId);
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
        this.handleProgramChanged = this.handleProgramChanged.bind(this);
        this.handleTimer = this.handleTimer.bind(this);
        this.eventBus.on(Events.STUDIO_PROGRAM_CHANGED, this.handleProgramChanged);
    }

    setSchedule(schedule) {
        this.schedule = schedule;
        this.attemptedKey = null;
        this.overrideItemId = null;
        this.failure = null;
        if (this.enabled) void this.reconcile(false);
        else this.emit();
    }

    start() {
        if (this.destroyed || this.enabled) return false;
        this.enabled = true;
        void this.reconcile(true);
        return true;
    }

    stop() {
        if (!this.enabled) return false;
        this.enabled = false;
        this.clearBoundaryTimer();
        this.overrideItemId = null;
        this.failure = null;
        this.pendingReconcile = false;
        this.pendingActivation = false;
        this.emit();
        return true;
    }

    destroy() {
        if (this.destroyed) return;
        this.stop();
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
        const activeItem = getActiveItem(this.schedule, now);
        const nextItem = getNextItem(this.schedule, now);
        let status = "OFF";
        if (this.enabled) status = this.failure ? "ERROR"
            : this.overrideItemId === activeItem?.id ? "MANUAL OVERRIDE"
                : activeItem ? "ACTIVE" : "ARMED";
        return Object.freeze({ enabled: this.enabled, status, activeItem, nextItem,
            failure: this.failure, scheduledElapsedSeconds: activeItem
                ? Math.max(0, Math.floor((Number(now) - activeItem.startMs) / 1000)) : 0 });
    }

    async reconcile(allowActivateCurrent = true) {
        if (!this.enabled || this.destroyed) return;
        if (this.reconciling) {
            this.pendingReconcile = true;
            this.pendingActivation ||= allowActivateCurrent;
            return;
        }

        this.reconciling = true;
        this.clearBoundaryTimer();
        try {
            const now = this.clock();
            const active = getActiveItem(this.schedule, now);

            if (this.overrideItemId && this.overrideItemId !== active?.id) this.overrideItemId = null;
            const key = active ? `${active.id}:${active.startMs}` : null;
            if (allowActivateCurrent && active && this.overrideItemId !== active.id &&
                this.attemptedKey !== key) {
                this.attemptedKey = key;
                if (!this.catalog?.getDefinition(active.sceneId)) {
                    this.failure = Object.freeze({ itemId: active.id, reason: "unresolved-scene" });
                }
                else {
                    const result = await this.command.execute({
                        sceneId: active.sceneId, transition: active.transition, origin: "scheduler",
                        scheduledElapsedSeconds: Math.max(0, (now - active.startMs) / 1000)
                    });
                    this.failure = result?.ok ? null : Object.freeze({
                        itemId: active.id, reason: result?.reason || "command-failed"
                    });
                }
            }
        }
        catch {
            const active = getActiveItem(this.schedule, this.clock());
            this.failure = Object.freeze({ itemId: active?.id || null, reason: "command-failed" });
        }
        finally {
            this.reconciling = false;
            this.emit();
            if (!this.enabled || this.destroyed) return;
            if (this.pendingReconcile) {
                const activate = this.pendingActivation;
                this.pendingReconcile = false;
                this.pendingActivation = false;
                void this.reconcile(activate);
            }
            else {
                this.scheduleBoundary();
            }
        }
    }

    handleProgramChanged(record) {
        if (!this.enabled || record?.source === "scheduler") return;
        const active = getActiveItem(this.schedule, this.clock());
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
        const boundary = getNextBoundary(this.schedule, now);
        if (boundary !== null) this.timerId = this.setTimer(this.handleTimer, Math.max(0, boundary - now));
    }

    clearBoundaryTimer() {
        if (this.timerId !== null) this.clearTimer(this.timerId);
        this.timerId = null;
    }

    emit() { const snapshot = this.getSnapshot(); this.listeners.forEach((listener) => listener(snapshot)); }
}
