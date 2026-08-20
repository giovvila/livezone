export default class StudioMediaUI {

    constructor(root, studioRenderer) {
        this.root = root;
        this.studioRenderer = studioRenderer;
        this.started = false;
        this.snapshot = null;

        this.handlePlay = this.handlePlay.bind(this);
        this.handlePause = this.handlePause.bind(this);
        this.handleRestart = this.handleRestart.bind(this);
        this.render = this.render.bind(this);
    }

    start() {
        if (this.started || !this.root || !this.studioRenderer) {
            return;
        }

        this.section = this.root.querySelector("#studio-media-transport");
        this.restartButton = this.root.querySelector("#studio-media-restart");
        this.playButton = this.root.querySelector("#studio-media-play");
        this.pauseButton = this.root.querySelector("#studio-media-pause");
        this.name = this.root.querySelector("#studio-media-name");
        this.time = this.root.querySelector("#studio-media-time");
        this.state = this.root.querySelector("#studio-media-state");

        if (!this.section || !this.restartButton || !this.playButton ||
            !this.pauseButton || !this.name || !this.time || !this.state ||
            typeof this.studioRenderer.subscribePreviewTransport !==
                "function") {
            return;
        }

        this.restartButton.addEventListener("click", this.handleRestart);
        this.playButton.addEventListener("click", this.handlePlay);
        this.pauseButton.addEventListener("click", this.handlePause);
        this.started = true;
        this.unsubscribe = this.studioRenderer
            .subscribePreviewTransport(this.render);
    }

    destroy() {
        if (!this.started) {
            return;
        }

        this.restartButton.removeEventListener("click", this.handleRestart);
        this.playButton.removeEventListener("click", this.handlePlay);
        this.pauseButton.removeEventListener("click", this.handlePause);
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.snapshot = null;
        this.renderUnavailable();
        this.started = false;
    }

    handlePlay() {
        void this.studioRenderer.playPreviewTransport();
    }

    handlePause() {
        this.studioRenderer.pausePreviewTransport();
    }

    handleRestart() {
        this.studioRenderer.restartPreviewTransport();
    }

    render(snapshot) {
        if (!this.started) {
            return;
        }

        this.snapshot = snapshot;

        if (!snapshot) {
            this.renderUnavailable();
            return;
        }

        const unavailable = ["error", "destroyed", "idle", "loading"].includes(
            snapshot.state
        );

        const kind = snapshot.sourceKind?.toUpperCase();
        this.name.textContent = `— ${snapshot.displayName || snapshot.sourceId}${
            kind ? ` · ${kind}` : ""
        }`;
        this.time.textContent = [
            this.formatTime(snapshot.currentTime),
            this.formatTime(snapshot.duration)
        ].join(" / ");
        this.state.textContent = snapshot.state.toUpperCase();
        this.setButtonsDisabled(
            unavailable,
            unavailable || snapshot.state === "playing" || snapshot.ended,
            unavailable || snapshot.state !== "playing"
        );
    }

    renderUnavailable() {
        this.name.textContent = "— No transport in Preview";
        this.time.textContent = "00:00 / --:--";
        this.state.textContent = "UNAVAILABLE";
        this.setButtonsDisabled(true, true, true);
    }

    setButtonsDisabled(restart, play, pause) {
        this.restartButton.disabled = restart;
        this.playButton.disabled = play;
        this.pauseButton.disabled = pause;
    }

    formatTime(value) {
        if (!Number.isFinite(value) || value < 0) {
            return "--:--";
        }

        const seconds = Math.floor(value);
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainder = seconds % 60;
        const parts = [minutes, remainder].map((part) =>
            String(part).padStart(2, "0")
        );

        return hours > 0
            ? [String(hours).padStart(2, "0"), ...parts].join(":")
            : parts.join(":");
    }
}
