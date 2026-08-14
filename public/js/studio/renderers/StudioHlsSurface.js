export default class StudioHlsSurface {

    constructor({ sourceId, sourceUrl, instanceId, consumer, onDestroyed }) {
        this.sourceId = sourceId;
        this.sourceUrl = sourceUrl;
        this.instanceId = instanceId;
        this.consumer = consumer;
        this.onDestroyed = onDestroyed;
        this.video = null;
        this.hls = null;
        this.destroyed = false;
        this.healthListeners = new Set();
        this.health = this.createHealth("idle", null);
        this.readinessState = "pending";
        this.readinessError = null;
        this.readinessWaiters = new Set();
        this.mediaDataReady = false;
        this.firstFramePresented = false;
        this.videoFrameCallbackId = null;
        this.usesVideoFrameCallback = false;
        this.handleLoadedData = this.handleLoadedData.bind(this);
        this.handleCanPlay = this.handleCanPlay.bind(this);
        this.handleWaiting = this.handleWaiting.bind(this);
        this.handleEnded = this.handleEnded.bind(this);
        this.handleNativeError = this.handleNativeError.bind(this);
    }

    async start(root) {
        this.destroyed = false;
        this.root = root;
        this.video = document.createElement("video");
        this.video.className = "studio-render-video";
        this.video.autoplay = true;
        this.video.muted = true;
        this.video.defaultMuted = true;
        this.video.playsInline = true;
        this.video.setAttribute("muted", "");
        this.video.setAttribute("playsinline", "");
        this.usesVideoFrameCallback = typeof this.video
            .requestVideoFrameCallback === "function";
        this.video.addEventListener("loadeddata", this.handleLoadedData);
        this.video.addEventListener("canplay", this.handleCanPlay);
        this.video.addEventListener("waiting", this.handleWaiting);
        this.video.addEventListener("ended", this.handleEnded);
        this.video.addEventListener("error", this.handleNativeError);
        this.requestFirstVideoFrame();
        root.replaceChildren(this.video);
        this.showStatus("Loading live source…", "loading");
        this.setHealth("connecting", null);

        if (this.video.canPlayType("application/vnd.apple.mpegurl")) {
            this.video.src = this.sourceUrl;
            await this.tryPlay();
            return;
        }

        const HlsImplementation = globalThis.Hls;

        if (!HlsImplementation?.isSupported?.()) {
            this.setHealth("error", "unsupported");
            throw new Error("Renderer unsupported");
        }

        this.hls = new HlsImplementation({
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 90
        });

        this.hls.on(HlsImplementation.Events.MANIFEST_PARSED, () => {
            if (!this.destroyed) {
                this.tryPlay();
            }
        });
        this.hls.on(HlsImplementation.Events.ERROR, (event, data) => {
            if (!this.destroyed && data?.fatal) {
                this.showStatus("Live source unavailable", "error");
                this.setHealth("error", this.classifyHlsError(data));
                this.failReadiness("fatal-hls-error");
            }
        });
        this.hls.loadSource(this.sourceUrl);
        this.hls.attachMedia(this.video);
    }

    async tryPlay() {
        try {
            await this.video?.play();
        }
        catch {
            // Muted autoplay is best-effort; loaded frames remain visible.
            this.setHealth("connecting", "autoplay");
        }
    }

    handleLoadedData() {
        this.updateMediaReadiness();
    }

    handleCanPlay() {
        this.updateMediaReadiness();
    }

    handleWaiting() {
        this.setHealth("stalled", null);
    }

    handleEnded() {
        this.setHealth("ended", null);
    }

    handleNativeError() {
        this.showStatus("Live source unavailable", "error");
        this.setHealth("error", "media");
        this.failReadiness("fatal-media-error");
    }

    waitUntilReady({ timeoutMs } = {}) {
        if (this.readinessState === "ready") {
            return Promise.resolve();
        }

        if (this.readinessState === "failed") {
            return Promise.reject(this.readinessError);
        }

        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };

            if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
                waiter.timer = setTimeout(() => {
                    this.readinessWaiters.delete(waiter);
                    reject(this.createReadinessError("readiness-timeout"));
                }, timeoutMs);
            }

            this.readinessWaiters.add(waiter);
            this.updateMediaReadiness();
        });
    }

    updateMediaReadiness() {
        if (!this.video || this.video.readyState < 2) {
            return;
        }

        this.mediaDataReady = true;

        if (this.usesVideoFrameCallback) {
            this.requestFirstVideoFrame();
            this.completeReadinessIfSatisfied();
            return;
        }

        this.markFirstFramePresented();
    }

    requestFirstVideoFrame() {
        if (this.destroyed || this.readinessState !== "pending" ||
            this.firstFramePresented || this.videoFrameCallbackId !== null ||
            !this.video || !this.usesVideoFrameCallback) {
            return;
        }

        try {
            this.videoFrameCallbackId = this.video.requestVideoFrameCallback(
                () => {
                    this.videoFrameCallbackId = null;

                    if (!this.destroyed) {
                        this.mediaDataReady = this.video.readyState >= 2 ||
                            this.mediaDataReady;
                        this.markFirstFramePresented();
                    }
                }
            );
        }
        catch {
            this.usesVideoFrameCallback = false;

            if (this.mediaDataReady) {
                this.markFirstFramePresented();
            }
        }
    }

    markFirstFramePresented() {
        if (this.destroyed || this.readinessState !== "pending" ||
            this.firstFramePresented) {
            return;
        }

        this.firstFramePresented = true;
        this.completeReadinessIfSatisfied();
    }

    completeReadinessIfSatisfied() {
        if (this.destroyed || this.readinessState !== "pending" ||
            !this.mediaDataReady || !this.firstFramePresented) {
            return;
        }

        this.readinessState = "ready";
        this.status?.remove();
        this.status = null;
        this.setHealth("ready", null);
        this.settleReadinessWaiters("resolve");
    }

    failReadiness(reason) {
        if (this.readinessState !== "pending") {
            return;
        }

        this.readinessState = "failed";
        this.readinessError = this.createReadinessError(reason);
        this.cancelPendingVideoFrameCallback();
        this.settleReadinessWaiters("reject", this.readinessError);
    }

    cancelPendingVideoFrameCallback() {
        if (this.videoFrameCallbackId === null) {
            return;
        }

        if (typeof this.video?.cancelVideoFrameCallback === "function") {
            try {
                this.video.cancelVideoFrameCallback(
                    this.videoFrameCallbackId
                );
            }
            catch {
                // Lifecycle guards still make a late callback inert.
            }
        }

        this.videoFrameCallbackId = null;
    }

    settleReadinessWaiters(action, value) {
        this.readinessWaiters.forEach((waiter) => {
            clearTimeout(waiter.timer);
            waiter[action](value);
        });
        this.readinessWaiters.clear();
    }

    createReadinessError(reason) {
        const error = new Error(`Studio surface not ready: ${reason}`);
        error.code = reason;
        return error;
    }

    showStatus(message, variant) {
        this.status?.remove();

        const status = document.createElement("div");
        status.className = `studio-render-status studio-render-status--${variant}`;
        status.textContent = message;
        this.root?.appendChild(status);
        this.status = status;
    }

    destroy() {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.failReadiness("destroyed-before-ready");
        this.cancelPendingVideoFrameCallback();
        this.hls?.destroy();
        this.hls = null;

        if (this.video) {
            this.video.removeEventListener("loadeddata", this.handleLoadedData);
            this.video.removeEventListener("canplay", this.handleCanPlay);
            this.video.removeEventListener("waiting", this.handleWaiting);
            this.video.removeEventListener("ended", this.handleEnded);
            this.video.removeEventListener("error", this.handleNativeError);
            this.video.pause();
            this.video.removeAttribute("src");
            this.video.load();
            this.video.remove();
            this.video = null;
        }

        this.status?.remove();
        this.status = null;
        this.root = null;
        this.setHealth("destroyed", null);
        this.healthListeners.clear();
        this.onDestroyed?.(this);
        this.onDestroyed = null;
    }

    getHealth() {
        return this.health;
    }

    subscribeHealth(listener) {
        if (typeof listener !== "function") {
            return () => {};
        }

        this.healthListeners.add(listener);
        listener(this.health);

        return () => {
            this.healthListeners.delete(listener);
        };
    }

    setHealth(state, reason) {
        this.health = this.createHealth(state, reason);
        this.healthListeners.forEach((listener) => listener(this.health));
    }

    createHealth(state, reason) {
        return Object.freeze({
            sourceId: this.sourceId,
            instanceId: this.instanceId,
            consumer: this.consumer,
            state,
            reason,
            timestamp: new Date().toISOString()
        });
    }

    classifyHlsError(data) {
        const type = String(data?.type || "").toLowerCase();

        if (type.includes("network")) {
            return "network";
        }

        return "media";
    }
}
