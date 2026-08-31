const DEFAULTS = Object.freeze({
    ingestId: "local-main",
    name: "Local Main",
    mediaPath: "livezone-test",
    apiOrigin: "http://127.0.0.1:9997",
    playbackHlsUrl: "http://127.0.0.1:8888/livezone-test/index.m3u8",
    timeoutMs: 1500,
});

export default class MediaIngestConfig {
    constructor(value = {}) {
        const candidate = { ...DEFAULTS, ...value };
        this.ingestId = requiredText(candidate.ingestId, "ingestId");
        this.name = requiredText(candidate.name, "name");
        this.mediaPath = validatePath(candidate.mediaPath);
        this.apiOrigin = validateApiOrigin(candidate.apiOrigin);
        this.playbackHlsUrl = validatePlaybackUrl(candidate.playbackHlsUrl, this.mediaPath);
        this.timeoutMs = validateTimeout(candidate.timeoutMs);
        Object.freeze(this);
    }

    static fromEnvironment(environment = process.env) {
        return new MediaIngestConfig({
            ingestId: environment.LIVEZONE_MEDIA_INGEST_ID || DEFAULTS.ingestId,
            name: environment.LIVEZONE_MEDIA_INGEST_NAME || DEFAULTS.name,
            mediaPath: environment.LIVEZONE_MEDIA_INGEST_PATH || DEFAULTS.mediaPath,
            apiOrigin: environment.LIVEZONE_MEDIA_INGEST_API_ORIGIN || DEFAULTS.apiOrigin,
            playbackHlsUrl: environment.LIVEZONE_MEDIA_INGEST_HLS_URL || DEFAULTS.playbackHlsUrl,
        });
    }

    toPublic() {
        return Object.freeze({
            ingestId: this.ingestId,
            name: this.name,
            playbackHlsUrl: this.playbackHlsUrl,
        });
    }
}

function requiredText(value, name) {
    if (typeof value !== "string" || !value.trim() || value.length > 120) {
        throw new TypeError(`Invalid media ingest ${name}.`);
    }
    return value.trim();
}

function validatePath(value) {
    const path = requiredText(value, "mediaPath");
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(path)) {
        throw new TypeError("Invalid media ingest path.");
    }
    return path;
}

function validateApiOrigin(value) {
    const url = parseHttpUrl(value, "API origin");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) {
        throw new TypeError("Media ingest API must use a credential-free loopback origin.");
    }
    return url.origin;
}

function validatePlaybackUrl(value, mediaPath) {
    const url = parseHttpUrl(value, "HLS URL");
    if (url.username || url.password || url.search || url.hash ||
        url.pathname !== `/${mediaPath}/index.m3u8`) {
        throw new TypeError("Invalid media ingest HLS URL.");
    }
    return url.href;
}

function parseHttpUrl(value, name) {
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
        return url;
    } catch { throw new TypeError(`Invalid media ingest ${name}.`); }
}

function validateTimeout(value) {
    const timeout = Number(value);
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 5000) {
        throw new TypeError("Invalid media ingest timeout.");
    }
    return timeout;
}
