import ProgramOutputStore from "../server/program-output/ProgramOutputStore.js";
import { createProgramOutputEnvelope } from "../public/js/program-output/ProgramOutputEnvelope.js";
import AutoLiveLossPresentation from "../public/js/studio/AutoLiveLossPresentation.js";
import test from "node:test";
import assert from "node:assert/strict";
import ProgramOutputManager from "../public/js/program-output/ProgramOutputManager.js";
import trace from "../public/js/core/RuntimeTrace.js";
import SourcePresenceMonitor from "../public/js/studio/SourcePresenceMonitor.js";
import TechnicalLiveMonitorUI from "../public/js/ui/TechnicalLiveMonitorUI.js";
import { createLiveHlsConsumerFactory } from "../public/js/studio/LiveHlsHealthConsumer.js";
import LiveSourceMonitor from "../public/js/studio/LiveSourceMonitor.js";
import DominantLiveController from "../public/js/studio/DominantLiveController.js";
import StudioProgramCommand from "../public/js/scheduler/StudioProgramCommand.js";
import StudioTransitionCoordinator from "../public/js/studio/StudioTransitionCoordinator.js";




const recorded = { id: "recorded", kind: "media", url: "https://example.test/a.mp4" };
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
    let payload = absent; const consumers = []; let factory;
    const h = monitorHarness(async () => response(payload), { externalConsumerFactory: (source, handlers) => {
        factory ??= createLiveHlsConsumerFactory({ replaceChildren() {}, appendChild() {} }, undefined,
            { setTimer: h.time.set, clearTimer: h.time.clear });
        const consumer = factory(source, handlers); consumers.push({ consumer, handlers }); return consumer;
    } });
    const state = { preview: null, program: "A", commits: 0,
        getPreviewSceneId() { return this.preview; }, getProgramSceneId() { return this.program; },
        getScene(id) { return ["live-scene", "A", "B"].includes(id) ? { id, name: id, type: id === "live-scene" ? "LIVE" : "MEDIA" } : null; },
        setPreviewScene(id) { this.preview = id; return {}; },
        take() { this.program = this.preview; this.preview = null; this.commits++; return { timestamp: "test" }; } };
    const catalog = { getSources: () => [selected, source, recorded], getDefinition: id => id === "live-scene"
        ? { id, renderer: { kind: "source", sourceId: selected.id } } : ["A", "B"].includes(id) ? { id, renderer: { kind: "source", sourceId: "recorded" } } : null,
        subscribe(fn) { fn([selected, source]); return () => {}; } };
    const renderer = { prepared: 0,
        getProgramTransport: () => ["A", "B"].includes(state.program) ? { sourceId: "recorded", currentTime: 37, duration: 120, state: "playing", ended: false } : null,
        subscribeProgramTransport(fn) { fn(this.getProgramTransport()); return () => {}; },
        async prepareProgramScene(sceneId, options) { this.prepared++; this.lastOptions = options;
            if (readyAfter) await new Promise(resolve => h.time.set(resolve, readyAfter));
            if (readinessFails) { const error = new Error("readiness-timeout"); error.code = "readiness-timeout"; throw error; }
            return { sceneId }; },
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
        programTransportProvider: () => renderer.getProgramTransport(),
        ends: 0, beginInterruption: () => ({ kind: "empty-slot" }), endInterruption() { this.ends++; return true; } };
    const controller = new DominantLiveController({ config, catalog, monitor: h.monitor,
        scheduler, command, setTimer: h.time.set, clearTimer: h.time.clear, clock: h.time.now,
        eventBus: { on() {}, off() {} } });
    const history = [];
    const output = new ProgramOutputManager({ stateManager: state, catalog,
        sourceManager: { getSource: id => id === "recorded" ? recorded : id === selected.id ? selected : source },
        renderer, graphicsManager: { subscribe: () => () => {}, getVisibleGraphics: () => [] },
        transitionCoordinator: { getSnapshot: () => ({ state: "idle" }) },
        transport: { start() {}, destroy() {}, publish(snapshot) { history.push(snapshot); } }, now: h.time.now });
    output.start();
    const execute = command.execute.bind(command);
    command.execute = async request => { const result = await execute(request); if (result.ok) output.handleProgramChanged(); return result; };
    controller.start();
    return { ...h, state, renderer, controller, coordinator, consumers, scheduler, history, output,
        select(value) { selected = value; configListeners.forEach(fn => fn(config.getSnapshot())); },
        setPayload(value) { payload = value; }, destroy() { controller.destroy(); coordinator.destroy(); output.destroy(); } };
}


