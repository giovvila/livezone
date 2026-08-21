import { validateProgramOutputEnvelope } from
    "../../public/js/program-output/ProgramOutputEnvelope.js";

const MAX_RETIRED_SESSIONS = 100;

export default class ProgramOutputStore {
    constructor() {
        this.current = null;
        this.retiredSessions = new Set();
        this.listeners = new Set();
    }

    accept(candidate) {
        const envelope = validateProgramOutputEnvelope(candidate);
        if (!envelope) return Object.freeze({ accepted: false, reason: "invalid" });
        if (this.retiredSessions.has(envelope.publisherSessionId)) {
            return Object.freeze({ accepted: false, reason: "retired-session" });
        }
        if (this.current?.publisherSessionId === envelope.publisherSessionId) {
            if (envelope.revision <= this.current.revision) {
                return Object.freeze({ accepted: false, reason: "stale-revision" });
            }
        }
        else if (this.current) {
            this.retire(this.current.publisherSessionId);
        }
        this.current = envelope;
        this.listeners.forEach((listener) => listener(envelope));
        return Object.freeze({ accepted: true, reason: "accepted", envelope });
    }

    getCurrent() { return this.current; }
    subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    retire(sessionId) {
        this.retiredSessions.add(sessionId);
        if (this.retiredSessions.size > MAX_RETIRED_SESSIONS) {
            this.retiredSessions.delete(this.retiredSessions.values().next().value);
        }
    }
}
