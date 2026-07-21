/**
 * ============================================================
 * LIVEZONE Broadcast Engine
 * Video Events
 * ------------------------------------------------------------
 * Traduce gli eventi HTML5 <video> negli eventi del Core.
 * Non conosce HLS.js.
 * ============================================================
 */

import EventBus from "../core/EventBus.js";
import CoreEvents from "../core/CoreEvents.js";
import Logger from "../utils/Logger.js";

export default class VideoEvents {

    constructor(video) {

        this.video = video;
        this.bound = false;

    }

    bind() {

        if (this.bound) {
            return;
        }

        this.bound = true;

        this.video.addEventListener("playing", this.onPlaying);
        this.video.addEventListener("waiting", this.onWaiting);
        this.video.addEventListener("stalled", this.onStalled);
        this.video.addEventListener("pause", this.onPause);
        this.video.addEventListener("ended", this.onEnded);
        this.video.addEventListener("error", this.onError);

    }

    unbind() {

        if (!this.bound) {
            return;
        }

        this.bound = false;

        this.video.removeEventListener("playing", this.onPlaying);
        this.video.removeEventListener("waiting", this.onWaiting);
        this.video.removeEventListener("stalled", this.onStalled);
        this.video.removeEventListener("pause", this.onPause);
        this.video.removeEventListener("ended", this.onEnded);
        this.video.removeEventListener("error", this.onError);

    }

    onPlaying = () => {

        Logger.success("Video PLAYING");

        EventBus.emit(CoreEvents.STREAM_ONLINE);

    };

    onWaiting = () => {

        Logger.warn("Video BUFFERING");

        EventBus.emit(CoreEvents.STREAM_CONNECTING);

    };

    onStalled = () => {

        Logger.warn("Video STALLED");

        EventBus.emit(CoreEvents.STREAM_OFFLINE);

    };

    onPause = () => {

        Logger.info("Video PAUSED");

    };

    onEnded = () => {

        Logger.warn("Video ENDED");

        EventBus.emit(CoreEvents.PLAYER_STOPPED);

    };

    onError = () => {

        Logger.error("Video ERROR");

        EventBus.emit(CoreEvents.STREAM_ERROR);

    };

}