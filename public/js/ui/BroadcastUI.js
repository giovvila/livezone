import Clock from "./Clock.js";
import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import BroadcastStateManager from "../core/BroadcastStateManager.js";

export default class BroadcastUI {

    start() {
        const clock = document.getElementById("clock");
        if (clock) new Clock(clock).start();

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
    }

    bindEvents() {

        EventBus.on(Events.STREAM_READY, () => {
            if (this.splash) this.splash.classList.add("hide");
            this.setStatus("ONLINE", "#00d26a");
            console.log("BroadcastUI → STREAM_READY");
        });

        EventBus.on(Events.STREAM_RECONNECT, () => {
            this.setStatus("RECONNECTING...", "#ffb300");
            console.log("BroadcastUI → STREAM_RECONNECT");
        });

        EventBus.on(Events.STREAM_OFFLINE, () => {
            this.setStatus("OFFLINE", "#ff3b30");
            console.log("BroadcastUI → STREAM_OFFLINE");
        });

        EventBus.on(Events.STREAM_ERROR, () => {
            this.setStatus("ERROR", "#ff3b30");
            console.log("BroadcastUI → STREAM_ERROR");
        });

        EventBus.on(Events.BROADCAST_STATE_CHANGED, () => {
            this.renderBroadcastState(BroadcastStateManager.getState());
        });
    }

    bindBroadcastControls() {
        this.broadcastControls.forEach((control) => {
            control.addEventListener("click", () => {
                BroadcastStateManager.transition(
                    control.dataset.broadcastState,
                    {
                        source: "operator",
                        reason: "manual-control"
                    }
                );
            });
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