const testlive = { ...source, id: "testlive", url: "https://xibilive.flash.example/live/index.m3u8" };
async function withLive(run, { pendingPlay = false } = {}) {
    const previous = globalThis.document; const videos = [];
    globalThis.document = { createElement(tag) {
        if (tag !== "video") return { style: {}, children: [], setAttribute() {},
            appendChild(child) { this.children.push(child); }, remove() {} };
        const video = new EventTarget();
        Object.assign(video, { readyState: 2, networkState: 2, currentTime: 10,
            videoWidth: 1920, videoHeight: 1080, paused: false, ended: false,
            canPlayType: () => "probably", play: () => pendingPlay ? new Promise(() => {}) : Promise.resolve(),
            pause() {}, setAttribute() {}, removeAttribute() {}, load() {}, remove() {} });
        videos.push(video); return video;
    } };
    const h = acquisitionHarness({ selected: testlive });
    try {
        await flush(); videos[0].currentTime++; videos[0].dispatchEvent(new Event("timeupdate"));
        await h.time.advance(3000);
        assert.deepEqual(h.history.map(s => s.scene.id), ["A", "live-scene"]);
        assert.deepEqual(h.history.map(s => s.revision), [1, 2]);
        await run(h, videos);
    } finally { h.destroy(); globalThis.document = previous; }
}

for (const disturbance of ["waiting", "stalled", "progress-pause", "consumer-replacement", "timeline-reset"]) {
    test(`real external HLS transient ${disturbance}: retained history stays A LIVE`, async () => {
        await withLive(async (h, videos) => {
            const oldHandlers = h.consumers[0].handlers;
            if (disturbance === "consumer-replacement") {
                videos[0].dispatchEvent(new Event("error"));
                await h.time.advance(1000); assert.equal(videos.length, 2);
                oldHandlers.offline(); oldHandlers.online();
            } else if (disturbance === "progress-pause") {
                await h.time.advance(2000); // watchdog now enters uncertainty
            } else if (disturbance === "timeline-reset") {
                videos[0].dispatchEvent(new Event("waiting"));
                videos[0].currentTime = 0; videos[0].dispatchEvent(new Event("timeupdate"));
            } else videos[0].dispatchEvent(new Event(disturbance));
            assert.equal(h.monitor.getSnapshot().state, "CHECKING");
            assert.equal(h.controller.getSnapshot().status, "LOSS GRACE");
            await h.time.advance(2000);
            assert.equal(h.history.length, 2, "neither uncertainty nor replacement commits a return");
            const current = videos.at(-1); current.currentTime++;
            current.dispatchEvent(new Event("timeupdate")); await flush();
            assert.equal(h.controller.getSnapshot().status, "ON AIR");
            assert.equal(h.scheduler.ends, 0);
            assert.deepEqual(h.history.map(s => s.scene.id), ["A", "live-scene"]);
            assert.equal(h.state.commits, 1);
        });
    });
}

test("real external sustained waiting restores actual Program revision and cue exactly once", async () => {
    await withLive(async (h, videos) => {
        videos[0].dispatchEvent(new Event("waiting"));
        await h.time.advance(4999); assert.equal(h.history.length, 2);
        await h.time.advance(1);
        assert.deepEqual(h.history.map(s => s.scene.id), ["A", "live-scene", "A"]);
        assert.deepEqual(h.history.map(s => s.revision), [1, 2, 3]);
        assert.equal(h.history.at(-1).playback.initialTime, 37);
        await h.time.advance(15000); assert.equal(h.history.length, 3);
        assert.equal(h.scheduler.ends, 1);
    });
});

test("native health observer attaches while play promise is pending", async () => {
    await withLive(async h => assert.equal(h.state.commits, 1), { pendingPlay: true });
});

test("repeated uncertainty and consumer errors cannot postpone the source loss deadline", async () => {
    await withLive(async (h, videos) => {
        videos[0].dispatchEvent(new Event("error"));
        for (let n = 0; n < 4; n++) {
            await h.time.advance(1000); videos.at(-1).dispatchEvent(new Event("error"));
            assert.equal(h.history.length, 2);
        }
        await h.time.advance(1000);
        assert.deepEqual(h.history.map(s => s.scene.id), ["A", "live-scene", "A"]);
    });
});

