/**
 * ============================================================
 * LIVEZONE Broadcast Engine
 * HLSState
 * ------------------------------------------------------------
 * Stati ufficiali del motore HLS.
 * Nessun'altra stringa deve essere usata nel progetto.
 * ============================================================
 */

const HLSState = Object.freeze({

    IDLE: "IDLE",

    CONNECTING: "CONNECTING",

    ONLINE: "ONLINE",

    OFFLINE: "OFFLINE",

    RECONNECTING: "RECONNECTING",

    STOPPING: "STOPPING",

    DESTROYED: "DESTROYED",

    ERROR: "ERROR"

});

export default HLSState;