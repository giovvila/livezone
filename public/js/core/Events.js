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

    // Editorial broadcast state
    BROADCAST_STATE_CHANGED: "broadcast:state-changed",

    // Studio scene state
    STUDIO_SCENE_REGISTERED: "studio:scene-registered",
    STUDIO_SCENE_UPDATED: "studio:scene-updated",
    STUDIO_SCENE_UNREGISTERED: "studio:scene-unregistered",
    STUDIO_PREVIEW_CHANGED: "studio:preview-changed",
    STUDIO_PROGRAM_CHANGED: "studio:program-changed",

    // UI
    UI_READY: "ui:ready"

});

export default Events;
