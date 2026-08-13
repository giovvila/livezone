export default class StudioMediaSurface {

    constructor({ sourceId, sourceUrl, instanceId, consumer, onDestroyed }) {
        this.sourceId = sourceId;
        this.sourceUrl = sourceUrl;
        this.instanceId = instanceId;
        this.consumer = consumer;
        this.onDestroyed = onDestroyed;
        this.video = null;
        this.root = null;
        this.destroyed = false;
        this.healthListeners = new Set();
        this.health = this.createHealth("idle", null);
        this.readinessState = "pending";
        this.readinessError = null;
        this.readinessWaiters = new Set();
        this.handleLoadedData = this.handleLoadedData.bind(this);
        this.handleCanPlay = this.handleCanPlay.bind(this);
        this.handlePlaying = this.handlePlaying.bind(this);
        this.handleWaiting = this.handleWaiting.bind(this);
        this.handleEnded = this.handleEnded.bind(this);
        this.handleError = this.handleError.bind(this);
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
        this.video.src = this.sourceUrl;
        root.replaceChildren(this.video);
        this.showStatus("Loading media…", "loading");
        this.setHealth("connecting", null);

        try {
            await this.video.play();
        }
        catch {
            this.setHealth("connecting", "autoplay");
        }
    }

    handleLoadedData() {
        this.status?.remove();
        this.status = null;
        this.setHealth("ready", null);
        this.markReadyIfFrameAvailable();
    }

    handlePlaying() {
        this.setHealth("ready", null);
        this.markReadyIfFrameAvailable();
    }

    handleCanPlay() {
        this.markReadyIfFrameAvailable();
    }

    handleWaiting() {
        this.setHealth("stalled", null);
    }

    handleEnded() {
        this.setHealth("ended", null);
    }

    handleError() {
        this.showStatus("Media unavailable", "error");
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
            this.markReadyIfFrameAvailable();
        });
    }

    markReadyIfFrameAvailable() {
        if (!this.video || this.video.readyState < 2) {
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

        if (this.video) {
            this.video.removeEventListener("loadeddata", this.handleLoadedData);
            this.video.removeEventListener("canplay", this.handleCanPlay);
            this.video.removeEventListener("playing", this.handlePlaying);
            this.video.removeEventListener("waiting", this.handleWaiting);
            this.video.removeEventListener("ended", this.handleEnded);
            this.video.removeEventListener("error", this.handleError);
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
}
