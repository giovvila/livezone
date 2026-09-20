import {
    createProgramOutputEnvelope,
    validateProgramOutputEnvelope
} from "./ProgramOutputEnvelope.js";

const PUBLISH_TIMEOUT_MS = 8000;
import trace, { programTraceFields } from "../core/RuntimeTrace.js";
import {getReferenceClientHeaders} from '../auth/OperatorSessionClient.js';

export default class NetworkProgramOutputTransport {
    constructor({ role, publishUrl, subscribeUrl, tokenProvider = null,
        fetchImplementation = globalThis.fetch?.bind(globalThis),
        eventSourceFactory = globalThis.EventSource
            ? (url) => new globalThis.EventSource(url) : null,
        setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
        retryDelays = [1000, 2000, 5000, 10000],
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
        this.setTimer = (callback, delay) => setTimer(callback, delay);
        this.clearTimer = (timer) => clearTimer(timer);
        this.retryDelays = retryDelays;
        this.listeners = new Set();
        this.retainedReads = new Set();
        this.statusListeners = new Set();
        this.status = "disconnected";
        this.started = false;
        this.generation = 0;
        this.publishQueue = Promise.resolve();
        this.abortController = null;
        this.eventSource = null;
        this.latestEnvelope = null;
        this.retryTimer = null;
        this.retryAttempt = 0;
        this.publisherMonitorOpened = false;
        this.publisherMonitorDisconnected = false;
        this.publisherBlockedByCredential = false;
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
        else {
            this.refreshPublisherCredential();
            this.startPublisherMonitor();
        }
    }

    // Bootstrap uses the same retained SSE envelope as Public/OBS, before publishing.
    readRetained({ timeoutMs = 2000 } = {}) {
        if (!this.eventSourceFactory || !this.subscribeUrl) return Promise.resolve(null);
        return new Promise(resolve => {
            let stream = null;
            let timer = null;
            let finished = false;
            const finish = snapshot => {
                if (finished) return;
                finished = true;
                this.retainedReads.delete(fail);
                this.clearTimer(timer);
                stream?.removeEventListener("program", receive);
                stream?.removeEventListener("error", fail);
                stream?.close();
                resolve(snapshot);
            };
            const fail = () => finish(null);
            this.retainedReads.add(fail);
            const receive = event => {
                try {
                    const envelope = validateProgramOutputEnvelope(JSON.parse(event.data));
                    if (envelope && !envelope.snapshot.output?.overlayOnly) finish(envelope.snapshot);
                } catch { /* Ignore malformed events until the bounded deadline. */ }
            };
            try {
                stream = this.eventSourceFactory(this.subscribeUrl.href);
                stream.addEventListener("program", receive);
                stream.addEventListener("error", fail);
                timer = this.setTimer(fail, timeoutMs);
            } catch { finish(null); }
        });
    }

    publish(snapshot, context = null) {
        const envelope = createProgramOutputEnvelope(snapshot);
        if (!this.started || this.role !== "publisher" || !envelope ||
            !this.fetchImplementation || !this.publishUrl) return false;
        this.latestEnvelope = envelope;
        if(this.executionOwnership)this.publicationContexts??=new WeakMap();
        if(this.executionOwnership)this.publicationContexts.set(envelope,this.executionOwnership.capture(context?.manual===true));
        if (this.retryTimer !== null || this.status === "auth-error") {
            return true;
        }
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
        for (const finish of [...this.retainedReads]) finish();
        if (!this.started) return;
        this.abortController?.abort();
        this.eventSource?.removeEventListener("program", this.handleProgram);
        this.eventSource?.removeEventListener("open", this.handleOpen);
        this.eventSource?.removeEventListener("error", this.handleError);
        this.eventSource?.close();
        this.eventSource = null;
        this.cancelRetry();
        this.latestEnvelope = null;
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

    startPublisherMonitor() {
        if (!this.subscribeUrl || this.eventSource || !this.eventSourceFactory) return;
        this.eventSource = this.eventSourceFactory(this.subscribeUrl.href);
        this.eventSource.addEventListener("open", this.handleOpen);
        this.eventSource.addEventListener("error", this.handleError);
        this.eventSource.addEventListener("program", this.handleProgram);
    }

    async sendEnvelope(envelope, generation) {
        if (!this.started || generation !== this.generation) return false;
        const token = this.tokenProvider?.();
        if (typeof token !== "string" || !token.trim()) {
            this.publisherBlockedByCredential = true;
            this.setStatus("token-missing");
            console.error(
                "[ProgramOutput] Network publish blocked: " +
                "browser publisher token is missing."
            );
            return false;
        }
        const lifecycleSignal = this.abortController?.signal;
        const requestController = new AbortController();
        let timedOut = false;
        const abortRequest = () => requestController.abort();
        lifecycleSignal?.addEventListener("abort", abortRequest, { once: true });
        const timeoutTimer = this.setTimer(() => {
            timedOut = true;
            requestController.abort();
        }, PUBLISH_TIMEOUT_MS);
        timeoutTimer?.unref?.();
        try {
            const send=this.executionOwnership ? (url,options)=>this.executionOwnership.publish(url,options,this.publicationContexts?.get(envelope)) : this.fetchImplementation;
            const response = await send(this.publishUrl.href, {
                method: "POST",
                headers: {
                    ...(this.publishUrl.origin===globalThis.location?.origin?getReferenceClientHeaders():{}),
                    "Authorization": `Bearer ${token.trim()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(envelope),
                cache: "no-store",
                signal: requestController.signal
            });
            trace.record("network", response.ok ? "publish-success" : "publish-rejected",
                { ...programTraceFields(envelope.snapshot), httpStatus: response.status });
            if (response.status === 401 || response.status === 403) {
                this.cancelRetry();
                this.publisherBlockedByCredential = true;
                this.setStatus("auth-error");
                return false;
            }
            if (response.status === 409) {
                const reason = await this.readErrorReason(response);
                this.cancelRetry();
                if (reason === "stale-revision") {
                    this.retryAttempt = 0;
                    this.publisherBlockedByCredential = false;
                    this.setStatus("connected");
                    return true;
                }
                this.setStatus(reason === "retired-session"
                    ? "publisher-conflict" : "protocol-error");
                return false;
            }
            if (!response.ok) {
                if (response.status === 408 || response.status === 429 ||
                    response.status >= 500) {
                    throw new Error("Program publish temporarily unavailable");
                }
                this.cancelRetry();
                this.setStatus("protocol-error");
                return false;
            }
            this.cancelRetry();
            this.retryAttempt = 0;
            this.publisherBlockedByCredential = false;
            this.setStatus("connected");
            return true;
        }
        catch (error) {
            trace.record("network", "publish-failed", programTraceFields(envelope.snapshot));
            if (timedOut || error?.name !== "AbortError") {
                this.setStatus("publishing-error");
                this.scheduleRetry(generation);
            }
            return false;
        }
        finally {
            this.clearTimer(timeoutTimer);
            lifecycleSignal?.removeEventListener("abort", abortRequest);
        }
    }

    async readErrorReason(response) {
        try {
            const payload = await response.json();
            return payload && typeof payload === "object" &&
                typeof payload.error === "string" ? payload.error : null;
        }
        catch { return null; }
    }

    handleProgram(event) {
        try {
            const envelope = validateProgramOutputEnvelope(JSON.parse(event.data));
            if (!envelope) { trace.record("network", "sse-rejected"); return; }
            trace.record("network", "sse-revision", { ...programTraceFields(envelope.snapshot),
                eventSourceState: this.eventSource?.readyState });
            this.onRetainedSnapshot?.(envelope.snapshot);
            this.listeners.forEach((listener) => listener(
                envelope.snapshot, { livePublisher: true }
            ));
        }
        catch { trace.record("network", "sse-dispatch-failed"); }
    }

    handleOpen() {
        trace.record("network", "sse-open", { mode: this.role, eventSourceState: this.eventSource?.readyState });
        if (this.role === "subscriber") return this.setStatus("connected");
        if(this.executionOwnership?.grant)void this.executionOwnership.exchange('renew');
        const shouldRecover = this.publisherMonitorOpened && this.publisherMonitorDisconnected;
        this.publisherMonitorOpened = true;
        this.publisherMonitorDisconnected = false;
        if (shouldRecover && !this.publisherBlockedByCredential) this.queueLatest();
    }
    handleError() {
        trace.record("network", "sse-error", { mode: this.role, eventSourceState: this.eventSource?.readyState });
        if (this.role === "publisher") {
            this.publisherMonitorDisconnected = true;
            if (this.publisherBlockedByCredential) return;
        }
        this.setStatus("disconnected");
        // CONNECTING is retried by EventSource itself; CLOSED needs a new stream.
        if(this.role==='subscriber' && (!this.eventSource||this.eventSource.readyState===2) && this.retryTimer===null){
            const generation=this.generation;
            this.retryTimer=this.setTimer(()=>{
                this.retryTimer=null;
                if(!this.started||generation!==this.generation)return;
                this.eventSource?.removeEventListener('program',this.handleProgram);
                this.eventSource?.removeEventListener('open',this.handleOpen);
                this.eventSource?.removeEventListener('error',this.handleError);
                this.eventSource?.close();this.eventSource=null;
                try{this.startSubscriber();}catch{this.handleError();}
            },this.retryDelays[0]||1000);
        }
    }
    refreshPublisherCredential() {
        if (this.role !== "publisher") return;
        const token = this.tokenProvider?.();
        if (typeof token === "string" && token.trim()) {
            this.publisherBlockedByCredential = false;
            this.setStatus("token-ready");
            if (this.latestEnvelope) this.queueLatest();
        }
        else {
            this.cancelRetry();
            this.publisherBlockedByCredential = true;
            this.setStatus("token-missing");
        }
    }
    queueLatest() {
        if (!this.started || this.role !== "publisher" || !this.latestEnvelope) return false;
        this.cancelRetry();
        const envelope = this.latestEnvelope;
        const generation = this.generation;
        this.publishQueue = this.publishQueue.catch(() => {})
            .then(() => this.sendEnvelope(envelope, generation));
        return true;
    }
    scheduleRetry(generation) {
        if (this.retryTimer !== null || !this.started || generation !== this.generation ||
            !this.latestEnvelope) return;
        const index = Math.min(this.retryAttempt, this.retryDelays.length - 1);
        const delay = this.retryDelays[index];
        this.retryAttempt += 1;
        this.retryTimer = this.setTimer(() => {
            this.retryTimer = null;
            if (this.started && generation === this.generation) this.queueLatest();
        }, delay);
        this.retryTimer?.unref?.();
    }
    cancelRetry() {
        if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
        this.retryTimer = null;
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
