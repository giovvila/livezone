/**
 * LIVEZONE Broadcast Suite
 * Player v1.0
 *
 * Il Player coordina la riproduzione.
 * Non conosce Hls.js.
 */

import HLSAdapter from "./HLSAdapter.js";

export default class Player {

    constructor(config) {

        this.config = config;
        this.video = document.getElementById("video");

        this.adapter = new HLSAdapter();

    }

    async init() {

        if (!this.video) {
            throw new Error("Elemento VIDEO non trovato.");
        }

        if (!this.config) {
            throw new Error("Configurazione non disponibile.");
        }

        if (!this.config.stream) {
            throw new Error("Configurazione STREAM mancante.");
        }

        if (!this.config.stream.primary) {
            throw new Error("URL HLS non configurato.");
        }

        const stream = this.config.stream.primary;

        console.log("=== PLAYER START ===");
        console.log(stream);

        await this.adapter.connect(
            this.video,
            stream
        );

        console.log("=== PLAYER READY ===");

    }

    stop() {

        this.adapter.disconnect();

    }

    destroy() {

        this.adapter.destroy();

    }

    getState() {

        return this.adapter.getState();

    }

    isConnected() {

        return this.adapter.isConnected();

    }

}