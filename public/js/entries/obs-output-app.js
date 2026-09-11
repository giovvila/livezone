import { createProgramOutputTransport } from
    "../program-output/ProgramOutputTransportFactory.js";
import PublicProgramController from "../public/PublicProgramController.js";

const BOOT_RETRY_MS = 3000;
let controller = null;
let retryTimer = null;
let stopped = false;

async function boot() {
    if (stopped || controller) return;
    try {
        const transport = await createProgramOutputTransport({ role: "subscriber" });
        if (stopped) {
            transport.destroy();
            return;
        }
        controller = new PublicProgramController({
            root: document.getElementById("obs-program"),
            status: null,
            audioButton: null,
            transport,
            outputMode: "obs"
        });
        controller.start();
    }
    catch {
        if (!stopped) retryTimer = setTimeout(boot, BOOT_RETRY_MS);
    }
}

void boot();

globalThis.addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(retryTimer);
    controller?.destroy();
    controller = null;
}, { once: true });
