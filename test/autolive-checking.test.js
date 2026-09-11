import test from "node:test";
import assert from "node:assert/strict";
import SourcePresenceMonitor from "../public/js/studio/SourcePresenceMonitor.js";
import LiveSourceMonitor from "../public/js/studio/LiveSourceMonitor.js";
import DominantLiveController from "../public/js/studio/DominantLiveController.js";
import StudioProgramCommand from "../public/js/scheduler/StudioProgramCommand.js";
import StudioTransitionCoordinator from "../public/js/studio/StudioTransitionCoordinator.js";
import MediaIngestStatusClient from "../server/media-ingest/MediaIngestStatusClient.js";
import MediaIngestConfig from "../server/media-ingest/MediaIngestConfig.js";
import trace from "../public/js/core/RuntimeTrace.js";

const source = { id: "live-selected", kind: "hls", enabled: true, name: "Selected LIVE",
    url: "http://127.0.0.1:8888/livezone-test/index.m3u8", sceneIds: ["live-scene"] };
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
function clock() {
    let now = 0, serial = 0; const timers = new Map();
    return { now: () => now, timers,
        set(fn, delay) { timers.set(++serial, { fn, at: now + delay }); return serial; },
        clear(id) { timers.delete(id); },
        async advance(ms) {
            const until = now + ms; await flush();
            for (;;) {
                const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
            }
            now = until; await flush();
        } };
}
const response = payload => ({ ok: true, status: 200, json: async () => payload });
const present = { state: "connecting", health: { publisherPresent: true, hlsAvailable: false }, playbackHlsUrl: source.url };
const absent = { ...present, state: "offline", health: { publisherPresent: false, hlsAvailable: false } };

function monitorHarness(fetchImplementation) {
    const time = clock(); const monitor = new SourcePresenceMonitor({ fetchImplementation,
        setTimer: time.set, clearTimer: time.clear, clock: time.now });
    return { time, monitor };
}

for (const [name, fetchImplementation, reason] of [
    ["HTTP 401", async () => ({ ok: false, status: 401 }), "HTTP_ERROR"],
    ["server uncertainty", async () => response({ ...present, state: "error",
        health: { publisherPresent: false, hlsAvailable: false } }), "PRESENCE_UNAVAILABLE"],
    ["publisher not ready", async () => response({ ...present,
        health: { publisherPresent: false, hlsAvailable: false } }), "PUBLISHER_NOT_READY"],
    ["network rejection", async () => { throw new Error("do-not-log-credentials"); }, "NETWORK_ERROR"]
]) {
    test(`CHECKING has a diagnosed retry outcome for ${name}`, async () => {
        const h = monitorHarness(fetchImplementation); h.monitor.selectSource(source); await flush();
        assert.equal(h.monitor.getSnapshot().state, "ERROR");
        assert.equal(h.monitor.getSnapshot().reason, reason);
        assert.equal(h.monitor.getSnapshot().retryActive, true);
        await h.time.advance(10000);
        assert.equal(h.monitor.getSnapshot().state, "ERROR");
        assert.ok(h.monitor.getSnapshot().retryAttempt >= 10);
        h.monitor.destroy(); assert.equal(h.time.timers.size, 0);
    });
}

for (const stalled of ["fetch", "body"]) {
    test(`non-settling ${stalled} cannot outlive the 2000ms checking deadline`, async () => {
        let calls = 0;
        const h = monitorHarness(() => { calls++;
            return stalled === "fetch" ? new Promise(() => {})
                : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) }); });
        h.monitor.selectSource(source); await h.time.advance(2000);
        assert.equal(h.monitor.getSnapshot().state, "ERROR");
        assert.equal(h.monitor.getSnapshot().reason, "CHECKING_TIMEOUT");
        assert.equal(h.monitor.getSnapshot().retryDeadline, 3000);
        await h.time.advance(3000); assert.equal(calls, 2);
        assert.equal(h.monitor.getSnapshot().state, "ERROR"); h.monitor.destroy();
    });
}

