import test from "node:test";
import assert from "node:assert/strict";
import SourcePresenceMonitor from "../public/js/studio/SourcePresenceMonitor.js";
import TechnicalLiveMonitorUI from "../public/js/ui/TechnicalLiveMonitorUI.js";
import { createLiveHlsConsumerFactory } from "../public/js/studio/LiveHlsHealthConsumer.js";
import LiveSourceMonitor from "../public/js/studio/LiveSourceMonitor.js";
import DominantLiveController from "../public/js/studio/DominantLiveController.js";
import StudioProgramCommand from "../public/js/scheduler/StudioProgramCommand.js";
import StudioTransitionCoordinator from "../public/js/studio/StudioTransitionCoordinator.js";




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
const present = { ingestId: "local-main", state: "connecting", health: { publisherPresent: true, hlsAvailable: false }, playbackHlsUrl: source.url };
const absent = { ...present, state: "offline", health: { publisherPresent: false, hlsAvailable: false } };

function monitorHarness(fetchImplementation, extra = {}) {
    const time = clock(); const monitor = new SourcePresenceMonitor({ fetchImplementation,
        setTimer: time.set, clearTimer: time.clear, clock: time.now, ...extra });
    return { time, monitor };
}

function acquisitionHarness({ readyAfter = 0, readinessFails = false, selected = source, external = "ONLINE" } = {}) {
    let payload = absent; const consumers = [];
    const h = monitorHarness(async () => response(payload), { externalConsumerFactory: (source, handlers) => {
        const consumer = { source, handlers, destroyed: false, async start() {
            if (external === "ONLINE") handlers.online(); else if (external === "OFFLINE") handlers.offline();
        }, destroy() { this.destroyed = true; } }; consumers.push(consumer); return consumer;
    } });
    const state = { preview: null, program: null, commits: 0,
        getPreviewSceneId() { return this.preview; }, getProgramSceneId() { return this.program; },
        getScene(id) { return id === "live-scene" ? { id } : null; },
        setPreviewScene(id) { this.preview = id; return {}; },
        take() { this.program = this.preview; this.preview = null; this.commits++; return { timestamp: "test" }; } };
    const catalog = { getSources: () => [selected, source], getDefinition: id => id === "live-scene"
        ? { id, renderer: { kind: "source", sourceId: selected.id } } : null,
        subscribe(fn) { fn([selected, source]); return () => {}; } };
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
    const configListeners = new Set();
    const config = { getSnapshot: () => ({ armed: true, authorizedSourceId: selected.id }),
        subscribe(fn) { configListeners.add(fn); fn(this.getSnapshot()); return () => configListeners.delete(fn); } };
    const scheduler = { getSnapshot: () => ({ enabled: true }),
        subscribe(fn) { fn(this.getSnapshot()); return () => {}; },
        ends: 0, beginInterruption: () => ({ kind: "empty-slot" }), endInterruption() { this.ends++; return true; } };
    const controller = new DominantLiveController({ config, catalog, monitor: h.monitor,
        scheduler, command, setTimer: h.time.set, clearTimer: h.time.clear, clock: h.time.now,
        eventBus: { on() {}, off() {} } });
    controller.start();
    return { ...h, state, renderer, controller, coordinator, consumers, scheduler,
        select(value) { selected = value; configListeners.forEach(fn => fn(config.getSnapshot())); },
        setPayload(value) { payload = value; }, destroy() { controller.destroy(); coordinator.destroy(); } };
}


const testlive = { ...source, id: "testlive", url: "https://xibilive.flash.example/live/index.m3u8" };
test("real case: authorized external testlive acquires while local-main is OFFLINE", async () => {
    const h = acquisitionHarness({ selected: testlive });
    try {
        await flush(); assert.equal(h.monitor.getSnapshot().state, "ONLINE");
        assert.equal(h.monitor.getSnapshot().sourceId, "testlive");
        await h.time.advance(3000); assert.equal(h.state.commits, 1);
        assert.equal(h.controller.getSnapshot().status, "ON AIR");
    } finally { h.destroy(); }
});

