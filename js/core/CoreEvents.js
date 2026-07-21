/**
 * ============================================================
 * LIVEZONE Broadcast Engine
 * Core Events
 * ------------------------------------------------------------
 * Elenco ufficiale degli eventi del Broadcast Engine.
 * ============================================================
 */

const CoreEvents = Object.freeze({

    // STREAM

    STREAM_CONNECTING: "stream:connecting",

    STREAM_ONLINE: "stream:online",

    STREAM_OFFLINE: "stream:offline",

    STREAM_RECONNECT: "stream:reconnect",

    STREAM_ERROR: "stream:error",

    // PLAYER

    PLAYER_READY: "player:ready",

    PLAYER_PLAYING: "player:playing",

    PLAYER_STOPPED: "player:stopped",

    PLAYER_DESTROYED: "player:destroyed",

    // ENGINE

    ENGINE_READY: "engine:ready",

    ENGINE_STOPPED: "engine:stopped"

});

export default CoreEvents;