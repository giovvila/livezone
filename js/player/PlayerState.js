/**
 * ==========================================================
 * LIVEZONE Broadcast Engine
 * PlayerState.js
 * TASK-008
 * ==========================================================
 */

const PlayerState = Object.freeze({

    /**
     * Stato iniziale
     */
    IDLE: "IDLE",

    /**
     * Connessione in corso
     */
    CONNECTING: "CONNECTING",

    /**
     * Buffering
     */
    BUFFERING: "BUFFERING",

    /**
     * Stream disponibile
     */
    CONNECTED: "CONNECTED",

    /**
     * Stream online ma non ancora riprodotto
     */
    ONLINE: "ONLINE",

    /**
     * Stream non disponibile
     */
    OFFLINE: "OFFLINE",

    /**
     * Errore
     */
    ERROR: "ERROR",

    /**
     * Controller distrutto
     */
    DESTROYED: "DESTROYED"

});

export default PlayerState;