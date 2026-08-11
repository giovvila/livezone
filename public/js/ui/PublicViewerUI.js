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
    }

    start() {
        if (this.started) {
            return;
        }

        this.status = document.getElementById("status");
        this.connectionBadge = document.querySelector(".live-badge");
        this.connectionLabel = document.getElementById("connection-state-label");

        const clock = document.getElementById("clock");

        if (clock) {
            this.clock = new Clock(clock);
            this.clock.start();
        }

        EventBus.on(Events.STREAM_READY, this.handleReady);
        EventBus.on(Events.STREAM_RECONNECT, this.handleReconnect);
        EventBus.on(Events.STREAM_OFFLINE, this.handleOffline);
        EventBus.on(Events.STREAM_ERROR, this.handleError);

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
        this.started = false;
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
