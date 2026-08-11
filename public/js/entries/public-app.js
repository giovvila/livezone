import PlaybackRuntime from "../runtime/PlaybackRuntime.js";
import AdaptivePlayer from "../core/AdaptivePlayer.js";
import PublicViewerUI from "../ui/PublicViewerUI.js";
import OverlayController from "../ui/OverlayController.js";
import NotificationCenter from "../ui/NotificationCenter.js";

const adaptivePlayer = new AdaptivePlayer(
    document.querySelector(".player-wrapper"),
    document.getElementById("video")
);

adaptivePlayer.start();

const runtime = new PlaybackRuntime();

runtime.start({
    beforePlayerStart() {
        new PublicViewerUI().start();
        new OverlayController();
        new NotificationCenter();
    }
}).catch(() => {
    // PlaybackRuntime already reports the startup failure to the UI/EventBus.
});
