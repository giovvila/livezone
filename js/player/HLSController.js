/**
 * ==========================================================
 * LIVEZONE Broadcast Engine
 * HLSController.js
 * TASK-006 REV-1
 * Compatibile con HLSAdapter v1.1
 * ==========================================================
 */

import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";
import HLSAdapter from "./HLSAdapter.js";

export default class HLSController {

    constructor(options = {}) {

        this.video = null;
        this.url = null;

        this.adapter = new HLSAdapter();

        this.initialized = false;
        this.destroyed = false;

        this.autoplay = options.autoplay ?? true;
        this.muted = options.muted ?? false;
        this.volume = options.volume ?? 1;

        this.state = "IDLE";

        this.listeners = [];

        this.bindEvents();
    }

    /**
     * ----------------------------------------------------------
     * EventBus
     * ----------------------------------------------------------
     */

    bindEvents() {

        this.onStreamReady = () => {

            this.state = "CONNECTED";

            if (this.video) {

                this.video.volume = this.volume;
                this.video.muted = this.muted;
            }

            EventBus.emit(Events.PLAYER_READY);
        };

        this.onStreamOffline = () => {

            this.state = "OFFLINE";

            EventBus.emit(Events.PLAYER_OFFLINE);
        };

        this.onStreamReconnect = () => {

            this.state = "CONNECTING";

            EventBus.emit(Events.PLAYER_CONNECTING);
        };

        this.onStreamError = (err) => {

            this.state = "ERROR";

            EventBus.emit(Events.PLAYER_ERROR, err);
        };

        EventBus.on(Events.STREAM_READY, this.onStreamReady);
        EventBus.on(Events.STREAM_OFFLINE, this.onStreamOffline);
        EventBus.on(Events.STREAM_RECONNECT, this.onStreamReconnect);
        EventBus.on(Events.STREAM_ERROR, this.onStreamError);

        this.listeners.push(
            [Events.STREAM_READY, this.onStreamReady],
            [Events.STREAM_OFFLINE, this.onStreamOffline],
            [Events.STREAM_RECONNECT, this.onStreamReconnect],
            [Events.STREAM_ERROR, this.onStreamError]
        );
    }

    /**
     * ----------------------------------------------------------
     * Inizializzazione
     * ----------------------------------------------------------
     */

    init(videoElement) {

        if (!videoElement) {
            throw new Error("Video element non valido");
        }

        this.video = videoElement;

        this.video.autoplay = this.autoplay;
        this.video.muted = this.muted;
        this.video.volume = this.volume;

        this.initialized = true;

        return this;
    }

    /**
     * ----------------------------------------------------------
     * Caricamento stream
     * ----------------------------------------------------------
     */

    async load(url) {

        if (!this.initialized) {
            throw new Error("HLSController non inizializzato");
        }

        if (!url) {
            throw new Error("URL HLS non valido");
        }

        this.url = url;
        this.state = "CONNECTING";

        await this.adapter.connect(this.video, url);

        return this;
    }

    /**
     * ----------------------------------------------------------
     * Riproduzione
     * ----------------------------------------------------------
     */

    async play() {

        if (!this.video) return;

        try {

            await this.video.play();

        } catch (e) {

            console.warn(e);

        }

    }

    /**
     * ----------------------------------------------------------
     * Pausa
     * ----------------------------------------------------------
     */

    pause() {

        if (!this.video) return;

        this.video.pause();

    }
    /**
     * ----------------------------------------------------------
     * Stop
     * ----------------------------------------------------------
     */

    stop() {

        if (!this.video) return;

        this.video.pause();

        try {
            this.video.currentTime = 0;
        } catch (e) {}

    }

    /**
     * ----------------------------------------------------------
     * Audio
     * ----------------------------------------------------------
     */

    mute() {

        if (!this.video) return;

        this.video.muted = true;
        this.muted = true;

    }

    unmute() {

        if (!this.video) return;

        this.video.muted = false;
        this.muted = false;

    }

    toggleMute() {

        if (!this.video) return;

        this.video.muted = !this.video.muted;
        this.muted = this.video.muted;

        return this.muted;

    }

    /**
     * ----------------------------------------------------------
     * Volume
     * ----------------------------------------------------------
     */

    setVolume(value) {

        if (!this.video) return;

        const volume = Math.max(0, Math.min(1, value));

        this.volume = volume;
        this.video.volume = volume;

    }

    getVolume() {

        return this.volume;

    }

    /**
     * ----------------------------------------------------------
     * Fullscreen
     * ----------------------------------------------------------
     */

    async enterFullscreen() {

        if (!this.video) return;

        try {

            if (this.video.requestFullscreen) {
                await this.video.requestFullscreen();
            } else if (this.video.webkitRequestFullscreen) {
                this.video.webkitRequestFullscreen();
            } else if (this.video.msRequestFullscreen) {
                this.video.msRequestFullscreen();
            }

        } catch (e) {

            console.warn("Fullscreen non disponibile", e);

        }

    }

    async exitFullscreen() {

        try {

            if (document.fullscreenElement) {
                await document.exitFullscreen();
            }

        } catch (e) {}

    }

    /**
     * ----------------------------------------------------------
     * Seek
     * ----------------------------------------------------------
     */

    seek(seconds) {

        if (!this.video) return;

        try {

            this.video.currentTime = seconds;

        } catch (e) {}

    }

    /**
     * ----------------------------------------------------------
     * Getter
     * ----------------------------------------------------------
     */

    getCurrentTime() {

        return this.video ? this.video.currentTime : 0;

    }

    getDuration() {

        return this.video ? this.video.duration : 0;

    }

    isPlaying() {

        if (!this.video) return false;

        return (
            !this.video.paused &&
            !this.video.ended &&
            this.video.readyState > 2
        );

    }

    isMuted() {

        return this.muted;

    }

    isConnected() {

        return this.adapter.isConnected();

    }

    getState() {

        return this.adapter.getState();

    }

    getVideoElement() {

        return this.video;

    }

    getAdapter() {

        return this.adapter;

    }
    /**
     * ----------------------------------------------------------
     * Disconnessione
     * ----------------------------------------------------------
     */

    disconnect() {

        if (this.destroyed) return;

        this.adapter.disconnect();
        this.state = "DISCONNECTED";

        EventBus.emit(Events.PLAYER_DISCONNECTED);

    }

    /**
     * ----------------------------------------------------------
     * Reload stream
     * ----------------------------------------------------------
     */

    async reload() {

        if (!this.video || !this.url) return;

        this.disconnect();

        await this.load(this.url);

    }

    /**
     * ----------------------------------------------------------
     * Destroy
     * ----------------------------------------------------------
     */

    destroy() {

        if (this.destroyed) return;

        this.destroyed = true;

        // Rimuove tutti i listener EventBus
        for (const [event, handler] of this.listeners) {

            if (typeof EventBus.off === "function") {
                EventBus.off(event, handler);
            }

        }

        this.listeners = [];

        // Distrugge HLSAdapter
        if (this.adapter) {
            this.adapter.destroy();
        }

        // Pulizia elemento video
        if (this.video) {

            try {
                this.video.pause();
            } catch (e) {}

            try {
                this.video.removeAttribute("src");
                this.video.load();
            } catch (e) {}

        }

        this.video = null;
        this.url = null;

        this.initialized = false;
        this.state = "DESTROYED";

        EventBus.emit(Events.PLAYER_DESTROYED);

    }

}
