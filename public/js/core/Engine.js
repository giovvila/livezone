import Logger from "../utils/Logger.js";
/*=====================================================

LIVEZONE Broadcast Engine

Engine.js

Version : 1.1
Build   : 1007.1 - Release Fix 001

=====================================================*/
import EngineConfig from "../core/EngineConfig.js";
import DebugPanel from "../debug/DebugPanel.js";
import LifecycleManager from "./LifecycleManager.js";
import ConfigService from "../services/ConfigService.js";
import Player from "../player/Player.js";
import BroadcastUI from "../ui/BroadcastUI.js";
import NotificationCenter from "../ui/NotificationCenter.js";
import OverlayController from "../ui/OverlayController.js";

import EventBus from "./EventBus.js";
import Events from "./Events.js";

export default class Engine {

    constructor() {
        this.engineConfig = null;
        this.config = null;
        this.player = null;
        this.debugPanel = null;
        this.ui = null;
        this.overlay = null;
        this.notifications = null;
    }

    async start() {
        console.count("[DEBUG] Engine.start()");

        try {
            Logger.info("");
            Logger.info("══════════════════════════════");
            Logger.info("LIVEZONE Broadcast Engine");
            Logger.info("══════════════════════════════");

            LifecycleManager.init();
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

            // Register before Player.init(), so STREAM_READY cannot be missed.
            EventBus.on(Events.STREAM_READY, () => {
                Logger.info("══════════════════════════════");
                console.trace("[DEBUG] ENGINE READY");
                Logger.info("ENGINE READY");
                Logger.info("══════════════════════════════");
            });

            // -------------------------------------------------
            // PLAYER
            // -------------------------------------------------
            // The Player must exist and finish init() before the
            // DebugPanel is attached. StreamMonitor is started by
            // Player.init(), therefore getHealth() is valid afterwards.
            this.player = new Player(this.config);
            await this.player.init();

            // -------------------------------------------------
            // DEBUG PANEL
            // -------------------------------------------------
            const debugContainer = document.getElementById("debug-panel");

            if (debugContainer) {
                this.debugPanel = new DebugPanel(debugContainer);
                this.debugPanel.render();
                this.debugPanel.attach(this.player);
            }
        }
        catch (error) {
            Logger.error(error);
            EventBus.emit(Events.STREAM_ERROR, error);

            const status = document.getElementById("status");

            if (status) {
                status.textContent = "● ERRORE";
            }
        }
    }
}
