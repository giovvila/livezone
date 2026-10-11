import { opendir, stat } from "node:fs/promises";

export default class RuntimeReadiness {
    constructor({ mediaReady, mediaAssetRepository, mediaIngestStatusClient,
        storageObserver = observeStorageDirectory } = {}) {
        this.mediaReady = mediaReady;
        this.mediaAssetRepository = mediaAssetRepository;
        this.mediaIngestStatusClient = mediaIngestStatusClient;
        this.storageObserver = storageObserver;
    }

    async evaluate() {
        const mediaLibrary = await this.checkMediaLibrary();
        const mediaIngestControl = await this.checkMediaIngestControl();
        if (mediaLibrary !== "ok") {
            return readiness(false, "not-ready", { mediaLibrary,
                programOutput: "ok", mediaIngestControl });
        }
        const degraded = mediaIngestControl !== "ok";
        return readiness(true, degraded ? "degraded" : "ready", {
            mediaLibrary, programOutput: "ok", mediaIngestControl
        });
    }

    async checkMediaLibrary() {
        try {
            await this.mediaReady;
            await this.storageObserver(this.mediaAssetRepository.tempRoot);
            return "ok";
        }
        catch { return "unavailable"; }
    }

    async checkMediaIngestControl() {
        try {
            const status = await this.mediaIngestStatusClient.getStatus();
            return status?.state === "error" ? "degraded" : "ok";
        }
        catch { return "degraded"; }
    }
}

export async function observeStorageDirectory(directory) {
    if (!(await stat(directory)).isDirectory()) throw new Error("Storage directory unavailable");
    let handle;
    try {
        handle = await opendir(directory);
        await handle.read();
    }
    finally {
        await handle?.close();
    }
}

function readiness(ok, status, checks) {
    return Object.freeze({ ok, service: "livezone", status,
        checks: Object.freeze(checks), storage: Object.freeze({
            readability: checks.mediaLibrary === "ok" ? "DIRECTORY_READABLE" : "UNAVAILABLE",
            writeability: "NOT_PROBED", durability: "NOT_PROBED"
        }) });
}