test("queued uncertainty deadline from prior selection cannot publish stale OFFLINE", () => {
    const callbacks = []; let handlers;
    const monitor = new LiveSourceMonitor({ setTimer: fn => { callbacks.push(fn); return callbacks.length; }, clearTimer() {},
        consumerFactory: (_source, value) => { handlers = value; return { async start() {}, destroy() {} }; } });
    try {
        monitor.selectSource(testlive); handlers.online(); handlers.uncertain();
        const obsolete = callbacks.at(-1);
        monitor.selectSource(testlive); handlers.online(); obsolete();
        assert.equal(monitor.getSnapshot().state, "ONLINE");
    } finally { monitor.destroy(); }
});

test("bounded edge trace identifies waiting uncertainty and grace cancellation without URLs", async () => {
    const enabled = trace.enabled; trace.enabled = true; trace.clear();
    try { await withLive(async (h, videos) => {
        videos[0].dispatchEvent(new Event("waiting"));
        await h.time.advance(1000); videos[0].currentTime++;
        videos[0].dispatchEvent(new Event("timeupdate"));
        const events = trace.snapshot();
        const edge = events.find(e => e.scope === "live-player" && e.event === "uncertain");
        assert.equal(edge.sourceId, testlive.id); assert.equal(edge.networkState, 2);
        assert.ok(Number.isFinite(edge.consumerGeneration)); assert.ok(Number.isFinite(edge.hlsGeneration));
        assert.ok(Number.isFinite(edge.currentTime)); assert.ok(Number.isFinite(edge.lastProgressTime));
        assert.ok(events.some(e => e.event === "loss-grace-start"));
        assert.ok(events.some(e => e.event === "loss-grace-cancel"));
        assert.ok(!events.some(e => e.event === "restore-start"));
        assert.ok(!trace.exportJSON().includes("https://"));
        assert.ok(events.length <= 1000);
    }); } finally { trace.enabled = enabled; trace.clear(); }
});

test("twenty-five transient HLS gaps retain one session and exactly two Program revisions", async () => {
    await withLive(async (h, videos) => {
        const session = h.controller.getSnapshot().session;
        for (let n = 0; n < 25; n++) {
            videos[0].dispatchEvent(new Event("waiting")); await h.time.advance(100);
            videos[0].currentTime++; videos[0].dispatchEvent(new Event("timeupdate"));
            await h.time.advance(100);
            assert.equal(h.controller.getSnapshot().session, session);
        }
        assert.deepEqual(h.history.map(s => s.revision), [1, 2]);
        assert.equal(h.scheduler.ends, 0);
    });
});

 test("replacement readiness cannot be declared lost by the retired consumer deadline", async () => {
    await withLive(async (h, videos) => {
        const session = h.controller.session;
        videos[0].dispatchEvent(new Event("error"));
        await h.time.advance(1000);
        await h.time.advance(4000);
        assert.equal(h.state.program, "live-scene");
        assert.equal(h.controller.session, session);
        videos.at(-1).currentTime++;
        videos.at(-1).dispatchEvent(new Event("timeupdate")); await flush();
        assert.equal(h.controller.session, session);
        assert.equal(h.state.commits, 1);
    });
});

