import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createUninitializedState, validateAuthoritativeState } from
    "./AuthoritativeStateContract.js";

export default class AuthoritativeStateRepository {
    constructor({ path, clock = () => new Date(), uuid = randomUUID,
        fileOperations = {} } = {}) {
        if (typeof path !== "string" || !path.trim()) throw new TypeError("State path is required.");
        this.path = resolve(path);
        this.root = dirname(this.path);
        this.clock = clock;
        this.uuid = uuid;
        this.fs = { mkdir, readFile, rename, unlink, writeFile, ...fileOperations };
        this.snapshot = null;
        this.status = "MISSING";
        this.issue = null;
    }

    async initialize() {
        try {
            const raw = await this.fs.readFile(this.path, "utf8");
            let parsed;
            try { parsed = JSON.parse(raw); }
            catch { return this.markCorrupt("invalid-json"); }
            const state = validateAuthoritativeState(parsed);
            if (!state) return this.markCorrupt("invalid-schema");
            this.snapshot = state;
            this.status = state.initialized ? "VALID" : "UNINITIALIZED";
            this.issue = null;
            return this.getSnapshot();
        }
        catch (error) {
            if (error?.code !== "ENOENT") return this.markCorrupt("unavailable");
            this.snapshot = createUninitializedState({ stateId: this.uuid(),
                updatedAt: this.clock().toISOString() });
            this.status = "UNINITIALIZED";
            this.issue = null;
            return this.getSnapshot();
        }
    }

    getSnapshot() { return this.snapshot; }
    getStatus() { return Object.freeze({ status: this.status,
        initialized: this.snapshot?.initialized === true,
        revision: this.snapshot?.revision ?? null }); }

    async commit(candidate) {
        if (this.status === "CORRUPT" || !this.snapshot) throw stateError("STATE_UNAVAILABLE");
        const state = validateAuthoritativeState(candidate);
        if (!state) throw stateError("INVALID_STATE");
        await this.fs.mkdir(this.root, { recursive: true });
        const tempPath = resolve(this.root, `.state-${this.uuid()}.tmp`);
        try {
            await this.fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
            await this.fs.rename(tempPath, this.path);
        }
        catch (error) {
            await this.fs.unlink(tempPath).catch(() => {});
            throw stateError("STATE_PERSISTENCE_FAILED", error);
        }
        this.snapshot = state;
        this.status = state.initialized ? "VALID" : "UNINITIALIZED";
        this.issue = null;
        return state;
    }

    markCorrupt(issue) {
        this.snapshot = null;
        this.status = "CORRUPT";
        this.issue = issue;
        return null;
    }
}

function stateError(code, cause) { return Object.assign(new Error(code), { code, cause }); }