test("Technical player ONLINE does not imply an authorized presence API response", async () => {
    const technical = new LiveSourceMonitor({ consumerFactory: (_source, handlers) => ({
        start() { handlers.online(); }, destroy() {} }), setTimer: () => 1, clearTimer() {} });
    technical.selectSource(source); assert.equal(technical.getSnapshot().state, "ONLINE");
    const h = monitorHarness(async () => ({ ok: false, status: 401 }));
    h.monitor.selectSource(source); await flush();
    assert.equal(h.monitor.getSnapshot().state, "ERROR");
    assert.equal(h.monitor.getSnapshot().httpStatus, 401);
    technical.destroy(); h.monitor.destroy();
});

test("confirmed publisher presence does not wait for HLS and exact endpoint must match", async () => {
    const client = new MediaIngestStatusClient({ config: new MediaIngestConfig(),
        fetchImplementation: async () => response({ items: [{ name: "livezone-test", online: true,
            source: { type: "rtmpConn" }, tracks2: [{ codec: "H264" }] }] }) });
    const payload = await client.getStatus({ sourceOnly: true });
    assert.equal(payload.state, "connecting"); assert.equal(payload.health.hlsAvailable, false);
    const h = monitorHarness(async () => response(payload)); h.monitor.selectSource(source); await flush();
    assert.equal(h.monitor.getSnapshot().state, "ONLINE");
    h.monitor.selectSource({ ...source, url: source.url.replace("livezone-test", "other-path") }); await flush();
    assert.equal(h.monitor.getSnapshot().state, "ERROR");
    assert.equal(h.monitor.getSnapshot().reason, "ENDPOINT_MISMATCH"); h.monitor.destroy();
});

function acquisitionHarness({ readyAfter = 0, readinessFails = false } = {}) {
    let payload = present; const h = monitorHarness(async () => response(payload));
    const state = { preview: null, program: null, commits: 0,
        getPreviewSceneId() { return this.preview; }, getProgramSceneId() { return this.program; },
        getScene(id) { return id === "live-scene" ? { id } : null; },
        setPreviewScene(id) { this.preview = id; return {}; },
        take() { this.program = this.preview; this.preview = null; this.commits++; return { timestamp: "test" }; } };
    const catalog = { getSources: () => [source], getDefinition: id => id === "live-scene"
        ? { id, renderer: { kind: "source", sourceId: source.id } } : null,
        subscribe(fn) { fn([source]); return () => {}; } };
    const renderer = { prepared: 0,
        async prepareProgramScene() { this.prepared++;
            if (readyAfter) await new Promise(resolve => h.time.set(resolve, readyAfter));
            if (readinessFails) { const error = new Error("readiness-timeout"); error.code = "readiness-timeout"; throw error; }
            return { sceneId: "live-scene" }; },
        discardPreparedProgram() {}, cancelProgramTransition() {}, discardPreviewHandoff() {},
        captureProgramPreviewHandoff() {}, async waitForProgramTransition() { return true; } };
    const coordinator = new StudioTransitionCoordinator({ studioStateManager: state, studioRenderer: renderer });
    coordinator.start();
    const command = new StudioProgramCommand({ stateManager: state, catalog, transitionCoordinator: coordinator });
    const config = { getSnapshot: () => ({ armed: true, authorizedSourceId: source.id }),
        subscribe(fn) { fn(this.getSnapshot()); return () => {}; } };
    const scheduler = { getSnapshot: () => ({ enabled: true }),
        subscribe(fn) { fn(this.getSnapshot()); return () => {}; },
        beginInterruption: () => ({ kind: "empty-slot" }), endInterruption: () => true };
    const controller = new DominantLiveController({ config, catalog, monitor: h.monitor,
        scheduler, command, setTimer: h.time.set, clearTimer: h.time.clear, clock: h.time.now,
        eventBus: { on() {}, off() {} } });
    controller.start();
    return { ...h, state, renderer, controller, coordinator,
        setPayload(value) { payload = value; }, destroy() { controller.destroy(); coordinator.destroy(); } };
}

