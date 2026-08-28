export const SCHEDULER_RUNTIME_STORAGE_KEY = "livezone.scheduler.runtime.v1";
const VERSION = 1;

export default class SchedulerRuntimeState {
    constructor({ storage } = {}) {
        this.storage = storage === undefined ? this.getDefaultStorage() : storage;
    }

    load() {
        try {
            const value = JSON.parse(this.storage?.getItem(
                SCHEDULER_RUNTIME_STORAGE_KEY
            ) || "null");
            return value?.version === VERSION && typeof value.enabled === "boolean"
                ? Object.freeze({ version: VERSION, enabled: value.enabled })
                : this.safeDefault();
        }
        catch {
            return this.safeDefault();
        }
    }

    save(enabled) {
        const snapshot = Object.freeze({ version: VERSION, enabled: enabled === true });
        try {
            this.storage?.setItem(SCHEDULER_RUNTIME_STORAGE_KEY, JSON.stringify(snapshot));
        }
        catch {
            // Scheduler runtime remains authoritative when persistence is unavailable.
        }
        return snapshot;
    }

    safeDefault() {
        return Object.freeze({ version: VERSION, enabled: false });
    }

    getDefaultStorage() {
        try {
            return globalThis.localStorage;
        }
        catch {
            return null;
        }
    }
}
