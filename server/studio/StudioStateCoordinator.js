import { createInitializedState } from "./AuthoritativeStateContract.js";

export default class StudioStateCoordinator {
    constructor({ repository, clock = () => new Date() } = {}) {
        if (!repository) throw new TypeError("StudioStateCoordinator requires a repository.");
        this.repository = repository;
        this.clock = clock;
        this.queue = Promise.resolve();
        this.listeners = new Set();
    }

    initialize() { return this.repository.initialize(); }
    getSnapshot() { return this.repository.getSnapshot(); }
    getStatus() { return this.repository.getStatus(); }
    subscribe(listener) { if (typeof listener !== "function") return () => {};
        this.listeners.add(listener); return () => this.listeners.delete(listener); }

    initializeState(domains) {
        return this.serialize(async () => {
            const current = this.getSnapshot();
            if (!current) throw stateError("STATE_UNAVAILABLE");
            if (current.initialized) throw stateError("STATE_ALREADY_INITIALIZED");
            const candidate = createInitializedState(domains, { stateId: current.stateId,
                revision: current.revision + 1, updatedAt: this.clock().toISOString() });
            if (!candidate) throw stateError("INVALID_STATE");
            const committed = await this.repository.commit(candidate);
            const event = Object.freeze({ type: "initialized", revision: committed.revision,
                changedDomains: Object.freeze(["sources", "scenes", "scheduler",
                    "globalOverlays", "dominantLive"]) });
            this.listeners.forEach((listener) => {
                try { listener(event); } catch { /* A subscriber cannot undo a committed state. */ }
            });
            return committed;
        });
    }

    serialize(operation) {
        const result = this.queue.then(operation, operation);
        this.queue = result.catch(() => {});
        return result;
    }
}

function stateError(code) { return Object.assign(new Error(code), { code }); }
