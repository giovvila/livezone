export default class StudioAudioSurface {

    constructor({
        sourceId,
        audioUrl,
        stillUrl,
        instanceId,
        consumer,
        initialTime = 0,
        initialPlayback = "playing",
        onDestroyed
    }) {
        this.sourceId = sourceId;
        this.audioUrl = audioUrl;
        this.stillUrl = stillUrl;
        this.instanceId = instanceId;
        this.consumer = consumer;
        this.initialTime = Number.isFinite(initialTime) && initialTime >= 0
            ? initialTime
            : 0;
        this.initialPlayback = initialPlayback === "paused"
            ? "paused"
            : "playing";
        this.initialCueState = this.initialTime > 0 ? "pending" : "ready";
        this.onDestroyed = onDestroyed;
        this.audio = null;
        this.audioSource = null;
        this.image = null;
        this.root = null;
        this.destroyed = false;
        this.metadataReady = false;
        this.audioReady = false;
        this.imageReady = false;
        this.transportError = false;
        this.transportEnded = false;
        this.readinessState = "pending";
        this.readinessError = null;
        this.readinessWaiters = new Set();
        this.transportListeners = new Set();
        this.healthListeners = new Set();
        this.health = this.createHealth("idle", null);

        this.handleImageLoad = this.handleImageLoad.bind(this);
        this.handleImageError = this.handleImageError.bind(this);
        this.handleLoadedMetadata = this.handleLoadedMetadata.bind(this);
        this.handleSeeked = this.handleSeeked.bind(this);
        this.handleAudioReady = this.handleAudioReady.bind(this);
        this.handlePlaying = this.handlePlaying.bind(this);
        this.handleWaiting = this.handleWaiting.bind(this);
        this.handlePause = this.handlePause.bind(this);
        this.handleEnded = this.handleEnded.bind(this);
        this.handleAudioError = this.handleAudioError.bind(this);
        this.handleTransportUpdate = this.handleTransportUpdate.bind(this);
    }

    async start(root) {
        this.root = root;
        this.image = document.createElement("img");
        this.audio = document.createElement("audio");
        this.audioSource = document.createElement("source");
        this.image.className = "studio-render-audio-still";
        this.image.alt = "";
        this.image.hidden = true;
        this.audio.preload = "auto";
        this.audio.autoplay = this.initialPlayback === "playing";
        this.image.addEventListener("load", this.handleImageLoad);
        this.image.addEventListener("error", this.handleImageError);
        this.audio.addEventListener("loadedmetadata", this.handleLoadedMetadata);
        this.audio.addEventListener("loadeddata", this.handleAudioReady);
        this.audio.addEventListener("canplay", this.handleAudioReady);
        this.audio.addEventListener("seeked", this.handleSeeked);
        this.audio.addEventListener("playing", this.handlePlaying);
        this.audio.addEventListener("waiting", this.handleWaiting);
        this.audio.addEventListener("pause", this.handlePause);
        this.audio.addEventListener("ended", this.handleEnded);
        this.audio.addEventListener("error", this.handleAudioError);
        this.audio.addEventListener("timeupdate", this.handleTransportUpdate);
        this.audio.addEventListener("durationchange", this.handleTransportUpdate);

        this.audioSource.src = this.audioUrl;
        const audioType = this.getAudioMimeType(this.audioUrl);
        if (audioType) {
            this.audioSource.type = audioType;
        }
        this.audio.appendChild(this.audioSource);
        root.replaceChildren(this.image, this.audio);
        this.showStatus("Loading audio…", "loading");
        this.setHealth("connecting", null);
        this.image.src = this.stillUrl;
        this.audio.load();
        this.notifyTransport();
        this.checkCurrentReadiness();

        if (this.consumer === "preview" &&
            this.initialCueState === "ready" &&
            this.initialPlayback === "playing") {
            await this.startPlayback();
        }
    }

    handleImageLoad() {
        this.imageReady = true;
        this.image.hidden = false;
        this.checkCurrentReadiness();
    }

    handleImageError() {
        this.transportError = true;
        this.showStatus("Audio artwork unavailable", "error");
        this.setHealth("error", "still");
        this.failReadiness("fatal-still-error");
        this.notifyTransport();
    }

    handleLoadedMetadata() {
        this.metadataReady = true;
        this.notifyTransport();
        this.applyInitialCue();
        this.checkCurrentReadiness();
    }

    applyInitialCue() {
        if (this.initialCueState !== "pending" || !this.audio ||
            this.audio.readyState < 1) {
            return;
        }

        const duration = Number.isFinite(this.audio.duration) &&
            this.audio.duration >= 0
            ? this.audio.duration
            : null;
        const cue = duration === null
            ? this.initialTime
            : Math.min(this.initialTime, this.getPlayableEnd(duration));
        const currentTime = Number.isFinite(this.audio.currentTime)
            ? this.audio.currentTime
            : 0;

        if (this.audio.seeking !== true &&
            Math.abs(currentTime - cue) <= 0.01) {
            this.completeInitialCue();
            return;
        }

        try {
            this.audio.currentTime = cue;
            if (this.audio.seeking === false &&
                Math.abs(this.audio.currentTime - cue) <= 0.01) {
                this.completeInitialCue();
            }
        }
        catch {
            this.failReadiness("initial-cue-failed");
        }
    }

    handleSeeked() {
        if (this.initialCueState === "pending") {
            this.completeInitialCue();
        }
        this.checkCurrentReadiness();
        this.notifyTransport();
    }

    completeInitialCue() {
        this.initialCueState = "ready";
        if (this.consumer === "preview" &&
            this.initialPlayback === "playing") {
            void this.startPlayback();
        }
        else {
            this.audio?.pause();
        }
    }

    handleAudioReady() {
        this.audioReady = Boolean(this.audio && this.audio.readyState >= 2);
        this.checkCurrentReadiness();
        this.notifyTransport();
    }

    handlePlaying() {
        this.transportEnded = false;
        this.setHealth("ready", null);
        this.checkCurrentReadiness();
        this.notifyTransport();
    }

    handleWaiting() {
        this.setHealth("stalled", null);
    }

    handlePause() {
        this.notifyTransport();
    }

    handleEnded() {
        this.transportEnded = true;
        this.setHealth("ended", null);
        this.notifyTransport();
    }

    handleAudioError() {
        this.transportError = true;
        const reason = this.getAudioErrorReason();
        this.showStatus(this.getAudioErrorMessage(reason), "error");
        this.setHealth("error", reason);
        this.failReadiness(reason);
        this.notifyTransport();
    }

    handleTransportUpdate() {
        this.checkCurrentReadiness();
        this.notifyTransport();
    }

    async startPlayback() {
        if (!this.audio || this.destroyed) {
            return false;
        }
        try {
            await this.audio.play();
            return true;
        }
        catch {
            this.setHealth("connecting", "autoplay");
            return false;
        }
    }

    activateProgram() {
        return this.consumer === "program" &&
            this.initialPlayback === "playing"
            ? this.startPlayback()
            : Promise.resolve(false);
    }

    deactivateProgram() {
        if (this.consumer !== "program" || !this.audio) {
            return false;
        }
        this.audio.pause();
        return true;
    }

    async play() {
        if (!this.isControllable()) {
            return false;
        }
        const played = await this.startPlayback();
        this.notifyTransport();
        return played && !this.audio.paused;
    }

    pause() {
        if (!this.isControllable()) {
            return false;
        }
        this.audio.pause();
        this.notifyTransport();
        return true;
    }

    restart() {
        if (!this.isControllable()) {
            return false;
        }
        this.audio.pause();
        this.transportEnded = false;
        try {
            this.audio.currentTime = 0;
        }
        catch {
            this.notifyTransport();
            return false;
        }
        this.notifyTransport();
        return true;
    }

    getTransport() {
        const currentTime = this.initialCueState === "pending"
            ? this.initialTime
            : Number.isFinite(this.audio?.currentTime)
            ? Math.max(0, this.audio.currentTime)
            : 0;
        const duration = Number.isFinite(this.audio?.duration) &&
            this.audio.duration >= 0
            ? this.audio.duration
            : null;
        return Object.freeze({
            sourceId: this.sourceId,
            instanceId: this.instanceId,
            consumer: this.consumer,
            state: this.getTransportState(),
            currentTime,
            duration,
            paused: this.audio ? this.audio.paused : true,
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
        return () => this.transportListeners.delete(listener);
    }

    notifyTransport() {
        const snapshot = this.getTransport();
        this.transportListeners.forEach((listener) => listener(snapshot));
    }

    getTransportState() {
        if (this.destroyed) return "destroyed";
        if (this.transportError) return "error";
        if (!this.audio) return "idle";
        if (this.transportEnded) return "ended";
        if (this.readinessState === "pending") return "loading";
        return this.audio.paused ? "paused" : "playing";
    }

    isControllable() {
        return this.consumer === "preview" && !this.destroyed &&
            !this.transportError && this.readinessState === "ready" &&
            Boolean(this.audio);
    }

    waitUntilReady({ timeoutMs } = {}) {
        if (this.readinessState === "ready") return Promise.resolve();
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
            this.checkCurrentReadiness();
        });
    }

    checkCurrentReadiness() {
        if (!this.audio || !this.image || this.destroyed) {
            return;
        }

        if (this.audio.error) {
            this.handleAudioError();
            return;
        }

        if (this.image.complete) {
            if (this.image.naturalWidth > 0) {
                this.imageReady = true;
                this.image.hidden = false;
            }
            else if (this.image.src) {
                this.handleImageError();
                return;
            }
        }

        if (this.audio.readyState >= 1) {
            this.metadataReady = true;
            this.applyInitialCue();
        }
        this.audioReady = this.audio.readyState >= 2;
        this.markReady();
    }

    markReady() {
        if (!this.metadataReady || !this.audioReady || !this.imageReady ||
            this.initialCueState !== "ready" ||
            this.readinessState !== "pending") {
            return;
        }
        this.readinessState = "ready";
        this.status?.remove();
        this.status = null;
        this.setHealth("ready", null);
        this.settleReadinessWaiters("resolve");
        this.notifyTransport();
    }

    failReadiness(reason) {
        if (this.readinessState !== "pending") return;
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

    getPlayableEnd(duration) {
        if (duration <= 0) return 0;
        return Math.max(0, duration - Math.min(0.05, duration));
    }

    getAudioMimeType(url) {
        let pathname;
        try {
            pathname = new URL(url).pathname.toLowerCase();
        }
        catch {
            return null;
        }
        const types = {
            ".mp3": "audio/mpeg",
            ".m4a": "audio/mp4",
            ".aac": "audio/aac",
            ".wav": "audio/wav",
            ".ogg": "audio/ogg",
            ".oga": "audio/ogg",
            ".opus": "audio/ogg; codecs=opus",
            ".flac": "audio/flac"
        };
        const extension = Object.keys(types).find((candidate) =>
            pathname.endsWith(candidate)
        );
        return extension ? types[extension] : null;
    }

    getAudioErrorReason() {
        const reasons = {
            1: "audio-load-aborted",
            2: "audio-network-error",
            3: "audio-decode-error",
            4: "audio-source-not-supported"
        };
        return reasons[this.audio?.error?.code] || "audio-error";
    }

    getAudioErrorMessage(reason) {
        const messages = {
            "audio-network-error": "Audio network error",
            "audio-decode-error": "Audio decode error",
            "audio-source-not-supported": "Audio format or URL unsupported"
        };
        return messages[reason] || "Audio unavailable";
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.failReadiness("destroyed-before-ready");
        this.notifyTransport();
        if (this.image) {
            this.image.removeEventListener("load", this.handleImageLoad);
            this.image.removeEventListener("error", this.handleImageError);
            this.image.removeAttribute("src");
            this.image.remove();
            this.image = null;
        }
        if (this.audio) {
            this.audio.removeEventListener("loadedmetadata", this.handleLoadedMetadata);
            this.audio.removeEventListener("loadeddata", this.handleAudioReady);
            this.audio.removeEventListener("canplay", this.handleAudioReady);
            this.audio.removeEventListener("seeked", this.handleSeeked);
            this.audio.removeEventListener("playing", this.handlePlaying);
            this.audio.removeEventListener("waiting", this.handleWaiting);
            this.audio.removeEventListener("pause", this.handlePause);
            this.audio.removeEventListener("ended", this.handleEnded);
            this.audio.removeEventListener("error", this.handleAudioError);
            this.audio.removeEventListener("timeupdate", this.handleTransportUpdate);
            this.audio.removeEventListener("durationchange", this.handleTransportUpdate);
            this.audio.pause();
            this.audioSource?.removeAttribute("src");
            this.audioSource?.remove();
            this.audioSource = null;
            this.audio.load();
            this.audio.remove();
            this.audio = null;
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
        if (typeof listener !== "function") return () => {};
        this.healthListeners.add(listener);
        listener(this.health);
        return () => this.healthListeners.delete(listener);
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
