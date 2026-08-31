import assert from "node:assert/strict";
import test from "node:test";
import MediaIngestConfig from "../server/media-ingest/MediaIngestConfig.js";
import MediaIngestStatusClient from "../server/media-ingest/MediaIngestStatusClient.js";
import MediaIngestRoutes from "../server/media-ingest/MediaIngestRoutes.js";

const config = () => new MediaIngestConfig({ timeoutMs: 100 });
const jsonResponse = (payload, ok = true) => ({ ok, json: async () => payload,
    text: async () => typeof payload === "string" ? payload : JSON.stringify(payload) });
const activePath = { name: "livezone-test", online: true,
    onlineTime: "2026-08-31T12:00:00.000Z", source: { type: "rtmpSession" },
    tracks2: ["H264", "MPEG4Audio"] };

test("safe config projection excludes MediaMTX API and credentials", () => {
    const value = config();
    assert.deepEqual(value.toPublic(), {
        ingestId: "local-main", name: "Local Main",
        playbackHlsUrl: "http://127.0.0.1:8888/livezone-test/index.m3u8"
    });
    assert.equal(JSON.stringify(value.toPublic()).includes("9997"), false);
    assert.equal(JSON.stringify(value.toPublic()).match(/user|pass|token/i), null);
});

test("config rejects credential-bearing or mismatched HLS URLs and non-loopback API", () => {
    assert.throws(() => new MediaIngestConfig({ playbackHlsUrl:
        "http://user:pass@127.0.0.1:8888/livezone-test/index.m3u8" }));
    assert.throws(() => new MediaIngestConfig({ playbackHlsUrl:
        "http://127.0.0.1:8888/other/index.m3u8" }));
    assert.throws(() => new MediaIngestConfig({ apiOrigin: "http://example.test:9997" }));
});

test("unavailable API and malformed response fail closed to ERROR", async () => {
    const unavailable = new MediaIngestStatusClient({ config: config(),
        fetchImplementation: async () => { throw new Error("offline"); } });
    assert.equal((await unavailable.getStatus()).state, "error");
    const malformed = new MediaIngestStatusClient({ config: config(),
        fetchImplementation: async () => jsonResponse({ unexpected: [] }) });
    assert.equal((await malformed.getStatus()).state, "error");
});

test("empty or unrelated path list is OFFLINE", async () => {
    for (const items of [[], [{ ...activePath, name: "other" }]]) {
        const client = new MediaIngestStatusClient({ config: config(),
            fetchImplementation: async () => jsonResponse({ items }) });
        assert.equal((await client.getStatus()).state, "offline");
    }
});

test("active expected path with usable HLS is LIVE", async () => {
    const client = new MediaIngestStatusClient({ config: config(),
        fetchImplementation: async (url) => url.includes("/v3/paths/list")
            ? jsonResponse({ items: [activePath] }) : jsonResponse("#EXTM3U\n#EXT-X-VERSION:7") });
    const status = await client.getStatus();
    assert.equal(status.state, "live");
    assert.deepEqual(status.health, { publisherPresent: true, hlsAvailable: true });
    assert.equal(JSON.stringify(status).includes("rtmpSession"), false);
});

test("active publisher without usable HLS is CONNECTING", async () => {
    const client = new MediaIngestStatusClient({ config: config(),
        fetchImplementation: async (url) => url.includes("/v3/paths/list")
            ? jsonResponse({ items: [activePath] }) : jsonResponse("not-a-playlist") });
    const status = await client.getStatus();
    assert.equal(status.state, "connecting");
    assert.equal(status.health.hlsAvailable, false);
});

test("API timeout aborts and returns ERROR", async () => {
    const client = new MediaIngestStatusClient({ config: config(),
        fetchImplementation: (url, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }) });
    assert.equal((await client.getStatus()).state, "error");
});

test("route returns only the safe status schema", async () => {
    const safe = Object.freeze({ ingestId: "local-main", name: "Local Main", state: "offline",
        playbackHlsUrl: "http://127.0.0.1:8888/livezone-test/index.m3u8", lastSeenAt: null,
        health: Object.freeze({ publisherPresent: false, hlsAvailable: false }) });
    const route = new MediaIngestRoutes({ statusClient: { getStatus: async () => safe } });
    let code; let headers; let body;
    const response = { writeHead(value, valueHeaders) { code = value; headers = valueHeaders; },
        end(value) { body = value; } };
    assert.equal(await route.handle({ method: "GET" }, response,
        new URL("http://localhost/api/media-ingest/status")), true);
    assert.equal(code, 200);
    assert.equal(headers["Cache-Control"], "no-store");
    assert.deepEqual(JSON.parse(body), safe);
    assert.equal(body.match(/password|token|apiOrigin|raw/i), null);
});
