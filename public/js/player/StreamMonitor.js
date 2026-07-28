/*=====================================================

LIVEZONE Broadcast Engine

StreamMonitor.js

Version : 1.0
Build   : 1007.3

=====================================================*/

import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export default class StreamMonitor {

    constructor() {

        this.video = null;
        this.timer = null;

    }

    start(video) {

        this.video = video;

        console.log("[StreamMonitor] START");

        this.registerVideoEvents();

        this.startHeartbeat();

    }

    registerVideoEvents() {

        this.video.addEventListener("playing", () => {

            console.log("[Monitor] PLAYING");

        });

        this.video.addEventListener("waiting", () => {

            console.log("[Monitor] WAITING");

            EventBus.emit(Events.STREAM_BUFFERING);

        });

        this.video.addEventListener("stalled", () => {

            console.log("[Monitor] STALLED");

            EventBus.emit(Events.STREAM_BUFFERING);

        });

        this.video.addEventListener("error", () => {

            console.log("[Monitor] ERROR");

            EventBus.emit(Events.STREAM_ERROR);

        });

    }

    startHeartbeat() {

        this.timer = setInterval(() => {

            if (!this.video) return;

            console.log("[Heartbeat]", {

                currentTime: this.video.currentTime.toFixed(1),

                readyState: this.video.readyState,

                networkState: this.video.networkState,

                paused: this.video.paused

            });

        }, 5000);

    }

    stop() {

        if (this.timer) {

            clearInterval(this.timer);

            this.timer = null;

        }

    }

}