for (const [name, delay] of [["immediate readiness", 0], ["delayed player readiness", 1500],
    ["muted play promise pending", 500], ["HLS manifest delayed", 4000]]) {
    test(`presence ONLINE advances to stabilization/acquire independently of ${name}`, async () => {
        // The renderer delay models the downstream gate; there is no hidden
        // health player in the production AutoLive presence path.
        const h = acquisitionHarness({ readyAfter: delay }); await flush();
        assert.equal(h.monitor.getSnapshot().state, "ONLINE");
        assert.equal(h.controller.getSnapshot().status, "ARMED — ONLINE/STABILIZING");
        await h.time.advance(3000);
        assert.equal(h.renderer.prepared, 1);
        if (delay) { assert.equal(h.controller.getSnapshot().status, "ACTIVATING");
            assert.equal(h.state.commits, 0); await h.time.advance(delay); }
        assert.equal(h.controller.getSnapshot().status, "ON AIR"); assert.equal(h.state.commits, 1);
        h.destroy();
    });
}

test("absent/flapping presence cannot complete the unchanged stabilization period", async () => {
    const h = acquisitionHarness(); h.setPayload(absent); await flush(); await h.time.advance(1000);
    assert.equal(h.monitor.getSnapshot().state, "OFFLINE"); await h.time.advance(3000);
    assert.equal(h.state.commits, 0);
    h.setPayload(present); await h.time.advance(1000); h.setPayload(absent); await h.time.advance(1000);
    assert.equal(h.state.commits, 0);
    h.setPayload(present); await h.time.advance(4000);
    assert.equal(h.state.commits, 1); h.destroy();
});

test("downstream readiness timeout is an acquisition error, not infinite CHECKING", async () => {
    const h = acquisitionHarness({ readyAfter: 12000, readinessFails: true });
    await h.time.advance(15000);
    assert.equal(h.monitor.getSnapshot().state, "ONLINE");
    assert.equal(h.controller.getSnapshot().status, "ERROR"); assert.equal(h.state.commits, 0); h.destroy();
});

test("API uncertainty cannot revoke an acquired session after the existing loss grace", async () => {
    const h = acquisitionHarness(); await h.time.advance(3000);
    const session = h.controller.getSnapshot().session; assert.ok(session);
    h.setPayload({ ...present, state: "error", health: { publisherPresent: false, hlsAvailable: false } });
    await h.time.advance(7000);
    assert.equal(h.monitor.getSnapshot().state, "ERROR");
    assert.equal(h.controller.getSnapshot().session, session);
    assert.equal(h.controller.getSnapshot().diagnostics.lossGraceExpired, true);
    h.setPayload(present); await h.time.advance(1000);
    assert.equal(h.controller.getSnapshot().session, session);
    assert.equal(h.controller.getSnapshot().diagnostics.lossGraceExpired, false); h.destroy();
});

test("a retry with confirmed presence advances beyond the prior checking failure", async () => {
    const h = acquisitionHarness(); h.setPayload({ ...present, state: "error" });
    await h.time.advance(1000);
    assert.equal(h.controller.getSnapshot().status, "ARMED — RETRY");
    assert.equal(h.controller.getSnapshot().diagnostics.sourcePresenceReason, "PRESENCE_UNAVAILABLE");
    h.setPayload(present); await h.time.advance(4000);
    assert.equal(h.controller.getSnapshot().status, "ON AIR"); assert.equal(h.state.commits, 1); h.destroy();
});

test("presence trace explains identity, result and retry without credential-bearing endpoints", async () => {
    const enabled = trace.enabled; trace.enabled = true; trace.clear();
    const h = monitorHarness(async () => response(present));
    try {
        h.monitor.selectSource(source); await flush();
        const event = trace.snapshot().find(entry => entry.event === "observation");
        assert.equal(event.sourceId, source.id); assert.equal(event.selectedPath, "livezone-test");
        assert.equal(event.probedPath, "livezone-test"); assert.equal(event.publisherPresent, true);
        assert.equal(event.endpointMatch, true); assert.equal(event.reason, "PUBLISHER_PRESENT");
        assert.equal(event.retryDeadline, 1000);
        h.monitor.selectSource({ ...source, url: "http://user:secret@127.0.0.1:8888/livezone-test/index.m3u8?token=secret" });
        await flush(); assert.equal(h.monitor.getSnapshot().selectedPath, null);
        assert.ok(!trace.exportJSON().includes("secret")); assert.ok(!trace.exportJSON().includes("http://"));
    } finally { h.monitor.destroy(); trace.clear(); trace.enabled = enabled; }
});
