import {
    createProgramOutputEnvelope,
    validateProgramOutputEnvelope
} from "./ProgramOutputEnvelope.js";

export default class NetworkProgramOutputTransport {
    constructor({ role, publishUrl, subscribeUrl, tokenProvider = null,
        fetchImplementation = globalThis.fetch?.bind(globalThis),
        eventSourceFactory = (url) => new EventSource(url),
        baseUrl = globalThis.location?.href } = {}) {
        if (!["publisher", "subscriber"].includes(role)) {
            throw new TypeError("Network transport requires a valid role.");
        }
        this.role = role;
        this.mode = "network";
        this.baseUrl = baseUrl;
        this.publishUrl = this.createUrl(publishUrl);
        this.subscribeUrl = this.createUrl(subscribeUrl);
        this.tokenProvider = typeof tokenProvider === "function" ? tokenProvider : null;
        this.fetchImplementation = fetchImplementation;
        this.eventSourceFactory = eventSourceFactory;
        this.listeners = new Set();
        this.statusListeners = new Set();
        this.status = "disconnected";
        this.started = false;
        this.generation = 0;
        this.publishQueue = Promise.resolve();
        this.abortController = null;
        this.eventSource = null;
        this.handleProgram = this.handleProgram.bind(this);
        this.handleOpen = this.handleOpen.bind(this);
        this.handleError = this.handleError.bind(this);
    }

    start() {
        if (this.started) return;
        this.started = true;
        this.generation += 1;
        this.abortController = new AbortController();
        if (this.role === "subscriber") {
            this.setStatus("connecting");
            if (this.listeners.size > 0) this.startSubscriber();
        }
        else this.refreshPublisherCredential();
    }

    publish(snapshot) {
        const envelope = createProgramOutputEnvelope(snapshot);
        if (!this.started || this.role !== "publisher" || !envelope ||
            !this.fetchImplementation || !this.publishUrl) return false;
        const generation = this.generation;
        this.publishQueue = this.publishQueue
            .catch(() => {})
            .then(() => this.sendEnvelope(envelope, generation));
        return true;
    }

    subscribe(listener) {
        if (typeof listener !== "function" || this.role !== "subscriber") {
            return () => {};
        }
        this.listeners.add(listener);
        if (this.started) this.startSubscriber();
        return () => this.listeners.delete(listener);
    }

    subscribeStatus(listener) {
        if (typeof listener !== "function") return () => {};
        this.statusListeners.add(listener);
        listener(this.status);
        return () => this.statusListeners.delete(listener);
    }

    destroy() {
        if (!this.started) return;
        this.abortController?.abort();
        this.eventSource?.removeEventListener("program", this.handleProgram);
        this.eventSource?.removeEventListener("open", this.handleOpen);
        this.eventSource?.removeEventListener("error", this.handleError);
        this.eventSource?.close();
        this.eventSource = null;
        this.abortController = null;
        this.listeners.clear();
        this.statusListeners.clear();
        this.started = false;
        this.generation += 1;
        this.setStatus("disconnected");
    }

    startSubscriber() {
        if (!this.subscribeUrl || this.eventSource) return;
        this.eventSource = this.eventSourceFactory(this.subscribeUrl.href);
        this.eventSource.addEventListener("program", this.handleProgram);
        this.eventSource.addEventListener("open", this.handleOpen);
        this.eventSource.addEventListener("error", this.handleError);
        this.setStatus("connecting");
    }

    async sendEnvelope(envelope, generation) {
        if (!this.started || generation !== this.generation) return false;
        const token = this.tokenProvider?.();
        if (typeof token !== "string" || !token.trim()) {
            this.setStatus("token-missing");
            console.error(
                "[ProgramOutput] Network publish blocked: " +
                "browser publisher token is missing."
            );
            return false;
        }
        try {
            const response = await this.fetchImplementation(this.publishUrl.href, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${token.trim()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(envelope),
                cache: "no-store",
                signal: this.abortController?.signal
            });
            if (response.status === 401 || response.status === 403) {
                this.setStatus("auth-error");
                return false;
            }
            if (!response.ok) throw new Error("Program publish rejected");
            this.setStatus("connected");
            return true;
        }
        catch (error) {
            if (error?.name !== "AbortError") this.setStatus("publishing-error");
            return false;
        }
    }

    handleProgram(event) {
        try {
            const envelope = validateProgramOutputEnvelope(JSON.parse(event.data));
            if (!envelope) return;
            this.listeners.forEach((listener) => listener(
                envelope.snapshot, { livePublisher: true }
            ));
        }
        catch { /* Malformed network input is ignored. */ }
    }

    handleOpen() { this.setStatus("connected"); }
    handleError() { this.setStatus("disconnected"); }
    refreshPublisherCredential() {
        if (this.role !== "publisher") return;
        const token = this.tokenProvider?.();
        this.setStatus(typeof token === "string" && token.trim()
            ? "token-ready" : "token-missing");
    }
    setStatus(status) {
        if (this.status === status) return;
        this.status = status;
        this.statusListeners.forEach((listener) => listener(status));
    }
    createUrl(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const url = new URL(value, this.baseUrl);
            return ["http:", "https:"].includes(url.protocol) ? url : null;
        }
        catch { return null; }
    }
}
