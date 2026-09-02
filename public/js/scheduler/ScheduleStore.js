import { createEmptySchedule, validateSchedule } from "./ScheduleContract.js";

const STORAGE_KEY = "livezone.scheduler.schedule.v1";

export default class ScheduleStore {
    constructor({ storage, eventTarget = globalThis.window } = {}) {
        this.storage = storage === undefined ? this.getDefaultStorage() : storage;
        this.eventTarget = eventTarget;
        this.listeners = new Set();
        this.handleStorage = this.handleStorage.bind(this);
        this.listening = false;
    }

    load() {
        try {
            const raw = this.storage?.getItem(STORAGE_KEY);
            if (!raw) return Object.freeze({ schedule: createEmptySchedule(), issues: Object.freeze([]) });
            const result = validateSchedule(JSON.parse(raw));
            return result.ok
                ? Object.freeze({ schedule: result.schedule, issues: Object.freeze([]) })
                : Object.freeze({ schedule: createEmptySchedule(), issues: result.issues });
        }
        catch {
            return Object.freeze({ schedule: createEmptySchedule(), issues: Object.freeze(["storage-invalid"]) });
        }
    }

    save(schedule) {
        const result = validateSchedule(serialize(schedule));
        if (!result.ok) return result;
        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify(serialize(result.schedule)));
            this.emit(result.schedule);
            return result;
        }
        catch {
            return Object.freeze({ ok: false, schedule: null, issues: Object.freeze(["storage-unavailable"]) });
        }
    }

    getSnapshot() { return this.load(); }

    subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        this.listeners.add(listener);
        if (!this.listening && this.eventTarget?.addEventListener) {
            this.eventTarget.addEventListener("storage", this.handleStorage);
            this.listening = true;
        }
        listener(this.load());
        return () => {
            this.listeners.delete(listener);
            if (!this.listeners.size && this.listening) {
                this.eventTarget?.removeEventListener?.("storage", this.handleStorage);
                this.listening = false;
            }
        };
    }

    handleStorage(event) {
        if (event?.key !== STORAGE_KEY ||
            (event.storageArea && event.storageArea !== this.storage)) return;
        const loaded = this.load();
        this.listeners.forEach((listener) => listener(loaded));
    }

    emit(schedule) {
        const snapshot = Object.freeze({ schedule, issues: Object.freeze([]) });
        this.listeners.forEach((listener) => listener(snapshot));
    }

    getDefaultStorage() {
        try { return globalThis.localStorage; }
        catch { return null; }
    }
}

function serialize(schedule) {
    return {
        version: schedule.version,
        timezone: schedule.timezone,
        items: schedule.items.map((item) => ({
            id: item.id, title: item.title, startMode: item.startMode,
            behavior: item.behavior, resumePolicy: item.resumePolicy,
            ...(item.startMode === "ABSOLUTE" ? { start: item.start } : {}),
            durationSeconds: item.durationSeconds,
            ...(Object.hasOwn(item, "sceneId")
                ? { sceneId: item.sceneId }
                : { target: { kind: item.target.kind, id: item.target.id } }),
            transition: item.transition
        }))
    };
}
