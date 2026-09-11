const CONTEXT = ["origin", "storageKey", "schemaVersion", "instanceId", "storageAvailable", "armed", "authorizedSourceId"];
const FIELDS = {
    AUTOLIVE_AUTH_WRITE: [...CONTEXT, "sourceId", "sourceKind", "ok", "reason", "requestedArmed",
        "requestedSourceId", "writeSucceeded", "readBackSucceeded"],
    AUTOLIVE_AUTH_READ: [...CONTEXT, "phase", "storedArmed", "readSucceeded", "storedSourceId",
        "normalizedSourceId", "catalogMatch", "finalAuthorizedSourceId"],
    AUTOLIVE_AUTH_CONTROLLER: [...CONTEXT, "state", "reason"]
};

export class AutoLiveAuthorizationDiagnostics {
    constructor({ enabled = typeof globalThis.window !== "undefined", capacity = 100,
        output = (event, fields) => console.info(event, fields) } = {}) {
        this.enabled = enabled; this.output = output;
        this.capacity = Math.max(1, Math.min(100, capacity)); this.count = 0;
        this.previous = new Map();
    }
    record(event, fields) {
        if (!this.enabled || !FIELDS[event] || this.count >= this.capacity) return;
        try {
            const safe = {};
            for (const key of FIELDS[event]) {
                const value = fields[key];
                if (key === "origin") {
                    const url = typeof value === "string" ? new URL(value) : null;
                    safe[key] = url && ["http:", "https:"].includes(url.protocol) &&
                        url.origin === value && value.length <= 200 ? value : null;
                    continue;
                }
                safe[key] = value === null || typeof value === "boolean" ||
                    key === "schemaVersion" && value === 1 ? value
                    : typeof value === "string" && /^[a-zA-Z0-9_ .—-]{1,120}$/.test(value)
                        ? value : null;
            }
            const fingerprint = JSON.stringify(safe);
            if (this.previous.get(event) === fingerprint) return;
            this.previous.set(event, fingerprint); ++this.count;
            this.output(event, Object.freeze(safe));
        } catch { /* Diagnostics cannot interrupt authorization. */ }
    }
}

export default new AutoLiveAuthorizationDiagnostics();
