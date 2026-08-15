export default class StudioMediaSurface {

    constructor({
        sourceId,
        sourceUrl,
        instanceId,
        consumer,
        initialTime = 0,
        onDestroyed
    }) {
        this.sourceId = sourceId;
        this.sourceUrl = sourceUrl;
        this.instanceId = instanceId;
        this.consumer = consumer;
        this.initialTime = Number.isFinite(initialTime) && initialTime >= 0
            ? initialTime
            : 0;
        this.initialCueState = consumer === "program" && this.initialTime > 0
            ? "pending"
            : "ready";
        this.onDestroyed = onDestroyed;
        this.video = null;
        this.root = null;
        this.destroyed = false;
        this.healthListeners = new Set();
        this.health = this.createHealth("idle", null);
        this.readinessState = "pending";
        this.readinessError = null;
        this.readinessWaiters = new Set();
        this.transportListeners = new Set();
        this.transportError = false;
        this.transportEnded = false;
        this.handleLoadedData = this.handleLoadedData.bind(this);
        this.handleCanPlay = this.handleCanPlay.bind(this);
        this.handlePlaying = this.handlePlaying.bind(this);
        this.handleWaiting = this.handleWaiting.bind(this);
        this.handleEnded = this.handleEnded.bind(this);
        this.handleError = this.handleError.bind(this);
        this.handlePause = this.handlePause.bind(this);
        this.handleLoadedMetadata = this.handleLoadedMetadata.bind(this);
        this.handleSeeked = this.handleSeeked.bind(this);
        this.handleTransportUpdate = this.handleTransportUpdate.bind(this);
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
        this.video.addEventListener("loadeddata", this.handleLoadedData);
        this.video.addEventListener("canplay", this.handleCanPlay);
        this.video.addEventListener("playing", this.handlePlaying);
        this.video.addEventListener("waiting", this.handleWaiting);
        this.video.addEventListener("ended", this.handleEnded);
        this.video.addEventListener("error", this.handleError);
        this.video.addEventListener("pause", this.handlePause);
        this.video.addEventListener("timeupdate", this.handleTransportUpdate);
        this.video.addEventListener("durationchange", this.handleTransportUpdate);
        this.video.addEventListener("loadedmetadata", this.handleLoadedMetadata);
        this.video.addEventListener("seeked", this.handleSeeked);
        this.video.src = this.sourceUrl;
        root.replaceChildren(this.video);
        this.showStatus("Loading media…", "loading");
        this.setHealth("connecting", null);
        this.notifyTransport();

        if (this.initialCueState === "ready") {
            await this.startPlayback();
        }
    }

    handleLoadedData() {
        this.status?.remove();
        this.status = null;
        this.setHealth("ready", null);
        this.markReadyIfFrameAvailable();
        this.notifyTransport();
    }

    handlePlaying() {
        this.transportEnded = false;
        this.setHealth("ready", null);
        this.markReadyIfFrameAvailable();
        this.notifyTransport();
    }

    handleCanPlay() {
        this.markReadyIfFrameAvailable();
        this.notifyTransport();
    }

    handleWaiting() {
        this.setHealth("stalled", null);
    }

    handleEnded() {
        this.transportEnded = true;
        this.setHealth("ended", null);
        this.notifyTransport();
    }

    handleError() {
        this.transportError = true;
        this.showStatus("Media unavailable", "error");
        this.setHealth("error", "media");
        this.failReadiness("fatal-media-error");
        this.notifyTransport();
    }

    handlePause() {
        this.notifyTransport();
    }

    handleLoadedMetadata() {
        this.notifyTransport();

        if (this.initialCueState !== "pending" || !this.video) {
            return;
        }

        const duration = Number.isFinite(this.video.duration) &&
            this.video.duration >= 0
            ? this.video.duration
            : null;
        const cueTime = duration === null
            ? this.initialTime
            : Math.min(this.initialTime, this.getPlayableEnd(duration));

        try {
            this.video.currentTime = cueTime;
        }
        catch {
            this.fallbackInitialCue();
        }
    }

    handleSeeked() {
        if (this.initialCueState === "pending") {
            this.initialCueState = "ready";
            void this.startPlayback();
        }

        this.markReadyIfFrameAvailable();
        this.notifyTransport();
    }

    handleTransportUpdate() {
        this.notifyTransport();
    }

    async startPlayback() {
        if (!this.video || this.destroyed) {
            return false;
        }

        try {
            await this.video.play();
            return true;
        }
        catch {
            this.setHealth("connecting", "autoplay");
            return false;
        }
    }

    fallbackInitialCue() {
        if (!this.video || this.destroyed) {
            return;
        }

        try {
            this.video.currentTime = 0;
            this.initialCueState = "ready";
            void this.startPlayback();
            this.markReadyIfFrameAvailable();
        }
        catch {
            this.initialCueState = "failed";
            this.failReadiness("initial-cue-failed");
        }
    }

    getPlayableEnd(duration) {
        if (duration <= 0) {
            return 0;
        }

        return Math.max(0, duration - Math.min(0.05, duration));
    }

    async play() {
        if (!this.isControllable()) {
            return false;
        }

        try {
            await this.video.play();
        }
        catch {
            this.notifyTransport();
            return false;
        }

        this.notifyTransport();
        return !this.video.paused;
    }

    pause() {
        if (!this.isControllable()) {
            return false;
        }

        this.video.pause();
        this.notifyTransport();
        return true;
    }

    restart() {
        if (!this.isControllable()) {
            return false;
        }

        this.video.pause();
        this.transportEnded = false;

        try {
            this.video.currentTime = 0;
        }
        catch {
            this.notifyTransport();
            return false;
        }

        this.notifyTransport();
        return true;
    }

    getTransport() {
        const video = this.video;
        const currentTime = Number.isFinite(video?.currentTime)
            ? Math.max(0, video.currentTime)
            : 0;
        const duration = Number.isFinite(video?.duration) && video.duration >= 0
            ? video.duration
            : null;

        return Object.freeze({
            sourceId: this.sourceId,
            instanceId: this.instanceId,
            consumer: this.consumer,
            state: this.getTransportState(),
            currentTime,
            duration,
            paused: video ? video.paused : true,
            ended: this.transportEnded,
            timestamp: new Date().toISOString()
        });
    }

    subscribeTransport(listener) {
        if (typeof listener !== "function") {
            return () => {};
        }

        this.transportListeners.add(listener);
        listener(this.getTransport());

        return () => {
            this.transportListeners.delete(listener);
        };
    }

    notifyTransport() {
        const snapshot = this.getTransport();
        this.transportListeners.forEach((listener) => listener(snapshot));
    }

    getTransportState() {
        if (this.destroyed) {
            return "destroyed";
        }

        if (this.transportError) {
            return "error";
        }

        if (!this.video) {
            return "idle";
        }

        if (this.transportEnded) {
            return "ended";
        }

        return this.video.paused ? "paused" : "playing";
    }

    isControllable() {
        return this.consumer === "preview" && !this.destroyed &&
            !this.transportError && Boolean(this.video);
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
            this.markReadyIfFrameAvailable();
        });
    }

    markReadyIfFrameAvailable() {
        if (!this.video || this.video.readyState < 2 ||
            this.initialCueState !== "ready") {
            return;
        }

        this.readinessState = "ready";
        this.settleReadinessWaiters("resolve");
    }

    failReadiness(reason) {
        if (this.readinessState !== "pending") {
            return;
        }

        this.readinessState = "failed";
        this.readinessError = this.createReadinessError(reason);
        this.settleReadinessWaiters("reject", this.readinessError);
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
        this.notifyTransport();

        if (this.video) {
            this.video.removeEventListener("loadeddata", this.handleLoadedData);
            this.video.removeEventListener("canplay", this.handleCanPlay);
            this.video.removeEventListener("playing", this.handlePlaying);
            this.video.removeEventListener("waiting", this.handleWaiting);
            this.video.removeEventListener("ended", this.handleEnded);
            this.video.removeEventListener("error", this.handleError);
            this.video.removeEventListener("pause", this.handlePause);
            this.video.removeEventListener("timeupdate", this.handleTransportUpdate);
            this.video.removeEventListener(
                "durationchange",
                this.handleTransportUpdate
            );
            this.video.removeEventListener(
                "loadedmetadata",
                this.handleLoadedMetadata
            );
            this.video.removeEventListener("seeked", this.handleSeeked);
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
        this.transportListeners.clear();
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
}
