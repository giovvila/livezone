/*=====================================================

LIVEZONE Broadcast Engine

StreamMonitor.js

Version : 1.1
Build   : 1007.3 Stable

=====================================================*/

import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export default class StreamMonitor {

    constructor() {

        this.video = null;
        this.timer = null;
        this.started = false;
        this.status = {
    online: false,
    buffering: false,
    currentTime: 0,
    bufferSeconds: 0,
    readyState: 0,
    networkState: 0,
    paused: true,
    ended: false
};

    }

    start(video) {

        if (this.started) {
            return;
        }

        this.started = true;

        this.video = video;

        console.log("[StreamMonitor] START");

        this.registerVideoEvents();

        this.startHeartbeat();

    }

    registerVideoEvents() {

        this.video.addEventListener("playing", () => {

            console.log("[Monitor] PLAYING");
console.count("[DEBUG] StreamMonitor emits READY");
            EventBus.emit(Events.STREAM_READY);

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

            if (!this.video) {
                return;
            }

            console.table(

    this.getStatus()

);

        }, 5000);

    }
    getStatus() {

    if (!this.video) {

        return { ...this.status };

    }

    let buffer = 0;

    if (this.video.buffered.length > 0) {

        buffer =
            this.video.buffered.end(
                this.video.buffered.length - 1
            ) - this.video.currentTime;

    }

    this.status.online =
        !this.video.paused &&
        !this.video.ended;

    this.status.buffering =
        this.video.readyState < 3;

    this.status.currentTime =
        Number(this.video.currentTime.toFixed(1));

    this.status.bufferSeconds =
        Number(buffer.toFixed(2));

    this.status.readyState =
        this.video.readyState;

    this.status.networkState =
        this.video.networkState;

    this.status.paused =
        this.video.paused;

    this.status.ended =
        this.video.ended;

    return { ...this.status };

}

    stop() {

        if (this.timer) {

            clearInterval(this.timer);

            this.timer = null;

        }

        this.started = false;

    }
    getStatus() {

    if (!this.video) {

        return {
            online: false,
            buffering: false,
            currentTime: 0,
            bufferSeconds: 0,
            readyState: 0,
            networkState: 0,
            paused: true,
            ended: false
        };

    }

    let bufferSeconds = 0;

    if (this.video.buffered.length > 0) {

        bufferSeconds =
            this.video.buffered.end(
                this.video.buffered.length - 1
            ) - this.video.currentTime;

    }

    return {

        online:
            !this.video.paused &&
            !this.video.ended,

        buffering:
            this.video.readyState < 3,

        currentTime:
            Number(this.video.currentTime.toFixed(1)),

        bufferSeconds:
            Number(bufferSeconds.toFixed(2)),

        readyState:
            this.video.readyState,

        networkState:
            this.video.networkState,

        paused:
            this.video.paused,

        ended:
            this.video.ended

    };

}

}