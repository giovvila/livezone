/**
 * ============================================================
 * LIVEZONE Broadcast Engine
 * Session Manager
 * Version 0.8-dev
 * ============================================================
 */

const Session = {

    version: "0.8-dev",

    engine: "STOPPED",

    player: "IDLE",

    stream: "OFFLINE",

    ui: "BOOT",

    reconnects: 0,

    startedAt: null,

    bitrate: 0,

    resolution: "",

    fps: 0,

    audio: false,

    lastError: null,

    lastReconnect: null

};

export default Session;