const slateId = "autolive-loss-slate";
function bindSlate(h) {
    const binding = new AutoLiveLossPresentation({ controller: h.controller, output: h.output,
        stateManager: h.state, renderer: h.renderer, root: document.createElement("div"), logoUrl: "https://example.test/logo.svg",
        eventBus: { on() {}, off() {} }, setTimer: h.time.set, clearTimer: h.time.clear });
    binding.start(); return binding;
}
const picture = s => s.graphics.items.some(i => i.id === slateId) ? "LOSS SLATE" : s.scene.id;
for (const persistent of [false, true]) test(
    persistent ? "loss slate persists until one cue-preserving return to A" : "transient loss slate recovers LIVE without A flash or acquisition", async () => {
    await withLive(async (h, videos) => {
        h.state.preview = "B";
        h.controller.handlePreviewChanged({ currentSceneId: "B", source: "operator" });
        const binding = bindSlate(h), session = h.controller.session;
        const target = session.returnTarget, preview = h.state.preview;
        const activation = h.history.at(-1).committedAt;
        try {
            videos[0].dispatchEvent(new Event("waiting"));
            assert.equal(picture(h.history.at(-1)), "LOSS SLATE");
            assert.equal(binding.element.children[1].textContent, "SEGNALE LIVE TEMPORANEAMENTE NON DISPONIBILE");
            assert.equal(h.history.at(-1).committedAt, activation);
            await h.time.advance(4999);
            assert.equal(h.state.program, "live-scene");
            assert.equal(h.controller.session, session);
            assert.equal(h.controller.session.returnTarget, target);
            assert.equal(h.state.preview, preview);
            assert.equal(h.state.commits, 1);
            if (persistent) {
                await h.time.advance(1);
                assert.equal(h.state.program, "A");
                assert.equal(h.history.at(-1).playback.initialTime, 37);
                assert.equal(h.scheduler.ends, 1);
            } else {
                videos[0].currentTime++; videos[0].dispatchEvent(new Event("timeupdate"));
                await flush();
                assert.equal(h.controller.session, session);
                assert.equal(h.scheduler.ends, 0);
                assert.equal(h.state.commits, 1);
            }
            assert.equal(h.state.preview, preview);
            assert.deepEqual(h.history.map(picture), ["A", "live-scene", "LOSS SLATE", persistent ? "A" : "live-scene"]);
        } finally { binding.destroy(); }
    });
});
test("operator TAKE during loss slate rejects stale health and grace callbacks", async () => {
    await withLive(async (h, videos) => {
        const binding = bindSlate(h);
        try {
            videos[0].dispatchEvent(new Event("waiting"));
            const staleHealth = h.monitor.getSnapshot();
            const queued = [...h.time.timers.values()].map(t => t.fn);
            // The command path commits operator B, then emits the ownership notification.
            await h.controller.command.execute({ sceneId: "B", transition: "CUT", origin: "operator" });
            h.controller.handleProgramChanged({ currentSceneId: "B", source: "operator" });
            binding.handleProgramChanged();
            const count = h.state.commits;
            h.controller.handleHealth({ ...staleHealth, state: "ONLINE" });
            queued.forEach(fn => fn()); await flush();
            assert.equal(h.state.program, "B");
            assert.equal(h.controller.session, null);
            assert.equal(h.state.commits, count);
            assert.equal(picture(h.history.at(-1)), "B");
            assert.equal(binding.presentation, null);
        } finally { binding.destroy(); }
    });
});

test("replacement with no progress confirms persistent loss at its bounded readiness timeout", async () => {
    await withLive(async (h, videos) => {
        const binding = bindSlate(h);
        try {
            videos[0].dispatchEvent(new Event("error"));
            await h.time.advance(5000);
            assert.equal(picture(h.history.at(-1)), "LOSS SLATE");
            await h.time.advance(7999);
            assert.equal(h.state.program, "live-scene");
            await h.time.advance(1);
            assert.equal(h.state.program, "A");
            assert.equal(h.scheduler.ends, 1);
        } finally { binding.destroy(); }
    });
});
test("cancelled grace callback cannot shorten a later loss in the same session", async () => {
    await withLive(async (h, videos) => {
        videos[0].dispatchEvent(new Event("waiting"));
        const obsolete = h.time.timers.get(h.controller.lossTimer).fn;
        videos[0].currentTime++; videos[0].dispatchEvent(new Event("timeupdate"));
        videos[0].dispatchEvent(new Event("waiting"));
        const active = h.controller.lossTimer;
        obsolete();
        assert.equal(h.controller.lossTimer, active);
        assert.equal(h.controller.lossGraceExpired, false);
        assert.equal(h.state.program, "live-scene");
    });
});

