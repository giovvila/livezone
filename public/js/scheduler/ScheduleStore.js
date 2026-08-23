import { createEmptySchedule, validateSchedule } from "./ScheduleContract.js";

const STORAGE_KEY = "livezone.scheduler.schedule.v1";

export default class ScheduleStore {
    constructor({ storage } = {}) {
        this.storage = storage === undefined ? this.getDefaultStorage() : storage;
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
            return result;
        }
        catch {
            return Object.freeze({ ok: false, schedule: null, issues: Object.freeze(["storage-unavailable"]) });
        }
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
        items: schedule.items.map(({ id, title, startMode, behavior, start,
            durationSeconds, sceneId, transition }) => ({
            id, title, startMode, behavior,
            ...(startMode === "ABSOLUTE" ? { start } : {}),
            durationSeconds, sceneId, transition
        }))
    };
}
