import LocalProgramOutputTransport from "../program-output/LocalProgramOutputTransport.js";
import PublicProgramController from "../public/PublicProgramController.js";
import PublicShellController from "../public/PublicShellController.js";

const controller = new PublicProgramController({
    root: document.getElementById("public-program"),
    status: document.getElementById("public-program-status"),
    audioButton: document.getElementById("public-audio-enable"),
    transport: new LocalProgramOutputTransport()
});

controller.start();

const shellController = new PublicShellController({
    page: document.getElementById("public-site"),
    composition: document.querySelector(".public-program__tv"),
    fullscreenButton: document.getElementById("public-fullscreen-toggle"),
    audioUnlock: () => controller.enableAudio()
});

shellController.start();
globalThis.addEventListener("pagehide", () => {
    shellController.destroy();
    controller.destroy();
}, { once: true });
