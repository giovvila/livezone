import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export default class ProgramRemainingTimeUI {
    constructor({ root, schedulerEngine, renderer, stateManager,
        eventBus = EventBus, clock = () => Date.now(),
        setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
        this.root = root;
        this.schedulerEngine = schedulerEngine;
        this.renderer = renderer;
        this.stateManager = stateManager;
        this.eventBus = eventBus;
        this.clock = clock;
        this.setTimer = (callback, delay) => setTimer(callback, delay);
        this.clearTimer = (id) => clearTimer(id);
        this.transport = null;
        this.timerId = null;
        this.started = false;
        this.handleUpdate = this.handleUpdate.bind(this);
        this.handleTick = this.handleTick.bind(this);
        this.handleTransport = this.handleTransport.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.schedulerEngine ||
            !this.renderer || !this.stateManager) return false;
        this.label = this.root.querySelector("#program-remaining-label");
        this.output = this.root.querySelector("#program-remaining-time");
        if (!this.label || !this.output) return false;
        this.started = true;
        this.unsubscribeScheduler = this.schedulerEngine.subscribe(this.handleUpdate);
        this.unsubscribeTransport = this.renderer.subscribeProgramTransport(
            this.handleTransport);
        this.eventBus.on(Events.STUDIO_PROGRAM_CHANGED, this.handleUpdate);
        this.handleUpdate();
        this.armTick();
        return true;
    }

    destroy() {
        if (!this.started) return;
        if (this.timerId !== null) this.clearTimer(this.timerId);
        this.timerId = null;
        this.unsubscribeScheduler?.();
        this.unsubscribeTransport?.();
        this.eventBus.off(Events.STUDIO_PROGRAM_CHANGED, this.handleUpdate);
        this.unsubscribeScheduler = null;
        this.unsubscribeTransport = null;
        this.transport = null;
        this.started = false;
    }

    handleTransport(snapshot) {
        this.transport = snapshot;
        this.handleUpdate();
    }

    handleUpdate() {
        if (!this.started) return;
        const now = this.clock();
        const result = calculateProgramRemaining({
            now,
            schedulerAuthority: this.schedulerEngine.getCurrentEffectiveAuthority(now),
            programSceneId: this.stateManager.getProgramSceneId(),
            transport: this.transport
        });
        this.label.textContent = result.label;
        this.output.textContent = formatRemainingSeconds(result.remainingSeconds);
    }

    handleTick() {
        this.timerId = null;
        if (!this.started) return;
        this.handleUpdate();
        this.armTick();
    }

    armTick() {
        if (this.started && this.timerId === null) {
            this.timerId = this.setTimer(this.handleTick, 1000);
        }
    }
}

export function calculateProgramRemaining({ now = Date.now(), schedulerAuthority,
    programSceneId, transport } = {}) {
    if (schedulerAuthority?.mode === "manual-override" &&
        Number.isFinite(schedulerAuthority.effectiveEnd)) {
        return result("NEXT TAKE", schedulerAuthority.effectiveEnd - Number(now));
    }
    if (schedulerAuthority?.mode === "scheduled" &&
        schedulerAuthority.sceneId === programSceneId &&
        Number.isFinite(schedulerAuthority.effectiveEnd)) {
        return result("SCHEDULE", schedulerAuthority.effectiveEnd - Number(now));
    }
    if (transport?.ended === true || transport?.state === "ended") {
        return Object.freeze({ label: "SOURCE", remainingSeconds: 0 });
    }
    if (Number.isFinite(transport?.duration) && transport.duration >= 0 &&
        Number.isFinite(transport?.currentTime) && transport.currentTime >= 0) {
        return Object.freeze({ label: "SOURCE", remainingSeconds:
            Math.max(0, Math.ceil(transport.duration - transport.currentTime)) });
    }
    return Object.freeze({ label: "TEMPO RESIDUO", remainingSeconds: null });
}

export function formatRemainingSeconds(value) {
    if (!Number.isFinite(value) || value < 0) return "--:--:--";
    const seconds = Math.floor(value);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return [hours, minutes, seconds % 60]
        .map((part) => String(part).padStart(2, "0")).join(":");
}

function result(label, remainingMs) {
    return Object.freeze({ label, remainingSeconds:
        Math.max(0, Math.ceil(remainingMs / 1000)) });
}
