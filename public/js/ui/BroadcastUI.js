import Clock from "./Clock.js";
import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import BroadcastStateManager from "../core/BroadcastStateManager.js";

export default class BroadcastUI {

    constructor() {
        this.started = false;
        this.clock = null;
        this.broadcastControls = [];
        this.controlHandlers = new Map();

        this.handleStreamReady = this.handleStreamReady.bind(this);
        this.handleStreamReconnect = this.handleStreamReconnect.bind(this);
        this.handleStreamOffline = this.handleStreamOffline.bind(this);
        this.handleStreamError = this.handleStreamError.bind(this);
        this.handleBroadcastStateChanged =
            this.handleBroadcastStateChanged.bind(this);
    }

    start() {
        if (this.started) {
            return;
        }

        const clock = document.getElementById("clock");

        if (clock && !this.clock) {
            this.clock = new Clock(clock);
            this.clock.start();
        }

        this.status = document.getElementById("status");
        this.splash = document.getElementById("splash");
        this.liveBadge = document.querySelector(".live-badge");
        this.broadcastStateLabel = document.getElementById(
            "broadcast-state-label"
        );
        this.broadcastControls = document.querySelectorAll(
            "[data-broadcast-state]"
        );

        this.renderBroadcastState(BroadcastStateManager.getState());
        this.bindEvents();
        this.bindBroadcastControls();
        this.started = true;
    }

    destroy() {
        if (!this.started) {
            return;
        }

        EventBus.off(Events.STREAM_READY, this.handleStreamReady);
        EventBus.off(Events.STREAM_RECONNECT, this.handleStreamReconnect);
        EventBus.off(Events.STREAM_OFFLINE, this.handleStreamOffline);
        EventBus.off(Events.STREAM_ERROR, this.handleStreamError);
        EventBus.off(
            Events.BROADCAST_STATE_CHANGED,
            this.handleBroadcastStateChanged
        );

        this.controlHandlers.forEach((handler, control) => {
            control.removeEventListener("click", handler);
        });

        this.controlHandlers.clear();
        this.broadcastControls = [];
        this.status = null;
        this.splash = null;
        this.liveBadge = null;
        this.broadcastStateLabel = null;
        this.started = false;
    }

    bindEvents() {

        EventBus.on(Events.STREAM_READY, this.handleStreamReady);
        EventBus.on(Events.STREAM_RECONNECT, this.handleStreamReconnect);
        EventBus.on(Events.STREAM_OFFLINE, this.handleStreamOffline);
        EventBus.on(Events.STREAM_ERROR, this.handleStreamError);
        EventBus.on(
            Events.BROADCAST_STATE_CHANGED,
            this.handleBroadcastStateChanged
        );
    }

    handleStreamReady() {
        if (this.splash) this.splash.classList.add("hide");
        this.setStatus("ONLINE", "#00d26a");
        console.log("BroadcastUI → STREAM_READY");
    }

    handleStreamReconnect() {
        this.setStatus("RECONNECTING...", "#ffb300");
        console.log("BroadcastUI → STREAM_RECONNECT");
    }

    handleStreamOffline() {
        this.setStatus("OFFLINE", "#ff3b30");
        console.log("BroadcastUI → STREAM_OFFLINE");
    }

    handleStreamError() {
        this.setStatus("ERROR", "#ff3b30");
        console.log("BroadcastUI → STREAM_ERROR");
    }

    handleBroadcastStateChanged() {
        this.renderBroadcastState(BroadcastStateManager.getState());
    }

    bindBroadcastControls() {
        this.broadcastControls.forEach((control) => {
            const handler = () => {
                BroadcastStateManager.transition(
                    control.dataset.broadcastState,
                    {
                        source: "operator",
                        reason: "manual-control"
                    }
                );
            };

            this.controlHandlers.set(control, handler);
            control.addEventListener("click", handler);
        });
    }

    setStatus(text, color){
        if(!this.status) return;
        this.status.textContent = "● " + text;
        this.status.style.color = color;
    }

    renderBroadcastState(state){
        if(!this.liveBadge || !this.broadcastStateLabel) return;

        const classes=[
            "broadcast-live",
            "broadcast-break",
            "broadcast-offline",
            "broadcast-program"
        ];

        this.liveBadge.classList.remove(...classes);
        this.liveBadge.classList.add(`broadcast-${state.toLowerCase()}`);
        this.broadcastStateLabel.textContent=`BROADCAST · ${state}`;

        this.broadcastControls.forEach((control) => {
            const isActive = control.dataset.broadcastState === state;
            control.classList.toggle("broadcast-control--active", isActive);
            control.setAttribute("aria-pressed", String(isActive));
        });
    }
}
