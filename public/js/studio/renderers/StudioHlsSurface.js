export default class StudioHlsSurface {

    constructor({ sourceUrl, onError }) {
        this.sourceUrl = sourceUrl;
        this.onError = onError;
        this.video = null;
        this.hls = null;
        this.destroyed = false;
        this.handleLoadedData = this.handleLoadedData.bind(this);
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
        root.replaceChildren(this.video);
        this.showStatus("Loading live source…", "loading");

        if (this.video.canPlayType("application/vnd.apple.mpegurl")) {
            this.video.src = this.sourceUrl;
            await this.tryPlay();
            return;
        }

        const HlsImplementation = globalThis.Hls;

        if (!HlsImplementation?.isSupported?.()) {
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
                this.onError?.(new Error("Studio HLS renderer failed"));
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
        }
    }

    handleLoadedData() {
        this.status?.remove();
        this.status = null;
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
        this.destroyed = true;
        this.hls?.destroy();
        this.hls = null;

        if (this.video) {
            this.video.removeEventListener("loadeddata", this.handleLoadedData);
            this.video.pause();
            this.video.removeAttribute("src");
            this.video.load();
            this.video.remove();
            this.video = null;
        }

        this.status?.remove();
        this.status = null;
        this.root = null;
    }
}