test("reverse case: unrelated external ONLINE cannot authorize absent managed publisher", async () => {
    const technical = new LiveSourceMonitor({ consumerFactory: (_source, handlers) => ({
        async start() { handlers.online(); }, destroy() {} }) });
    technical.selectSource(testlive); await flush();
    const h = acquisitionHarness();
    try {
        await h.time.advance(6000);
        assert.equal(technical.getSnapshot().state, "ONLINE");
        assert.equal(h.monitor.getSnapshot().state, "OFFLINE");
        assert.equal(h.monitor.getSnapshot().authority, "managed-ingest");
        assert.equal(h.consumers.length, 0); assert.equal(h.state.commits, 0);
    } finally { h.destroy(); technical.destroy(); }
});

test("multiple external sources and stale ONLINE follow exact authorization", async () => {
    const primecast = { ...testlive, id: "primecast", url: "https://primecast.example/live.m3u8" };
    const h = acquisitionHarness({ selected: testlive, external: "pending" });
    try {
        await flush(); const old = h.consumers[0]; old.handlers.online();
        await h.time.advance(2000); h.select(primecast); await flush();
        assert.equal(old.destroyed, true);
        const current = h.consumers.at(-1); assert.equal(current.source.id, "primecast");
        current.handlers.offline(); old.handlers.online();
        assert.equal(h.monitor.getSnapshot().sourceId, "primecast");
        assert.equal(h.monitor.getSnapshot().state, "OFFLINE");
        await h.time.advance(3000); assert.equal(h.state.commits, 0);
        h.select(testlive); await flush(); h.consumers.at(-1).handlers.online();
        current.handlers.online(); await h.time.advance(3000);
        assert.equal(h.state.commits, 1); assert.equal(h.controller.getSnapshot().session.sourceId, "testlive");
    } finally { h.destroy(); }
});

for (const selected of [source, testlive]) {
    test(`source-specific loss preserves 5000ms grace: ${selected.id}`, async () => {
        const h = acquisitionHarness({ selected, external: "pending" });
        try {
            h.setPayload(present); await flush();
            if (selected === testlive) h.consumers[0].handlers.online();
            await h.time.advance(4000); assert.equal(h.controller.getSnapshot().status, "ON AIR");
            if (selected === testlive) h.consumers[0].handlers.offline();
            else { h.setPayload(absent); await h.time.advance(1000); }
            await h.time.advance(4999); assert.ok(h.controller.getSnapshot().session);
            await h.time.advance(1); assert.equal(h.controller.getSnapshot().session, null);
            assert.equal(h.scheduler.ends, 1);
        } finally { h.destroy(); }
    });
}

for (const [name, selected, mapping, expected] of [
    ["configRef external", { ...testlive, configRef: "stream.primary" }, absent, "external-hls"],
    ["configRef managed", { ...source, configRef: "stream.primary" }, absent, "managed-ingest"],
    ["loopback unrelated path", { ...source, url: "http://127.0.0.1:8888/other/index.m3u8" }, absent, "external-hls"],
    ["remote managed endpoint", testlive, { ...absent, playbackHlsUrl: testlive.url }, "managed-ingest"]
]) test(`authority uses exact server mapping, not provenance or hostname: ${name}`, async () => {
    const h = monitorHarness(async () => response(mapping), {
        externalConsumerFactory: (_source, handlers) => ({ async start() { handlers.online(); }, destroy() {} }) });
    try { h.monitor.selectSource(selected); await flush(); assert.equal(h.monitor.getSnapshot().authority, expected); }
    finally { h.monitor.destroy(); }
});

test("managed API error or changed ingest identity never falls back to HLS", async () => {
    let payload = absent; let consumers = 0;
    const h = monitorHarness(async () => response(payload), { externalConsumerFactory: () => { consumers++; } });
    try {
        h.monitor.selectSource(source); await flush();
        payload = { ...absent, state: "error" }; await h.time.advance(1000);
        assert.equal(h.monitor.getSnapshot().reason, "PRESENCE_UNAVAILABLE");
        payload = { ...present, ingestId: "different-ingest" }; await h.time.advance(1000);
        assert.equal(h.monitor.getSnapshot().state, "ERROR");
        assert.equal(consumers, 0);
    } finally { h.monitor.destroy(); }
});