test("actual Program waiting enters the published slate even while source monitor remains ONLINE", async () => {
    await withLive(async (h, videos) => {
        const video = new EventTarget(); Object.assign(video, { currentTime: 10, readyState: 2, paused: false, ended: false });
        h.renderer.program = { renderer: { sourceId: testlive.id, video } };
        const binding = bindSlate(h), session = h.controller.session;
        const store = new ProgramOutputStore(), received = [];
        store.subscribe(envelope => received.push(envelope.snapshot));
        const publish = h.output.transport.publish;
        h.output.transport.publish = snapshot => { publish(snapshot);
            assert.equal(store.accept(createProgramOutputEnvelope(snapshot)).accepted, true); };
        try {
            video.dispatchEvent(new Event("waiting"));
            assert.equal(h.monitor.getSnapshot().state, "ONLINE");
            assert.equal(h.controller.getSnapshot().status, "LOSS GRACE");
            assert.equal(binding.element.children[1].textContent, "SEGNALE LIVE TEMPORANEAMENTE NON DISPONIBILE");
            assert.equal(picture(store.getCurrent().snapshot), "LOSS SLATE");
            assert.equal(await h.controller.restoreReturnTarget(session.returnTarget), false);
            assert.equal(h.state.commits, 1);
            videos[0].currentTime++; videos[0].dispatchEvent(new Event("timeupdate"));
            await h.time.advance(3000);
            video.currentTime++; video.dispatchEvent(new Event("timeupdate"));
            assert.equal(binding.presentation, null);
            assert.equal(h.controller.session, session);
            assert.equal(h.state.commits, 1);
            assert.equal(picture(received.at(-1)), "live-scene");
        } finally { binding.destroy(); }
    });
});
for (const persistent of [false, true]) test("explicit OFFLINE " + (persistent ? "persistent" : "3s transient") + " publishes slate before any return", async () => {
    await withLive(async h => {
        const binding = bindSlate(h), session = h.controller.session, preview = h.state.preview;
        const generation = h.monitor.getSnapshot().generation + 100;
        const health = { ...h.monitor.getSnapshot(), sourceHealth: true, state: "OFFLINE", generation };
        try {
            h.controller.handleHealth(health);
            assert.equal(picture(h.history.at(-1)), "LOSS SLATE");
            assert.equal(await h.controller.restoreReturnTarget(session.returnTarget), false);
            await h.time.advance(persistent ? 5000 : 3000);
            if (!persistent) h.controller.handleHealth({ ...health, state: "ONLINE", generation: generation + 1 });
            await flush();
            assert.deepEqual(h.history.map(picture), ["A", "live-scene", "LOSS SLATE", persistent ? "A" : "live-scene"]);
            assert.equal(h.state.preview, preview);
            if (!persistent) assert.equal(h.controller.session, session);
            else assert.equal(h.history.at(-1).playback.initialTime, 37);
        } finally { binding.destroy(); }
    });
});
test("operator override cancels Program-player recovery and detaches old progress listeners", async () => {
    await withLive(async h => {
        const video = new EventTarget(); Object.assign(video, { currentTime: 10, readyState: 2, paused: false });
        h.renderer.program = { renderer: { sourceId: testlive.id, video } };
        const binding = bindSlate(h);
        try {
            video.dispatchEvent(new Event("waiting"));
            await h.controller.command.execute({ sceneId: "B", origin: "operator" });
            h.controller.handleProgramChanged({ source: "operator", currentSceneId: "B" });
            binding.handleProgramChanged();
            video.currentTime++; video.dispatchEvent(new Event("timeupdate"));
            assert.equal(h.state.program, "B"); assert.equal(h.controller.session, null);
            assert.equal(binding.presentation, null); assert.equal(binding.observedSurface, null);
        } finally { binding.destroy(); }
    });
});

for (const override of [false, true]) test("fatal Program player recovery " + (override ? "cannot override operator TAKE" : "rebuilds only the player in the same session"), async () => {
    await withLive(async h => {
        const makeVideo = () => Object.assign(new EventTarget(), { currentTime: 10, readyState: 2, paused: false });
        const old = makeVideo(); let rebuilds = 0;
        h.renderer.program = { renderer: { sourceId: testlive.id, video: old } };
        h.renderer.renderSlot = () => { rebuilds++; h.renderer.program.renderer = { sourceId: testlive.id, video: makeVideo() }; };
        const binding = bindSlate(h), session = h.controller.session;
        try {
            old.dispatchEvent(new Event("error"));
            const stale = h.time.timers.get(binding.recoveryTimer).fn;
            assert.equal(picture(h.history.at(-1)), "LOSS SLATE");
            if (override) {
                await h.controller.command.execute({ sceneId: "B", origin: "operator" });
                h.controller.handleProgramChanged({ source: "operator", currentSceneId: "B" });
                binding.handleProgramChanged(); stale();
                assert.equal(rebuilds, 0); assert.equal(h.state.program, "B");
            } else {
                await h.time.advance(1000);
                assert.equal(rebuilds, 1);
                assert.equal(h.controller.session, session);
                assert.equal(picture(h.history.at(-1)), "LOSS SLATE");
                const video = h.renderer.program.renderer.video;
                video.currentTime++; video.dispatchEvent(new Event("timeupdate"));
                assert.equal(picture(h.history.at(-1)), "live-scene");
                assert.equal(h.state.commits, 1);
                assert.equal(h.scheduler.ends, 0);
            }
        } finally { binding.destroy(); }
    });
});
