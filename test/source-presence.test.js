import test from "node:test";
import assert from "node:assert/strict";
import SourcePresenceMonitor from "../public/js/studio/SourcePresenceMonitor.js";
import MediaIngestConfig from "../server/media-ingest/MediaIngestConfig.js";
import MediaIngestStatusClient from "../server/media-ingest/MediaIngestStatusClient.js";

const source = { id: "live-a", url: "http://127.0.0.1:8888/livezone-test/index.m3u8" };
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const status = (state, present) => ({ state, health: { publisherPresent: present }, playbackHlsUrl: source.url });
function harness() {
    const requests = [], timers = new Map(); let next = 0;
    const monitor = new SourcePresenceMonitor({
        fetchImplementation: (url, options) => new Promise(resolve => requests.push({ url, options,
            resolve: value => resolve({ ok: true, json: async () => value }) })),
        setTimer: (fn, delay) => { timers.set(++next, { fn, delay }); return next; },
        clearTimer: id => timers.delete(id)
    });
    const poll = () => { const [id, timer] = [...timers].find(([, timer]) => timer.delay === 1000);
        timers.delete(id); timer.fn(); };
    return { monitor, requests, timers, poll };
}

test("source-only MediaMTX presence does not wait for HLS or buffered playback", async () => {
    const calls = [];
    const client = new MediaIngestStatusClient({ config: new MediaIngestConfig(),
        fetchImplementation: async url => { calls.push(url); return { ok: true, json: async () => ({
            items: [{ name: "livezone-test", online: true, source: { type: "rtmpConn" },
                tracks2: [{ codec: "H264" }] }] }) }; } });
    const result = await client.getStatus({ sourceOnly: true });
    assert.equal(result.health.publisherPresent, true);
    assert.equal(result.health.hlsAvailable, false);
    assert.equal(calls.length, 1);
});

test("MediaMTX offline overrides retained tracks and buffered HLS", async () => {
    const client = new MediaIngestStatusClient({ config: new MediaIngestConfig(),
        fetchImplementation: async () => ({ ok: true, json: async () => ({ items: [{
            name: "livezone-test", online: false, source: null, tracks2: [{ codec: "H264" }]
        }] }) }) });
    assert.equal((await client.getStatus({ sourceOnly: true })).state, "offline");
});

test("source monitor uses authenticated server route and independent fresh observations", async () => {
    const h = harness();
    try {
        h.monitor.selectSource(source);
        assert.equal(h.requests[0].url, "/api/media-ingest/status?sourceOnly=1");
        assert.equal(h.requests[0].options.credentials, "same-origin");
        h.requests[0].resolve(status("connecting", true)); await flush();
        const generation = h.monitor.getSnapshot().generation;
        assert.equal(h.monitor.getSnapshot().state, "ONLINE");
        h.poll(); h.requests[1].resolve(status("offline", false)); await flush();
        assert.equal(h.monitor.getSnapshot().state, "OFFLINE");
        assert.ok(h.monitor.getSnapshot().generation > generation);
    } finally { h.monitor.destroy(); }
});

test("source API error is uncertainty, never confirmed absence", async () => {
    const h = harness();
    try { h.monitor.selectSource(source); h.requests[0].resolve(status("error", false)); await flush();
        assert.equal(h.monitor.getSnapshot().state, "ERROR");
        assert.equal(h.monitor.getSnapshot().reason, "PRESENCE_UNAVAILABLE");
    } finally { h.monitor.destroy(); }
});

test("different source URL cannot acquire through local publisher presence", async () => {
    const h = harness();
    try { h.monitor.selectSource({ ...source, url: "https://other.test/live.m3u8" });
        h.requests[0].resolve(status("live", true)); await flush();
        assert.equal(h.monitor.getSnapshot().state, "ERROR");
    } finally { h.monitor.destroy(); }
});

test("old source promise and destroyed monitor cannot publish ONLINE", async () => {
    const h = harness(); const observed = [];
    h.monitor.subscribe(value => observed.push(value));
    h.monitor.selectSource(source); h.monitor.selectSource(source);
    h.requests[1].resolve(status("offline", false)); await flush();
    h.requests[0].resolve(status("live", true)); await flush();
    assert.deepEqual(observed.map(value => value.state), ["IDLE", "OFFLINE"]);
    h.poll(); h.monitor.destroy(); h.requests[2].resolve(status("live", true)); await flush();
    assert.equal(observed.length, 2);
    assert.equal(h.timers.size, 0);
});

test("partial MediaMTX path list is uncertainty instead of false absence", async () => {
    const client = new MediaIngestStatusClient({ config: new MediaIngestConfig(),
        fetchImplementation: async () => ({ ok: true, json: async () => ({ pageCount: 2, items: [] }) }) });
    assert.equal((await client.getStatus({ sourceOnly: true })).state, "error");
});
