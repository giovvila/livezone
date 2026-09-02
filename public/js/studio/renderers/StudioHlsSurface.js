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
        this.recoveryFramePending = false;
        this.usesVideoFrameCallback = false;
        this.autoplayBlocked = false;
        this.audioRecoveryButton = null;
        this.handleLoadedData = this.handleLoadedData.bind(this);
        this.handleCanPlay = this.handleCanPlay.bind(this);
        this.handleWaiting = this.handleWaiting.bind(this);
        this.handlePlaying = this.handlePlaying.bind(this);
        this.handlePause = this.handlePause.bind(this);
        this.handleEnded = this.handleEnded.bind(this);
        this.handleNativeError = this.handleNativeError.bind(this);
        this.handleAudioRecovery = this.handleAudioRecovery.bind(this);
    }

    async start(root) {
        this.destroyed = false;
        this.root = root;
        this.video = document.createElement("video");
        this.video.className = "studio-render-video";
        this.video.autoplay = true;
        this.setMuted(true);
        this.video.playsInline = true;
        this.video.setAttribute("playsinline", "");
        this.usesVideoFrameCallback = typeof this.video
            .requestVideoFrameCallback === "function";
        this.video.addEventListener("loadeddata", this.handleLoadedData);
        this.video.addEventListener("canplay", this.handleCanPlay);
        this.video.addEventListener("waiting", this.handleWaiting);
        this.video.addEventListener("playing", this.handlePlaying);
        this.video.addEventListener("pause", this.handlePause);
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
            return true;
        }
        catch (error) {
            // Muted autoplay is best-effort; loaded frames remain visible.
            this.setHealth("connecting", this.isAutoplayRejection(error)
                ? "autoplay" : "playback");
            return false;
        }
    }

    async activateProgram() {
        if (this.consumer !== "program" || !this.video || this.destroyed) {
            return false;
        }
        this.setMuted(false);
        try {
            await this.video.play();
            this.clearAudioRecovery();
            return true;
        }
        catch (error) {
            if (this.isAutoplayRejection(error)) {
                this.autoplayBlocked = true;
                this.setMuted(true);
                this.showAudioRecovery();
                this.setHealth("connecting", "autoplay");
                void this.video.play().catch(() => {});
            }
            else {
                this.setHealth("error", "playback");
            }
            return false;
        }
    }

    deactivateProgram() {
        if (this.consumer !== "program" || !this.video) return false;
        this.setMuted(true);
        return true;
    }

    async handleAudioRecovery() {
        if (!this.autoplayBlocked || this.consumer !== "program" ||
            !this.video || this.destroyed) return;
        const video = this.video;
        this.setMuted(false);
        try {
            await video.play();
            if (this.destroyed || this.video !== video) return;
            this.clearAudioRecovery();
            if (this.readinessState === "ready") this.setHealth("ready", null);
        }
        catch (error) {
            if (this.destroyed || this.video !== video) return;
            if (this.isAutoplayRejection(error)) {
                this.autoplayBlocked = true;
                this.setMuted(true);
                this.showAudioRecovery();
                return;
            }
            this.clearAudioRecovery();
            this.setMuted(true);
            this.setHealth("error", "playback");
        }
    }

    isAutoplayRejection(error) {
        return error?.name === "NotAllowedError";
    }

    setMuted(muted) {
        if (!this.video) return;
        this.video.muted = muted;
        this.video.defaultMuted = muted;
        if (muted) this.video.setAttribute("muted", "");
        else this.video.removeAttribute("muted");
    }

    showAudioRecovery() {
        if (this.consumer !== "program" || this.destroyed ||
            this.audioRecoveryButton) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "studio-render-audio-recovery";
        button.textContent = "ENABLE AUDIO";
        button.addEventListener("click", this.handleAudioRecovery);
        this.root?.appendChild(button);
        this.audioRecoveryButton = button;
    }

    clearAudioRecovery() {
        this.autoplayBlocked = false;
        if (!this.audioRecoveryButton) return;
        this.audioRecoveryButton.removeEventListener(
            "click", this.handleAudioRecovery
        );
        this.audioRecoveryButton.remove();
        this.audioRecoveryButton = null;
    }

    handleLoadedData() {
        this.updateMediaReadiness();
    }

    handleCanPlay() {
        this.updateMediaReadiness();
    }

    handleWaiting() {
        this.setHealth("stalled", null);
        if (this.readinessState === "ready") {
            this.recoveryFramePending = true;
            this.requestRecoveryVideoFrame();
        }
    }

    handlePlaying() {
        if (!this.video?.muted && this.video?.paused !== true) this.clearAudioRecovery();
    }

    handlePause() {
        if (this.consumer === "program" && !this.destroyed && !this.autoplayBlocked &&
            !this.video?.ended) void this.activateProgram();
    }

    handleEnded() {
        this.clearAudioRecovery();
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

        if (this.recoveryFramePending) {
            this.requestRecoveryVideoFrame();
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

    requestRecoveryVideoFrame() {
        if (this.destroyed || !this.recoveryFramePending ||
            this.videoFrameCallbackId !== null || !this.video) return;
        if (!this.usesVideoFrameCallback) {
            if (this.video.readyState >= 2) this.completeRecoveryFrame();
            return;
        }
        try {
            this.videoFrameCallbackId = this.video.requestVideoFrameCallback(() => {
                this.videoFrameCallbackId = null;
                if (!this.destroyed) this.completeRecoveryFrame();
            });
        }
        catch {
            this.usesVideoFrameCallback = false;
            if (this.video.readyState >= 2) this.completeRecoveryFrame();
        }
    }

    completeRecoveryFrame() {
        if (!this.recoveryFramePending) return;
        this.recoveryFramePending = false;
        this.setHealth("ready", null);
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
        this.clearAudioRecovery();
        this.hls?.destroy();
        this.hls = null;

        if (this.video) {
            this.video.removeEventListener("loadeddata", this.handleLoadedData);
            this.video.removeEventListener("canplay", this.handleCanPlay);
            this.video.removeEventListener("waiting", this.handleWaiting);
            this.video.removeEventListener("playing", this.handlePlaying);
            this.video.removeEventListener("pause", this.handlePause);
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
