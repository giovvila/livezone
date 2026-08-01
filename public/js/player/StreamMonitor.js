/*=====================================================

LIVEZONE Broadcast Engine

Module  : StreamMonitor
Version : 2.0.0
Build   : 1007.6.1
Status  : STABLE

Responsibility
--------------
Monitors the HTML5 video element and emits
broadcast events through EventBus.

Public API
----------
start(video)
stop()
getStatus()

=====================================================*/

import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import StreamHealth from "./StreamHealth.js";

export default class StreamMonitor {

    constructor() {
        this.health = null;

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

        this.onPlaying = this.onPlaying.bind(this);
        this.onWaiting = this.onWaiting.bind(this);
        this.onStalled = this.onStalled.bind(this);
        this.onError = this.onError.bind(this);

    }

    /*=================================================
        PUBLIC API
    =================================================*/

    start(video) {

        if (this.started || !video) {
            return;
        }

        this.video = video;
        this.health = new StreamHealth(video);
        this.started = true;

        this.registerVideoEvents();
        this.startHeartbeat();
        this.updateStatus();

    }

    stop() {

        if (this.timer) {
            clearInterval(this.timer);
            this.health = null;
            this.timer = null;
        }

        this.unregisterVideoEvents();

        this.video = null;
        this.started = false;

    }

    getStatus() {

       if (!this.health) {
    return {
        ...this.status
    };
}

return this.health.getStatus();

    }

    /*=================================================
        VIDEO EVENTS
    =================================================*/

    registerVideoEvents() {

        this.video.addEventListener(
            "playing",
            this.onPlaying
        );

        this.video.addEventListener(
            "waiting",
            this.onWaiting
        );

        this.video.addEventListener(
            "stalled",
            this.onStalled
        );

        this.video.addEventListener(
            "error",
            this.onError
        );

    }

    unregisterVideoEvents() {

        if (!this.video) {
            return;
        }

        this.video.removeEventListener(
            "playing",
            this.onPlaying
        );

        this.video.removeEventListener(
            "waiting",
            this.onWaiting
        );

        this.video.removeEventListener(
            "stalled",
            this.onStalled
        );

        this.video.removeEventListener(
            "error",
            this.onError
        );

    }

    onPlaying() {

        this.updateStatus();

        EventBus.emit(
            Events.STREAM_READY
        );

    }

    onWaiting() {

        this.updateStatus();

        EventBus.emit(
            Events.STREAM_BUFFERING
        );

    }

    onStalled() {

        this.updateStatus();

        EventBus.emit(
            Events.STREAM_BUFFERING
        );

    }

    onError() {

        this.updateStatus();

        EventBus.emit(
            Events.STREAM_ERROR
        );

    }
        /*=================================================
        HEARTBEAT
    =================================================*/

    startHeartbeat() {

        this.timer = setInterval(() => {

            this.updateStatus();

        }, 5000);

    }

    /*=================================================
        STATUS
    =================================================*/

    updateStatus() {

        if (!this.video) {

            this.status.online = false;
            this.status.buffering = false;
            this.status.currentTime = 0;
            this.status.bufferSeconds = 0;
            this.status.readyState = 0;
            this.status.networkState = 0;
            this.status.paused = true;
            this.status.ended = false;

            return;

        }

        let bufferSeconds = 0;

        if (this.video.buffered.length > 0) {

            bufferSeconds =
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
            Number(
                this.video.currentTime.toFixed(1)
            );

        this.status.bufferSeconds =
            Number(
                bufferSeconds.toFixed(2)
            );

        this.status.readyState =
            this.video.readyState;

        this.status.networkState =
            this.video.networkState;

        this.status.paused =
            this.video.paused;

        this.status.ended =
            this.video.ended;

    }

}