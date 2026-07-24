/*=====================================================

LIVEZONE Broadcast Engine

Engine.js

Version : 1.1
Build   : 1007.1

=====================================================*/

import ConfigService from "../services/ConfigService.js";
import Player from "../player/Player.js";
import BroadcastUI from "../ui/BroadcastUI.js";
import NotificationCenter from "../ui/NotificationCenter.js";
import OverlayController from "../ui/OverlayController.js";

import EventBus from "./EventBus.js";
import Events from "./Events.js";

export default class Engine {

    constructor() {

        this.config = null;
        this.player = null;
        this.ui = null;
        this.overlay = null;
        this.notifications = null;

    }

    async start() {

        try {

            console.log("");
            console.log("══════════════════════════════");
            console.log("LIVEZONE Broadcast Engine");
            console.log("══════════════════════════════");

            EventBus.emit(Events.ENGINE_START);

            // -------------------------------------------------
            // CONFIG
            // -------------------------------------------------

            this.config = await ConfigService.load();

            EventBus.emit(Events.CONFIG_LOADED, this.config);

            // -------------------------------------------------
            // UI
            // -------------------------------------------------

            this.ui = new BroadcastUI();

            this.ui.start(this.config);

            this.overlay = new OverlayController();

            this.notifications = new NotificationCenter();

            EventBus.emit(Events.UI_READY);

            // -------------------------------------------------
            // PLAYER
            // -------------------------------------------------

            this.player = new Player(this.config);

            this.player.init();

            // -------------------------------------------------
            // ENGINE READY
            // -------------------------------------------------

            EventBus.on(Events.STREAM_READY, () => {

                

                console.log("══════════════════════════════");
                console.log("ENGINE READY");
                console.log("══════════════════════════════");

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