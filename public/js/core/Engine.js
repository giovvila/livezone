import ConfigService from "../services/ConfigService.js";
import Player from "../player/Player.js";
import BroadcastUI from "../ui/BroadcastUI.js";

import EventBus from "./EventBus.js";
import Events from "./Events.js";

export default class Engine {

    constructor() {

        this.config = null;
        this.player = null;
        this.ui = null;

    }

    async start() {

        try {

            console.log("=== LIVEZONE ENGINE START ===");

            EventBus.emit(Events.ENGINE_START);

            this.config = await ConfigService.load();

            EventBus.emit(Events.CONFIG_LOADED, this.config);

            this.ui = new BroadcastUI();

            this.ui.start(this.config);

            EventBus.emit(Events.UI_READY);

            this.player = new Player(this.config);

            this.player.init();

            EventBus.on(Events.STREAM_READY, ()=>{
                EventBus.emit(Events.PLAYER_READY);
                console.log("=== ENGINE READY ===");
            });

        }
        catch (error) {

            console.error(error);

            EventBus.emit(Events.STREAM_ERROR, error);

            const status = document.getElementById("status");

            if (status) {

                status.textContent = "● ERRORE";

            }

        }

    }

}