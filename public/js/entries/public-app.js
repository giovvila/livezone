import { createProgramOutputTransport } from
    "../program-output/ProgramOutputTransportFactory.js";
import PublicProgramController from "../public/PublicProgramController.js";
import PublicShellController from "../public/PublicShellController.js";
import { bootstrapPublicProgram, maintainPublicPage } from "../public/PublicProgramBootstrap.js";

let controller = null;
let stopBootstrap = null;
function startProgram() {
stopBootstrap = bootstrapPublicProgram({
    createTransport: configSignal => createProgramOutputTransport({ role: "subscriber", configSignal }),
    onWaiting: () => {
        const status = document.getElementById("public-program-status");
        if (status) status.textContent = "CONNECTING TO PROGRAM";
    },
    onConnected: transport => {
        controller = new PublicProgramController({
            root: document.getElementById("public-program"),
            status: document.getElementById("public-program-status"),
            audioButton: document.getElementById("public-audio-enable"),
            transport
        });
        try { controller.start(); }
        catch (error) { controller.destroy(); controller=null; throw error; }
    }
});
}

const shellController = new PublicShellController({
    page: document.getElementById("public-site"),
    composition: document.querySelector(".public-program__tv"),
    fullscreenButton: document.getElementById("public-fullscreen-toggle")
});

maintainPublicPage({
    start:()=>{shellController.start();startProgram();},
    stop:()=>{shellController.destroy();stopBootstrap?.();controller?.destroy();controller=null;}
});
