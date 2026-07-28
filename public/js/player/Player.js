/**
 * LIVEZONE Broadcast Suite
 * Player v1.1
 *
 * Il Player coordina la riproduzione.
 * Non conosce Hls.js.
 */

import HLSAdapter from "./HLSAdapter.js";
import StreamMonitor from "./StreamMonitor.js";

export default class Player {

    constructor(config) {

        this.config = config;

        this.video = document.getElementById("video");

        this.adapter = new HLSAdapter();

        this.monitor = new StreamMonitor();

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

        // Avvia il monitor dello stream
        this.monitor.start(this.video);

    }

    stop() {

        this.monitor.stop();

        this.adapter.disconnect();

    }

    destroy() {

        this.monitor.stop();

        this.adapter.destroy();

    }

    getState() {

        return this.adapter.getState();

    }

    isConnected() {

        return this.adapter.isConnected();

    }

}