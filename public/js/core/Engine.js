/**
 * ==========================================
 * LIVEZONE Broadcast Engine
 * Engine.js
 * Version: 0.5-dev
 * ==========================================
 */

import Player from "../player/Player.js";

export default class Engine {

    constructor(config) {

        this.config = config;
        this.player = null;

    }

    async start() {

        console.log("================================");
        console.log("LIVEZONE Broadcast Engine");
        console.log("Version 0.5-dev");
        console.log("================================");

        this.player = new Player(this.config);

        await this.player.init();

        console.log("Engine avviato.");

    }

}