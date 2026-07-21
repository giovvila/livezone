const Events = Object.freeze({

    // Engine
    ENGINE_START: "engine:start",
    ENGINE_STOP: "engine:stop",
    ENGINE_ERROR: "engine:error",

    // Config
    CONFIG_LOADED: "config:loaded",

    // Stream
    STREAM_READY: "stream:ready",
    STREAM_BUFFERING: "stream:buffering",
    STREAM_RECONNECT: "stream:reconnect",
    STREAM_OFFLINE: "stream:offline",
    STREAM_ONLINE: "stream:online",
    STREAM_ERROR: "stream:error",

    // UI
    UI_READY: "ui:ready"

});

export default Events;