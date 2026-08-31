export default class MediaIngestStatusClient {
    constructor({ config, fetchImplementation = globalThis.fetch } = {}) {
        if (!config || typeof fetchImplementation !== "function") {
            throw new TypeError("MediaIngestStatusClient requires config and fetch.");
        }
        this.config = config;
        this.fetchImplementation = fetchImplementation;
    }

    async getStatus() {
        const safe = this.config.toPublic();
        try {
            const payload = await this.fetchJson(
                new URL("/v3/paths/list", this.config.apiOrigin).href
            );
            if (!payload || !Array.isArray(payload.items)) return this.errorStatus(safe);
            const path = payload.items.find((item) => item?.name === this.config.mediaPath);
            if (!path || path.online === false) return this.status(safe, "offline", false, false, null);
            if (path.online !== true || !path.source || !Array.isArray(path.tracks2)) {
                return this.errorStatus(safe);
            }
            const publisherPresent = path.tracks2.length > 0;
            if (!publisherPresent) return this.status(safe, "connecting", false, false,
                validTimestamp(path.onlineTime));
            const hlsAvailable = await this.probeHls();
            return this.status(safe, hlsAvailable ? "live" : "connecting", true,
                hlsAvailable, validTimestamp(path.onlineTime));
        } catch {
            return this.errorStatus(safe);
        }
    }

    async fetchJson(url) {
        const response = await this.fetchWithTimeout(url, {
            headers: { "Accept": "application/json" }, cache: "no-store"
        });
        if (!response?.ok) throw new Error("Media ingest API unavailable.");
        return response.json();
    }

    async probeHls() {
        try {
            const response = await this.fetchWithTimeout(this.config.playbackHlsUrl, {
                headers: { "Accept": "application/vnd.apple.mpegurl" }, cache: "no-store"
            });
            if (!response?.ok) return false;
            return (await response.text()).trimStart().startsWith("#EXTM3U");
        } catch { return false; }
    }

    async fetchWithTimeout(url, options) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            return await this.fetchImplementation(url, { ...options, signal: controller.signal });
        } finally { clearTimeout(timer); }
    }

    errorStatus(safe) { return this.status(safe, "error", false, false, null); }
    status(safe, state, publisherPresent, hlsAvailable, lastSeenAt) {
        return Object.freeze({ ...safe, state, lastSeenAt,
            health: Object.freeze({ publisherPresent, hlsAvailable }) });
    }
}

function validTimestamp(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
