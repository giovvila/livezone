import { validateProgramOutputSnapshot } from "./ProgramOutputContract.js";

const STORAGE_KEY = "livezone.programOutput.snapshot.v1";
const CHANNEL_NAME = "livezone.programOutput.v1";

export default class LocalProgramOutputTransport {
    constructor({ storage, channelFactory } = {}) {
        this.storage = storage === undefined ? this.getStorage() : storage;
        this.channelFactory = channelFactory || ((name) =>
            typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null);
        this.channel = null;
        this.listeners = new Set();
        this.latestPublished = null;
        this.started = false;
        this.handleStorage = this.handleStorage.bind(this);
        this.handleMessage = this.handleMessage.bind(this);
    }

    start() {
        if (this.started) return;
        this.channel = this.channelFactory(CHANNEL_NAME);
        if (this.channel) this.channel.onmessage = this.handleMessage;
        globalThis.addEventListener?.("storage", this.handleStorage);
        this.started = true;
    }

    publish(snapshot) {
        const valid = validateProgramOutputSnapshot(snapshot);
        if (!this.started || !valid) return false;
        const serialized = JSON.stringify(valid);
        try { this.storage?.setItem(STORAGE_KEY, serialized); }
        catch { /* BroadcastChannel remains available if storage is denied. */ }
        this.channel?.postMessage(valid);
        this.latestPublished = valid;
        return true;
    }

    subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        this.listeners.add(listener);
        const retained = this.readRetained();
        if (retained) listener(retained, { livePublisher: false });
        this.channel?.postMessage({ type: "request-current" });
        return () => this.listeners.delete(listener);
    }

    destroy() {
        globalThis.removeEventListener?.("storage", this.handleStorage);
        if (this.channel) this.channel.onmessage = null;
        this.channel?.close();
        this.channel = null;
        this.listeners.clear();
        this.started = false;
    }

    readRetained() {
        try {
            const raw = this.storage?.getItem(STORAGE_KEY);
            return raw ? validateProgramOutputSnapshot(JSON.parse(raw)) : null;
        }
        catch { return null; }
    }

    handleStorage(event) {
        if (event.key !== STORAGE_KEY || typeof event.newValue !== "string") return;
        try { this.notify(validateProgramOutputSnapshot(JSON.parse(event.newValue))); }
        catch { /* Invalid retained input is ignored. */ }
    }

    handleMessage(event) {
        if (event.data?.type === "request-current") {
            if (this.latestPublished) this.channel?.postMessage({
                type: "current", snapshot: this.latestPublished
            });
            return;
        }
        const candidate = event.data?.type === "current"
            ? event.data.snapshot : event.data;
        this.notify(validateProgramOutputSnapshot(candidate), true);
    }

    notify(snapshot, livePublisher = false) {
        if (snapshot) this.listeners.forEach((listener) => listener(
            snapshot, { livePublisher }
        ));
    }

    getStorage() {
        try { return globalThis.localStorage; }
        catch { return null; }
    }
}
