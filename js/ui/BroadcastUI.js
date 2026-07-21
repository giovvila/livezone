import Clock from "./Clock.js";
import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export default class BroadcastUI {

    start() {
        const clock = document.getElementById("clock");
        if (clock) new Clock(clock).start();

        this.status = document.getElementById("status");
        this.splash = document.getElementById("splash");
        this.liveBadge = document.querySelector(".live-badge");
        this.liveDot = document.querySelector(".live-dot");

        this.bindEvents();
    }

    bindEvents() {

        EventBus.on(Events.STREAM_READY, () => {
            if (this.splash) this.splash.classList.add("hide");
            this.setStatus("ONLINE", "#00d26a");
            this.setLive(true);
            console.log("BroadcastUI → STREAM_READY");
        });

        EventBus.on(Events.STREAM_RECONNECT, () => {
            this.setStatus("RECONNECTING...", "#ffb300");
            this.setLive(false);
            console.log("BroadcastUI → STREAM_RECONNECT");
        });

        EventBus.on(Events.STREAM_OFFLINE, () => {
            this.setStatus("OFFLINE", "#ff3b30");
            this.setLive(false);
            console.log("BroadcastUI → STREAM_OFFLINE");
        });

        EventBus.on(Events.STREAM_ERROR, () => {
            this.setStatus("ERROR", "#ff3b30");
            this.setLive(false);
            console.log("BroadcastUI → STREAM_ERROR");
        });
    }

    setStatus(text, color){
        if(!this.status) return;
        this.status.textContent = "● " + text;
        this.status.style.color = color;
    }

    setLive(enabled){
        if(!this.liveBadge || !this.liveDot) return;
        this.liveBadge.style.opacity = enabled ? "1" : "0.5";
        this.liveDot.style.animationPlayState = enabled ? "running" : "paused";
    }
}
