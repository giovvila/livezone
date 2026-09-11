import test from "node:test";
import assert from "node:assert/strict";
import StudioRenderer from "../public/js/studio/StudioRenderer.js";
import SourceManager from "../public/js/studio/StudioSourceManager.js";
import PublicProgramController from "../public/js/public/PublicProgramController.js";
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
        const consumer = factory(source, handlers);
        const start = consumer.start.bind(consumer);
        consumer.start = () => { const result = start(); consumer.video = document.lastVideo; return result; };
        consumers.push({ consumer, handlers }); return consumer;
    } });
    const state = { preview: null, program: "A", commits: 0,
        getPreviewSceneId() { return this.preview; }, getProgramSceneId() { return this.program; },
        getScene(id) { return ["live-scene", "A"].includes(id) ? { id, name: id, type: id === "A" ? "MEDIA" : "LIVE" } : null; },
        setPreviewScene(id) { this.preview = id; return {}; },
        take() { this.program = this.preview; this.preview = null; this.commits++; return { timestamp: "test" }; } };
    const catalog = { getSources: () => [selected, source, recorded], getDefinition: id => id === "live-scene"
        ? { id, renderer: { kind: "source", sourceId: selected.id } } : id === "A" ? { id, renderer: { kind: "source", sourceId: "recorded" } } : null,
        subscribe(fn) { fn([selected, source]); return () => {}; } };
    const renderer = { prepared: 0,
        getProgramTransport: () => state.program === "A" ? { sourceId: "recorded", currentTime: 37, duration: 120, state: "playing", ended: false } : null,
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
class Element extends EventTarget {
    constructor(tag) { super(); Object.assign(this, { tagName: tag, children: [], style: {},
        readyState: 2, networkState: 2, currentTime: 0, paused: false, ended: false,
        videoWidth: 1920, videoHeight: 1080 }); }
    appendChild(child) { this.children.push(child); child.parent = this; }
    replaceChildren(...children) { this.children = children; children.forEach(c => { c.parent = this; }); }
    append(...children) { children.forEach(c => this.appendChild(c)); }
    querySelector(tag) { return this.children.find(c => c.tagName === tag) || null; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
    setAttribute() {} removeAttribute() {} load() {} pause() {}
    play() { return Promise.resolve(); } canPlayType() { return "probably"; }
}
async function withPreroll(run, { immediate = false, delayedCandidate = false } = {}) {
    const previous = { document: globalThis.document, setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout, now: Date.now };
    const videos = [];
    globalThis.document = { createElement(tag) { const el = new Element(tag); if (tag === "video") {
        if (delayedCandidate && videos.length > 0) el.readyState = 0;
        videos.push(el); document.lastVideo = el; } return el; } };
    const h = acquisitionHarness({ selected: testlive });
    h.controller.prepareOnSourceOnline = immediate;
    const manager = new SourceManager.constructor(); manager.initialize({}); manager.registerSource(testlive);
    Object.assign(h.renderer, {
        started: true, definitionRegistry: h.output.catalog, studioSourceManager: manager,
        program: { baseRoot: new Element("div"), prepared: null, renderer: null, generation: 0 },
        createRenderer: StudioRenderer.prototype.createRenderer,
        prepareProgramScene: StudioRenderer.prototype.prepareProgramScene,
        discardPreparedProgram: StudioRenderer.prototype.discardPreparedProgram,
        releaseRenderer: StudioRenderer.prototype.releaseRenderer,
        activatePreparedProgram: StudioRenderer.prototype.activatePreparedProgram,
        setSlotRenderer(slot, renderer) { slot.renderer = renderer; }
    });
    h.renderer.program.consumer = "program";
    const take = h.state.take.bind(h.state);
    h.state.take = () => { const result = take(); const prepared = h.renderer.program.prepared;
        if (prepared) h.renderer.activatePreparedProgram(prepared); return result; };
    globalThis.setTimeout = h.time.set; globalThis.clearTimeout = h.time.clear; Date.now = h.time.now;
    const progress = video => { video.currentTime += 0.5; video.dispatchEvent(new Event("timeupdate")); };
    const advance = async (ms, candidateProgress = false) => {
        for (let elapsed = 0; elapsed < ms; elapsed += 500) {
            // Keep the independent source-health player online throughout.
            if (h.consumers.at(-1)?.consumer.video) progress(h.consumers.at(-1).consumer.video);
            if (candidateProgress && h.renderer.program.prepared?.renderer.video)
                progress(h.renderer.program.prepared.renderer.video);
            await h.time.advance(Math.min(500, ms - elapsed));
        }
    };
    try {
        await flush(); progress(videos[0]);
        if (immediate) await h.time.advance(0); else await advance(3000);
        assert.equal(h.history.length, 1, "source ONLINE alone never commits the Program candidate");
        assert.ok(h.renderer.program.prepared);
        assert.equal(h.renderer.program.prepared.root.hidden, false);
        await run({ ...h, videos, advance, progress });
    } finally {
        h.renderer.discardPreparedProgram(); h.renderer.releaseRenderer(h.renderer.program.renderer);
        h.destroy(); globalThis.document = previous.document;
        globalThis.setTimeout = previous.setTimeout; globalThis.clearTimeout = previous.clearTimeout; Date.now = previous.now;
    }
}

test("source ONLINE and first frame without candidate progress cannot TAKE", async () => {
    await withPreroll(async h => {
        assert.equal(h.renderer.program.prepared.renderer.readinessState, "ready");
        await h.advance(4000);
        assert.equal(h.state.commits, 0); assert.deepEqual(h.history.map(s => s.scene.id), ["A"]);
    });
});

test("candidate advancing less than 3000ms cannot TAKE; full stable window commits once", async () => {
    await withPreroll(async h => {
        await h.advance(3000, true); assert.equal(h.state.commits, 0);
        await h.advance(500, true); assert.equal(h.state.commits, 1);
        assert.deepEqual(h.history.map(s => s.scene.id), ["A", "live-scene"]);
        assert.deepEqual(h.history.map(s => s.revision), [1, 2]);
    });
});

for (const event of ["waiting", "stalled", "pause"]) test(`candidate ${event} resets pre-roll while A remains Program`, async () => {
    await withPreroll(async h => {
        await h.advance(2000, true);
        const video = h.renderer.program.prepared.renderer.video;
        video.dispatchEvent(new Event(event));
        await h.advance(1000);
        assert.equal(video.muted, true, "a pre-TAKE pause must not activate Program audio");
        assert.equal(h.state.commits, 0);
        await h.advance(3000, true); assert.equal(h.state.commits, 0);
        await h.advance(500, true); assert.equal(h.state.commits, 1);
    });
});

test("repeated candidate flaps time out and retry without any A LIVE A oscillation", async () => {
    await withPreroll(async h => {
        const candidate = h.renderer.program.prepared.renderer.video;
        for (let n = 0; n < 6; n++) {
            await h.advance(1000, true); candidate.dispatchEvent(new Event("waiting"));
            await h.advance(1000);
        }
        assert.deepEqual(h.history.map(s => s.scene.id), ["A"]);
        assert.equal(h.state.commits, 0); assert.equal(h.controller.latched, false);
        await h.advance(4000); // fresh health detection and candidate creation
        await h.advance(3500, true);
        assert.deepEqual(h.history.map(s => s.scene.id), ["A", "live-scene"]);
    });
});

test("candidate fatal failure discards it and retries without a return Program command", async () => {
    await withPreroll(async h => {
        h.renderer.program.prepared.renderer.video.dispatchEvent(new Event("error")); await flush();
        assert.equal(h.renderer.program.prepared, null);
        assert.equal(h.state.commits, 0); assert.equal(h.history.length, 1);
        assert.equal(h.controller.latched, false);
    });
});

test("a source-health edge resets candidate stability even between progress samples", async () => {
    await withPreroll(async h => {
        await h.advance(2000, true);
        h.videos[0].dispatchEvent(new Event("waiting")); h.progress(h.videos[0]);
        await h.advance(3000, true); assert.equal(h.state.commits, 0);
        await h.advance(1000, true); assert.equal(h.state.commits, 1);
    });
});

test("persistent post-TAKE source loss restores A once and preserves captured cue", async () => {
    await withPreroll(async h => {
        await h.advance(3500, true); assert.equal(h.state.commits, 1);
        // Restore uses the ordinary media preparation path in this harness.
        h.renderer.prepareProgramScene = async sceneId => ({ sceneId });
        h.videos[0].dispatchEvent(new Event("waiting"));
        await h.time.advance(5000); await flush();
        assert.deepEqual(h.history.map(s => s.scene.id), ["A", "live-scene", "A"]);
        assert.equal(h.history.at(-1).playback.initialTime, 37);
        await h.time.advance(5000); assert.equal(h.history.length, 3);
    });
});

for (const modes of [[], ["public"], ["obs"], ["public", "obs"]]) {
    test(`consumer isolation and thirty-minute lifetime: Control plus ${modes.join(" and ") || "none"}`, async () => {
        const previousHls = globalThis.Hls, native = Element.prototype.canPlayType;
        const instances = [];
        class Hls {
            static Events = { MANIFEST_PARSED: "manifest", ERROR: "error" };
            static isSupported() { return true; }
            constructor() { this.handlers = new Map(); this.loads = []; instances.push(this); }
            on(event, fn) { this.handlers.set(event, fn); }
            loadSource(url) { this.loads.push(url); }
            attachMedia(video) { this.video = video; queueMicrotask(() => this.handlers.get("manifest")?.()); }
            destroy() { this.destroyed = true; }
        }
        globalThis.Hls = Hls; Element.prototype.canPlayType = () => "";
        try { await withPreroll(async h => {
            const health = instances[0], candidate = instances[1]; const subscribers = [];
            const live = { ...h.history[0], revision: 2,
                scene: { id: "live-scene", name: "LIVE", type: "LIVE" }, source: testlive,
                playback: { ...h.history[0].playback, initialTime: 0, duration: null } };
            try {
                for (const mode of modes) {
                    const base = new Element("div"), graphics = new Element("div");
                    const subscriber = new PublicProgramController({ outputMode: mode,
                        root: { querySelector: s => s === "[data-public-base]" ? base : graphics },
                        transport: { destroy() {} } });
                    subscriber.renderGraphics = () => {}; subscriber.renderOverlays = () => {};
                    subscribers.push(subscriber); subscriber.handleSnapshot(live, { livePublisher: true });
                }
                await flush(); assert.equal(instances.length, 2 + modes.length);
                assert.equal(new Set(instances.map(i => i.video)).size, instances.length);
                for (const subscriber of subscribers) subscriber.getCurrentMedia().dispatchEvent(new Event("waiting"));
                assert.equal(h.monitor.getSnapshot().state, "ONLINE");
                await h.advance(3500, true); assert.equal(h.state.commits, 1);
                assert.equal(h.renderer.program.renderer.hls, candidate, "TAKE promotes the same warmed instance");
                await h.advance(30 * 60 * 1000);
                assert.equal(h.monitor.getSnapshot().state, "ONLINE");
                assert.equal(h.history.length, 2);
                assert.equal(instances.length, 2 + modes.length, "subscribers do not restart the health instance");
                assert.ok(instances.every(i => i.loads.length === 1));
                subscribers.forEach(s => s.destroy()); subscribers.length = 0;
                assert.notEqual(health.destroyed, true); assert.notEqual(candidate.destroyed, true);
                assert.equal(h.monitor.getSnapshot().state, "ONLINE");
            } finally { subscribers.forEach(s => s.destroy()); }
        }); } finally { globalThis.Hls = previousHls; Element.prototype.canPlayType = native; }
    });
}

test("pre-roll keeps Scheduler unreserved until TAKE and captures the then-current return cue", async () => {
    await withPreroll(async h => {
        assert.equal(h.controller.pendingSession.schedulerInterruptionContext, null);
        await h.advance(2000, true); assert.equal(h.controller.pendingSession.schedulerInterruptionContext, null);
        h.scheduler.programTransportProvider = () => ({ sourceId: "recorded", currentTime: 42, state: "playing" });
        await h.advance(1500, true);
        assert.equal(h.controller.getSnapshot().session.returnTarget.cueAtInterruption, 42);
        assert.equal(h.state.commits, 1);
    });
});

test("latency trace places candidate stability before the actual Program commit", async () => {
    const enabled = trace.enabled; trace.enabled = true; trace.clear();
    try { await withPreroll(async h => {
        await h.advance(3500, true);
        const events = trace.snapshot();
        const first = events.find(e => e.scope === "preroll" && e.event === "first-frame");
        const start = events.find(e => e.scope === "preroll" && e.event === "stability-start");
        const stable = events.find(e => e.scope === "preroll" && e.event === "stable");
        const commit = events.find(e => e.scope === "autolive" && e.event === "program-committed");
        assert.ok(first.at <= start.at); assert.equal(stable.at - start.at, 3000);
        assert.ok(stable.sequence < commit.sequence); assert.equal(commit.at - stable.at, 0);
    }); } finally { trace.enabled = enabled; trace.clear(); }
});

test("runtime immediate preparation has one 3s stability gate and promotes the same candidate", async () => {
    const enabled = trace.enabled; trace.enabled = true; trace.clear();
    try { await withPreroll(async h => {
        assert.equal(h.time.now(), 0, "no serial source-only stability sleep");
        const candidate = h.renderer.program.prepared.renderer;
        const count = h.videos.length;
        await h.advance(3000, true); assert.equal(h.state.commits, 0);
        await h.advance(500, true); assert.equal(h.state.commits, 1);
        assert.equal(h.renderer.program.renderer, candidate);
        assert.equal(h.videos.length, count, "TAKE creates no replacement HLS player");
        const events = trace.snapshot();
        assert.equal(events.filter(e => e.scope === "preroll" && e.event === "stability-start").length, 1);
        assert.equal(events.filter(e => e.scope === "preroll" && e.event === "stable").length, 1);
        const start = events.find(e => e.scope === "preroll" && e.event === "stability-start");
        const stable = events.find(e => e.scope === "preroll" && e.event === "stable");
        assert.equal(stable.at - start.at, 3000);
        assert.equal(events.find(e => e.event === "program-committed").at, 3000);
        assert.equal(events.filter(e => e.event === "surface-created" && e.scope === "preroll").length, 1);
        assert.ok(!events.some(e => e.reason?.includes("timeout")));
        assert.equal(h.time.now(), 3500);
    }, { immediate: true }); } finally { trace.enabled = enabled; trace.clear(); }
});

test("healthy candidate first frame at 10s still receives the complete stability window without reconstruction", async () => {
    const enabled = trace.enabled; trace.enabled = true; trace.clear();
    try { await withPreroll(async h => {
        const candidate = h.renderer.program.prepared.renderer;
        assert.equal(candidate.readinessState, "pending");
        await h.advance(10000);
        candidate.video.readyState = 2;
        candidate.video.dispatchEvent(new Event("canplay")); await flush();
        await h.advance(3500, true);
        assert.equal(h.state.commits, 1);
        assert.equal(h.renderer.program.renderer, candidate);
        assert.equal(h.videos.length, 2);
        assert.deepEqual(h.history.map(s => s.scene.id), ["A", "live-scene"]);
        const events = trace.snapshot();
        assert.equal(events.find(e => e.scope === "preroll" && e.event === "first-frame").at, 10000);
        assert.equal(events.find(e => e.scope === "preroll" && e.event === "stable").at, 13000);
        assert.equal(events.find(e => e.event === "program-committed").at, 13000);
    }, { immediate: true, delayedCandidate: true }); } finally { trace.enabled = enabled; trace.clear(); }
});
