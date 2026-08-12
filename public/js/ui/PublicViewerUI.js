import Clock from "./Clock.js";
import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export default class PublicViewerUI {

    constructor() {
        this.started = false;
        this.handleReady = () => this.renderConnection("ONLINE", "#00d26a", "live");
        this.handleReconnect = () => this.renderConnection("RECONNECTING...", "#ffb300", "break");
        this.handleOffline = () => this.renderConnection("OFFLINE", "#ff3b30", "offline");
        this.handleError = () => this.renderConnection("ERROR", "#ff3b30", "offline");
        this.handleFullscreenToggle = this.handleFullscreenToggle.bind(this);
        this.handleFullscreenChange = this.handleFullscreenChange.bind(this);
    }

    start() {
        if (this.started) {
            return;
        }

        this.status = document.getElementById("status");
        this.connectionBadge = document.querySelector(".live-badge");
        this.connectionLabel = document.getElementById("connection-state-label");
        this.playerWrapper = document.querySelector(".player-wrapper");
        this.fullscreenToggle = document.getElementById(
            "viewer-fullscreen-toggle"
        );

        const clock = document.getElementById("clock");

        if (clock) {
            this.clock = new Clock(clock);
            this.clock.start();
        }

        EventBus.on(Events.STREAM_READY, this.handleReady);
        EventBus.on(Events.STREAM_RECONNECT, this.handleReconnect);
        EventBus.on(Events.STREAM_OFFLINE, this.handleOffline);
        EventBus.on(Events.STREAM_ERROR, this.handleError);

        if (
            this.playerWrapper?.requestFullscreen &&
            typeof document.exitFullscreen === "function"
        ) {
            this.fullscreenToggle?.addEventListener(
                "click",
                this.handleFullscreenToggle
            );
            document.addEventListener(
                "fullscreenchange",
                this.handleFullscreenChange
            );
        }
        else if (this.fullscreenToggle) {
            this.fullscreenToggle.hidden = true;
        }

        this.started = true;
    }

    destroy() {
        if (!this.started) {
            return;
        }

        EventBus.off(Events.STREAM_READY, this.handleReady);
        EventBus.off(Events.STREAM_RECONNECT, this.handleReconnect);
        EventBus.off(Events.STREAM_OFFLINE, this.handleOffline);
        EventBus.off(Events.STREAM_ERROR, this.handleError);
        this.fullscreenToggle?.removeEventListener(
            "click",
            this.handleFullscreenToggle
        );
        document.removeEventListener(
            "fullscreenchange",
            this.handleFullscreenChange
        );
        this.started = false;
    }

    async handleFullscreenToggle() {
        try {
            if (document.fullscreenElement === this.playerWrapper) {
                await document.exitFullscreen();
                return;
            }

            await this.playerWrapper.requestFullscreen();

            if (
                document.fullscreenElement === this.playerWrapper &&
                typeof screen.orientation?.lock === "function"
            ) {
                try {
                    await screen.orientation.lock("landscape");
                }
                catch {
                    // Orientation locking is best-effort and may be rejected.
                }
            }
        }
        catch {
            // Native video controls remain available when wrapper fullscreen fails.
        }
    }

    handleFullscreenChange() {
        const isFullscreen = document.fullscreenElement === this.playerWrapper;

        if (this.fullscreenToggle) {
            const action = isFullscreen ? "Exit fullscreen" : "Enter fullscreen";

            this.fullscreenToggle.setAttribute(
                "aria-pressed",
                String(isFullscreen)
            );
            this.fullscreenToggle.setAttribute("aria-label", action);
            this.fullscreenToggle.title = action;
            this.fullscreenToggle.textContent = isFullscreen
                ? "EXIT FULLSCREEN"
                : "FULLSCREEN";
        }

        if (!isFullscreen && typeof screen.orientation?.unlock === "function") {
            try {
                screen.orientation.unlock();
            }
            catch {
                // Unlocking is also best-effort across browser implementations.
            }
        }
    }

    renderConnection(label, color, variant) {
        if (this.status) {
            this.status.textContent = `● ${label}`;
            this.status.style.color = color;
        }

        if (!this.connectionBadge || !this.connectionLabel) {
            return;
        }

        this.connectionBadge.classList.remove(
            "broadcast-live",
            "broadcast-break",
            "broadcast-offline",
            "broadcast-program"
        );
        this.connectionBadge.classList.add(`broadcast-${variant}`);
        this.connectionLabel.textContent = `SIGNAL · ${label}`;
    }
}
