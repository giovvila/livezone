import Logger from "../utils/Logger.js";
import LifecycleManager from "../core/LifecycleManager.js";
import ConfigService from "../services/ConfigService.js";
import Player from "../player/Player.js";
import EventBus from "../core/EventBus.js";
import Events from "../core/Events.js";

export default class PlaybackRuntime {

    constructor({ configUrl } = {}) {
        this.configUrl = configUrl;
        this.config = null;
        this.player = null;
        this.startPromise = null;
        this.handleStreamReady = this.handleStreamReady.bind(this);
    }

    start({ beforePlayerStart, startPlayer = true } = {}) {
        if (this.startPromise) {
            return this.startPromise;
        }

        this.startPromise = this.startInternal(beforePlayerStart, startPlayer);
        return this.startPromise;
    }

    async startInternal(beforePlayerStart, startPlayer) {
        try {
            Logger.info("");
            Logger.info("══════════════════════════════");
            Logger.info("LIVEZONE Broadcast Engine");
            Logger.info("══════════════════════════════");

            LifecycleManager.init();
            EventBus.emit(Events.ENGINE_START);

            this.config = await ConfigService.load(this.configUrl);
            EventBus.emit(Events.CONFIG_LOADED, this.config);

            if (typeof beforePlayerStart === "function") {
                await beforePlayerStart(this.config);
            }

            EventBus.emit(Events.UI_READY);
            EventBus.on(Events.STREAM_READY, this.handleStreamReady);

            if (startPlayer) {
                this.player = new Player(this.config);
                await this.player.init();
            }

            return Object.freeze({
                config: this.config,
                player: this.player
            });
        }
        catch (error) {
            Logger.error(error);
            EventBus.emit(Events.STREAM_ERROR, error);

            const status = document.getElementById("status");

            if (status) {
                status.textContent = "● ERRORE";
            }

            throw error;
        }
    }

    handleStreamReady() {
        Logger.info("══════════════════════════════");
        Logger.info("ENGINE READY");
        Logger.info("══════════════════════════════");
    }
}
