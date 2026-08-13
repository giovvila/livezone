import PlaybackRuntime from "../runtime/PlaybackRuntime.js";
import AdaptivePlayer from "../core/AdaptivePlayer.js";
import BroadcastStateManager from "../core/BroadcastStateManager.js";
import StudioStateManager from "../core/StudioStateManager.js";
import BroadcastUI from "../ui/BroadcastUI.js";
import StudioUI from "../ui/StudioUI.js";
import StudioGraphicsUI from "../ui/StudioGraphicsUI.js";
import OverlayController from "../ui/OverlayController.js";
import NotificationCenter from "../ui/NotificationCenter.js";
import DebugPanel from "../debug/DebugPanel.js";
import StudioBootstrap from "../studio/StudioBootstrap.js";
import StudioRenderer from "../studio/StudioRenderer.js";
import StudioSourceManager from "../studio/StudioSourceManager.js";
import StudioGraphicsManager from "../studio/StudioGraphicsManager.js";
import StudioTransitionCoordinator from "../studio/StudioTransitionCoordinator.js";

const adaptivePlayer = new AdaptivePlayer(
    document.querySelector(".player-wrapper"),
    document.getElementById("video")
);

adaptivePlayer.start();

BroadcastStateManager.initialize();
StudioStateManager.initialize();

const runtime = new PlaybackRuntime();
const studioBootstrap = new StudioBootstrap({
    studioStateManager: StudioStateManager,
    studioSourceManager: StudioSourceManager,
    studioGraphicsManager: StudioGraphicsManager
});
let broadcastUI = null;
let studioUI = null;
let studioGraphicsUI = null;
let studioRenderer = null;
let studioTransitionCoordinator = null;

runtime.start({
    async beforePlayerStart(config) {
        broadcastUI = new BroadcastUI();
        broadcastUI.start(config);

        StudioSourceManager.initialize(config);
        StudioGraphicsManager.initialize();

        const bootstrapReport = await studioBootstrap.initialize();

        if (bootstrapReport.status !== "ready") {
            console.warn("[StudioBootstrap]", bootstrapReport);
        }

        studioRenderer = new StudioRenderer({
            previewRoot: document.getElementById("studio-preview-renderer"),
            programRoot: document.getElementById("studio-program-renderer"),
            studioStateManager: StudioStateManager,
            definitionRegistry: studioBootstrap,
            studioSourceManager: StudioSourceManager,
            studioGraphicsManager: StudioGraphicsManager
        });
        studioRenderer.start();

        studioTransitionCoordinator = new StudioTransitionCoordinator({
            studioStateManager: StudioStateManager,
            studioRenderer
        });
        studioTransitionCoordinator.start();

        studioUI = new StudioUI(
            document.getElementById("studio-panel"),
            studioTransitionCoordinator
        );
        studioUI.start();

        studioGraphicsUI = new StudioGraphicsUI(
            document.getElementById("studio-panel"),
            StudioGraphicsManager
        );
        studioGraphicsUI.start();

        new OverlayController();
        new NotificationCenter();
    }
}).then(({ player }) => {
    const debugContainer = document.getElementById("debug-panel");

    if (!debugContainer) {
        return;
    }

    const debugPanel = new DebugPanel(debugContainer);
    debugPanel.render();
    debugPanel.attach(player);
}).catch(() => {
    // PlaybackRuntime already reports the startup failure to the UI/EventBus.
});