test("external handoff stops local polls and destroys old consumer on managed switch", async () => {
    let calls = 0, destroyed = 0;
    const h = monitorHarness(async (url) => { calls++; assert.equal(url, "/api/media-ingest/status?sourceOnly=1"); return response(absent); }, {
        externalConsumerFactory: (_source, handlers) => ({ async start() { handlers.online(); }, destroy() { destroyed++; } }) });
    try {
        h.monitor.selectSource(testlive); await h.time.advance(6000); assert.equal(calls, 1);
        h.monitor.selectSource(source); await flush(); assert.equal(destroyed, 1);
        assert.equal(h.monitor.getSnapshot().state, "OFFLINE");
    } finally { h.monitor.destroy(); assert.equal(h.time.timers.size, 0); }
});

test("late mapping response cannot start previous authorized HLS consumer", async () => {
    let resolve; let calls = 0; let consumers = 0;
    const h = monitorHarness(() => ++calls === 1 ? new Promise(done => { resolve = done; }) : Promise.resolve(response(absent)), {
        externalConsumerFactory: () => { consumers++; } });
    try {
        h.monitor.selectSource(testlive); h.monitor.selectSource(source); await flush();
        resolve(response(absent)); await flush(); assert.equal(consumers, 0);
        assert.equal(h.monitor.getSnapshot().sourceId, source.id);
    } finally { h.monitor.destroy(); }
});

test("unavailable mapping is bounded and cannot guess external authority", async () => {
    let consumers = 0;
    const h = monitorHarness(() => new Promise(() => {}), { externalConsumerFactory: () => { consumers++; } });
    try {
        h.monitor.selectSource(testlive); await h.time.advance(2000);
        assert.equal(h.monitor.getSnapshot().reason, "CHECKING_TIMEOUT");
        assert.equal(consumers, 0);
    } finally { h.monitor.destroy(); }
});

for (const mode of ["technical", "autolive"]) test(
    mode + " shares decoded readiness, advancing playback and loss detection", async () => {
    const previousDocument = globalThis.document;
    const video = new EventTarget();
    Object.assign(video, { readyState: 2, currentTime: 10, videoWidth: 1920,
        videoHeight: 1080, paused: false, ended: false, canPlayType: () => "probably",
        play: async () => {}, pause() {}, setAttribute() {}, removeAttribute() {}, load() {}, remove() {} });
    globalThis.document = { createElement: tag => tag === "video" ? video : { remove() {} } };
    const root = { replaceChildren() {}, appendChild() {} }; const states = [];
    const factory = mode === "technical" ? TechnicalLiveMonitorUI.createConsumerFactory(root)
        : createLiveHlsConsumerFactory(root);
    const consumer = factory(testlive, { online: () => states.push("ONLINE"),
        offline: () => states.push("OFFLINE"), error: () => states.push("ERROR") });
    try {
        await consumer.start(); video.dispatchEvent(new Event("loadeddata")); await flush();
        assert.deepEqual(states, []);
        video.currentTime++; video.dispatchEvent(new Event("timeupdate"));
        assert.deepEqual(states, ["ONLINE"]); assert.equal(video.muted, true);
        video.dispatchEvent(new Event("waiting"));
        assert.deepEqual(states, ["ONLINE", "OFFLINE"]);
        video.dispatchEvent(new Event("canplay")); video.dispatchEvent(new Event("timeupdate"));
        assert.equal(states.length, 2);
        video.currentTime++; video.dispatchEvent(new Event("timeupdate"));
        assert.deepEqual(states, ["ONLINE", "OFFLINE", "ONLINE"]);
    } finally { consumer.destroy(); globalThis.document = previousDocument; }
});
