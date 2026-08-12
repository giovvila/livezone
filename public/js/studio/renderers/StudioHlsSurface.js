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
        this.handleLoadedData = this.handleLoadedData.bind(this);
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
        this.video.addEventListener("loadeddata", this.handleLoadedData);
        this.video.addEventListener("waiting", this.handleWaiting);
        this.video.addEventListener("ended", this.handleEnded);
        this.video.addEventListener("error", this.handleNativeError);
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
        this.status?.remove();
        this.status = null;
        this.setHealth("ready", null);
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
        this.hls?.destroy();
        this.hls = null;

        if (this.video) {
            this.video.removeEventListener("loadeddata", this.handleLoadedData);
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
