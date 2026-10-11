import { randomBytes } from "node:crypto";

const DEFAULT_MAX_SESSIONS = 64;

export default class OperatorSessionStore {
    constructor({ ttlSeconds = 8 * 60 * 60, maxSessions = DEFAULT_MAX_SESSIONS,
        clock = () => Date.now(),
        random = () => randomBytes(32).toString("base64url") } = {}) {
        if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 24 * 60 * 60) {
            throw new TypeError("Operator session TTL must be between 300 and 86400 seconds.");
        }
        if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 1024) {
            throw new TypeError("Operator session capacity must be between 1 and 1024.");
        }
        this.ttlMs = ttlSeconds * 1000;
        this.maxSessions = maxSessions;
        this.clock = clock;
        this.random = random;
        this.sessions = new Map();
    }

    create() {
        this.sweep();
        if (this.sessions.size >= this.maxSessions) return null;
        let id;
        do { id = this.random(); } while (!id || this.sessions.has(id));
        const session = Object.freeze({ id, csrfToken: this.random(),
            expiresAt: this.clock() + this.ttlMs });
        this.sessions.set(id, session);
        return session;
    }

    get(id) {
        this.sweep();
        if (typeof id !== "string" || !id) return null;
        const session = this.sessions.get(id);
        if (!session) return null;
        return session;
    }

    delete(id) { return typeof id === "string" && this.sessions.delete(id); }
    clear() { this.sessions.clear(); }
    sweep() {
        const now = this.clock();
        for (const [id, session] of this.sessions) {
            if (session.expiresAt <= now) this.sessions.delete(id);
        }
    }
}

export { DEFAULT_MAX_SESSIONS };
