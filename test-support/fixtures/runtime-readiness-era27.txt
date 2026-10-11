import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export default class RuntimeReadiness {
    constructor({ mediaReady, mediaAssetRepository, mediaIngestStatusClient,
        writableProbe = probeWritableDirectory } = {}) {
        this.mediaReady = mediaReady;
        this.mediaAssetRepository = mediaAssetRepository;
        this.mediaIngestStatusClient = mediaIngestStatusClient;
        this.writableProbe = writableProbe;
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
            await this.writableProbe(this.mediaAssetRepository.tempRoot);
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

async function probeWritableDirectory(directory) {
    const path = join(directory, `.ready-${randomUUID()}.tmp`);
    let handle;
    try {
        handle = await open(path, "wx");
    }
    finally {
        await handle?.close().catch(() => {});
        await unlink(path).catch(() => {});
    }
}

function readiness(ok, status, checks) {
    return Object.freeze({ ok, service: "livezone", status,
        checks: Object.freeze(checks) });
}
