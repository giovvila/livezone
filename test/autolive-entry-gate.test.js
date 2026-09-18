import test from "node:test";
import assert from "node:assert/strict";
import EventBus from "../public/js/core/EventBus.js";
import Events from "../public/js/core/Events.js";
import { StudioStateManager } from "../public/js/core/StudioStateManager.js";
import StudioRenderer from "../public/js/studio/StudioRenderer.js";
import SourceManager from "../public/js/studio/StudioSourceManager.js";
import StudioTransitionCoordinator from "../public/js/studio/StudioTransitionCoordinator.js";
import StudioProgramCommand from "../public/js/scheduler/StudioProgramCommand.js";
import AutoLiveEntryController from "../public/js/studio/AutoLiveEntryController.js";
import AutoLiveEntryPresentation from "../public/js/studio/AutoLiveEntryPresentation.js";
import ProgramOutputManager from "../public/js/program-output/ProgramOutputManager.js";
import { AUTO_LIVE_ENTRY_ABANDONMENT_MS } from "../public/js/studio/AutoLiveEntryPolicy.js";
import StudioMediaSurface from "../public/js/studio/renderers/StudioMediaSurface.js";
import StudioAudioSurface from "../public/js/studio/renderers/StudioAudioSurface.js";
import DominantLiveUI from "../public/js/ui/DominantLiveUI.js";

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Element extends EventTarget {
    addEventListener(name, fn, options) {
        (this.listenerHistory ??= []).push({ name, fn });
        super.addEventListener(name, fn, options);
    }
    constructor(tag) { super(); Object.assign(this, { tagName: tag, children: [], style: {}, dataset: {},
        readyState: 4, seeking: false, currentTime: 0, duration: 600, paused: true, ended: false,
        videoWidth: 1920, videoHeight: 1080, seekable: { length: 1, start: () => 0, end: () => 600 } }); }
    set src(value) { this._src = value; Promise.resolve().then(() => {
        if (this._src !== value) return;
        for (const name of ["loadedmetadata", "loadeddata", "canplay", "load"]) this.dispatchEvent(new Event(name));
    }); }
    get src() { return this._src; }
    set currentTime(value) { this._time = value; if (!this._src) return; Promise.resolve().then(() => this.dispatchEvent(new Event("seeked"))); }
    get currentTime() { return this._time; }
    appendChild(child) { child.remove(); this.children.push(child); child.parent = this; return child; }
    append(...children) { children.forEach(c => this.appendChild(c)); }
    replaceChildren(...children) { this.children.forEach(c => c.parent = null); this.children = []; this.append(...children); }
    get firstElementChild() { return this.children[0]; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    querySelector(tag) { return this.children.find(c => c.tagName === tag) || null; }
    setAttribute() {} removeAttribute() {} load() {} canPlayType() { return "probably"; }
    async play() { this.paused = false; this.dispatchEvent(new Event("playing")); }
    pause() { const changed = !this.paused; this.paused = true; if (changed) this.dispatchEvent(new Event("pause")); }
}
function clock() {
    let now = 0, serial = 0; const timers = new Map();
    return { now: () => now, timers,
        set(fn, ms) { timers.set(++serial, { fn, at: now + ms }); return serial; },
        clear(id) { timers.delete(id); },
        async advance(ms) { const until = now + ms; await flush();
            for (;;) { const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush(); }
            now = until; await flush(); }
    };
}
const live = { id: "live", kind: "hls", enabled: true, url: "https://example.test/live.m3u8", sceneIds: ["LIVE"] };
const sources = [live, { ...live, id: "other", sceneIds: ["OTHER"], url: "https://example.test/other.m3u8" },
    { id: "media", kind: "media", url: "https://example.test/a.mp4" },
    { id: "image", kind: "image", url: "https://example.test/b.png" }];
const definitions = new Map([...["A", "P"].map(id => [id, { id, renderer: { kind: "source", sourceId: "media" } }]),
    ["B", { id: "B", renderer: { kind: "source", sourceId: "image" } }],
    ["LIVE", { id: "LIVE", renderer: { kind: "source", sourceId: "live" } }],
    ["OTHER", { id: "OTHER", renderer: { kind: "source", sourceId: "other" } }]]);
const visual = snapshot => snapshot.source.id === "autolive-entry-slate" ? "ENTRY" :
    snapshot.graphics.items.some(i => i.id === "autolive-loss-slate") ? "LOSS" : snapshot.scene.id;
const history = values => values.map(visual).filter((v, i, all) => i === 0 || v !== all[i - 1]);

async function harness(run, { paused = false, candidateReady = true } = {}) {
    const old = { document: globalThis.document, setTimeout, clearTimeout, now: Date.now, log: console.log };
    const time = clock();
    globalThis.setTimeout = time.set; globalThis.clearTimeout = time.clear; Date.now = time.now;
    console.log = () => {};
    let videoCount = 0;
    globalThis.document = { createElement(tag) { const element = new Element(tag);
        if (tag === "video" && videoCount++ > 0 && !candidateReady) element.readyState = 0;
        return element; } };
    const state = new StudioStateManager({ storage: { getItem: () => null, setItem() {} } });
    for (const id of definitions.keys()) state.scenes.set(id, { id, name: id, type: ["LIVE", "OTHER"].includes(id) ? "LIVE" : id === "B" ? "IMAGE" : "MEDIA" });
    state.programSceneId = "A"; state.previewSceneId = "P";
    const catalog = { getSources: () => sources, getDefinition: id => definitions.get(id), subscribe: () => () => {} };
    const manager = new SourceManager.constructor(); manager.initialize({}); sources.forEach(s => manager.registerSource(s));
    const renderer = new StudioRenderer({ previewRoot: new Element("div"), programRoot: new Element("div"),
        studioStateManager: state, definitionRegistry: catalog, studioSourceManager: manager,
        studioGraphicsManager: { subscribe: () => () => {}, getVisibleGraphics: () => [] } });
    renderer.started = true; renderer.program.baseRoot = new Element("div"); renderer.program.root.appendChild(renderer.program.baseRoot);
    renderer.program.sceneId = "A";
    const a = manager.createInstance("media", { consumer: "program", initialPlayback: paused ? "paused" : "playing" });
    const aRoot = new Element("div"); renderer.program.baseRoot.appendChild(aRoot);
    await a.start(aRoot); a.video.currentTime = 37; a.video.dispatchEvent(new Event("loadeddata"));
    renderer.setSlotRenderer(renderer.program, a); renderer.program.contentRoot = aRoot;
    const renderProgram = record => renderer.renderProgramFromState(record);
    EventBus.on(Events.STUDIO_PROGRAM_CHANGED, renderProgram);
    const coordinator = new StudioTransitionCoordinator({ studioStateManager: state, studioRenderer: renderer }); coordinator.start();
    const command = new StudioProgramCommand({ stateManager: state, catalog, transitionCoordinator: coordinator });
    let healthGeneration = 0; const healthListeners = new Set();
    const monitor = { subscribe(fn) { healthListeners.add(fn); return () => healthListeners.delete(fn); },
        selectSource() {}, stop() {}, destroy() {}, refresh() {},
        emit(status, sourceId = live.id) { const value = { sourceId, sourceHealth: true, state: status, generation: ++healthGeneration };
            healthListeners.forEach(fn => fn(value)); return value; } };
    let setting = { armed: true, authorizedSourceId: live.id }; const configListeners = new Set();
    const config = { getSnapshot: () => setting, subscribe(fn) { configListeners.add(fn); fn(setting); return () => configListeners.delete(fn); },
        change(value) { setting = { ...setting, ...value }; configListeners.forEach(fn => fn(setting)); } };
    const scheduler = { enabled: true, begins: 0, ends: 0, context: null,
        getSnapshot() { return { enabled: true, interruptionContext: this.context }; }, subscribe: () => () => {},
        programTransportProvider: () => renderer.getProgramTransport(),
        beginInterruption() { this.begins++; this.context = { kind: "empty-slot" }; return this.context; },
        endInterruption() { this.ends++; this.context = null; return true; } };
    const controller = new AutoLiveEntryController({ renderer, config, catalog, monitor, scheduler, command,
        clock: time.now, setTimer: time.set, clearTimer: time.clear });
    const published = [];
    const output = new ProgramOutputManager({ stateManager: state, catalog, sourceManager: manager, renderer,
        graphicsManager: { subscribe: () => () => {}, getVisibleGraphics: () => [] }, transitionCoordinator: coordinator,
        transport: { start() {}, destroy() {}, publish(snapshot) { published.push(snapshot); } }, now: time.now });
    output.start(); controller.start();
    controller.getProgramRevision = () => output.revision;
    const binding = new AutoLiveEntryPresentation({ controller, renderer, stateManager: state, output,
        root: renderer.program.root, logoUrl: "https://example.test/logo.svg", setTimer: time.set, clearTimer: time.clear });
    binding.start();
    const progress = (ms = 1000) => { const surface = renderer.program.prepared?.renderer || renderer.program.renderer;
        surface.video.currentTime += Math.max(ms / 1000, 0.02); surface.video.dispatchEvent(new Event("timeupdate")); };
    const advance = async (ms, progressing = true) => {
        let remaining = ms;
        while (remaining > 0) { const step = Math.min(1000, remaining); await time.advance(step); if (progressing) { progress(step); await flush(); } remaining -= step; }
    };
    const detect = async () => { monitor.emit("ONLINE"); await flush(); progress(); await flush(); };
    try { await run({ time, state, renderer, controller, coordinator, command, monitor, config, scheduler, output, binding,
        published, a, advance, progress, detect }); }
    finally {
        controller.destroy(); binding.destroy(); output.destroy(); coordinator.destroy();
        EventBus.off(Events.STUDIO_PROGRAM_CHANGED, renderProgram);
        for (const surface of manager.getActiveInstances()) manager.destroyInstance(surface);
        globalThis.document = old.document; globalThis.setTimeout = old.setTimeout;
        globalThis.clearTimeout = old.clearTimeout; Date.now = old.now; console.log = old.log;
    }
}

test("entry immediately pauses A at its cue, preserves Preview and promotes the same candidate only at 30s", async () => {
    await harness(async h => {
        await h.detect();
        const session = h.controller.session, candidate = h.renderer.program.prepared.renderer;
        assert.deepEqual(history(h.published), ["A", "ENTRY"]);
        assert.equal(h.a.video.paused, true); assert.equal(h.a.video.currentTime, 37);
        assert.equal(h.state.getPreviewSceneId(), "P");
        assert.equal(h.binding.entryElement.children[1].textContent, "COLLEGAMENTO LIVE IN PREPARAZIONE");
        await h.advance(29999);
        assert.equal(h.state.getProgramSceneId(), "A"); assert.equal(h.controller.entryElapsedMs, 29999);
        await h.advance(1);
        assert.equal(h.state.getProgramSceneId(), "LIVE");
        assert.equal(h.renderer.program.renderer, candidate);
        assert.equal(h.controller.session.sessionId, session.sessionId);
        assert.equal(h.controller.session.returnTarget, session.returnTarget);
        assert.equal(h.scheduler.begins, 1); assert.equal(h.state.getPreviewSceneId(), "P");
        assert.deepEqual(history(h.published), ["A", "ENTRY", "LIVE"]);
    });
});

test("instability resets partial ENTRY and requires a new full 30 seconds", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(12000);
        const candidate = h.renderer.program.prepared.renderer;
        h.monitor.emit("OFFLINE"); candidate.video.dispatchEvent(new Event("waiting"));
        assert.equal(h.controller.entryElapsedMs, 0);
        await h.advance(3000, false);
        assert.deepEqual(history(h.published), ["A", "ENTRY"]);
        h.monitor.emit("ONLINE"); h.progress(); await flush();
        await h.advance(29999); assert.equal(h.state.getProgramSceneId(), "A");
        await h.advance(1); assert.equal(h.state.getProgramSceneId(), "LIVE");
        assert.equal(h.renderer.program.renderer, candidate);
        assert.deepEqual(history(h.published), ["A", "ENTRY", "LIVE"]);
    });
});

test("persistent entry loss abandons after 22s and resumes A once at the captured cue", async () => {
    await harness(async h => {
        await h.detect(); h.monitor.emit("OFFLINE");
        await h.advance(AUTO_LIVE_ENTRY_ABANDONMENT_MS - 1, false);
        assert.equal(visual(h.published.at(-1)), "ENTRY");
        await h.advance(1, false);
        assert.equal(h.controller.session, null); assert.equal(h.scheduler.ends, 1);
        assert.deepEqual(history(h.published), ["A", "ENTRY", "A"]);
        assert.equal(h.a.video.currentTime, 37); assert.equal(h.a.video.paused, false);
        assert.equal(h.state.getPreviewSceneId(), "P");
    });
});

test("operator TAKE during ENTRY cancels ownership and all stale completion paths", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(12000);
        const video = h.renderer.program.prepared.renderer.video;
        const callbacks = [...h.time.timers.values()].map(t => t.fn);
        const result = await h.command.execute({ sceneId: "B", origin: "operator" });
        assert.equal(result.ok, true); assert.equal(h.controller.session, null);
        video.currentTime += 100; video.dispatchEvent(new Event("timeupdate")); callbacks.forEach(fn => fn());
        await h.advance(65000, false);
        assert.equal(h.state.getProgramSceneId(), "B");
        assert.deepEqual(history(h.published), ["A", "ENTRY", "B"]);
        assert.equal(h.scheduler.ends, 1);
    });
});

test("disarm during ENTRY restores the paused Program without changing Preview", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(10000); h.config.change({ armed: false }); await flush();
        assert.equal(h.controller.session, null);
        assert.equal(h.a.video.paused, false); assert.equal(h.a.video.currentTime, 37);
        assert.equal(h.state.getPreviewSceneId(), "P");
        assert.deepEqual(history(h.published), ["A", "ENTRY", "A"]);
        await h.advance(65000, false); assert.equal(h.state.getProgramSceneId(), "A");
    });
});

test("changing authorization cancels the old candidate and rejects old-source ONLINE", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(29000);
        const video = h.renderer.program.prepared.renderer.video;
        h.config.change({ authorizedSourceId: "other" }); await flush();
        h.monitor.emit("ONLINE", "live"); video.currentTime++; video.dispatchEvent(new Event("timeupdate"));
        await h.advance(1000, false);
        assert.equal(h.state.getProgramSceneId(), "A"); assert.equal(h.controller.session, null);
        assert.deepEqual(history(h.published), ["A", "ENTRY", "A"]);
        h.monitor.emit("ONLINE", "other"); await flush(); h.progress(); await flush();
        assert.equal(h.controller.session.sourceId, "other");
        await h.advance(29999); assert.equal(h.state.getProgramSceneId(), "A");
        await h.advance(1); assert.equal(h.state.getProgramSceneId(), "OTHER");
    });
});

for (const persistent of [false, true]) test("30s entry retains captured cue through post-TAKE " + (persistent ? "confirmed loss" : "transient loss"), async () => {
    await harness(async h => {
        await h.detect(); const target = h.controller.session.returnTarget;
        await h.advance(30000); const sessionId = h.controller.session.sessionId;
        h.monitor.emit("OFFLINE");
        assert.equal(visual(h.published.at(-1)), "LOSS");
        await h.advance(persistent ? 5000 : 3000, false);
        if (!persistent) { h.monitor.emit("ONLINE"); h.progress(); await flush(); }
        assert.deepEqual(history(h.published), ["A", "ENTRY", "LIVE", "LOSS", persistent ? "A" : "LIVE"]);
        assert.equal(h.state.getPreviewSceneId(), "P");
        if (persistent) {
            assert.equal(h.scheduler.ends, 1);
            assert.equal(h.renderer.program.renderer.video.currentTime, 37);
            assert.equal(h.published.at(-1).playback.initialTime, 37);
        } else {
            assert.equal(h.controller.session.sessionId, sessionId);
            assert.equal(h.controller.session.returnTarget, target);
            assert.equal(h.scheduler.begins, 1);
        }
    });
});

test("an originally paused Program stays paused on entry cancellation", async () => {
    await harness(async h => {
        await h.detect(); h.config.change({ armed: false }); await flush();
        assert.equal(h.a.video.paused, true); assert.equal(h.a.video.currentTime, 37);
        assert.equal(h.published.at(-1).playback.state, "paused");
        assert.deepEqual(history(h.published), ["A", "ENTRY", "A"]);
    }, { paused: true });
});

test("runtime cleanup aborts entry work and stale timers cannot TAKE", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(29000);
        const video = h.renderer.program.prepared.renderer.video;
        const callbacks = [...h.time.timers.values()].map(t => t.fn);
        h.controller.destroy(); await flush();
        video.currentTime += 100; video.dispatchEvent(new Event("timeupdate")); callbacks.forEach(fn => fn());
        await h.advance(65000, false);
        assert.equal(h.state.getProgramSceneId(), "A"); assert.equal(h.controller.session, null);
        assert.equal(h.renderer.program.prepared, null);
        assert.equal(h.time.timers.size, 0);
    });
});

test("repeated ONLINE events do not double-count stability or create another interruption", async () => {
    await harness(async h => {
        await h.detect();
        for (let i = 0; i < 29; i++) { h.monitor.emit("ONLINE"); h.monitor.emit("ONLINE"); await h.advance(1000); }
        assert.equal(h.controller.entryElapsedMs, 29000); assert.equal(h.state.getProgramSceneId(), "A");
        assert.equal(h.scheduler.begins, 1);
        await h.advance(1000); assert.equal(h.state.getProgramSceneId(), "LIVE");
        assert.deepEqual(history(h.published), ["A", "ENTRY", "LIVE"]);
    });
});

test("readiness retries cannot keep ENTRY forever when no candidate can produce a frame", async () => {
    await harness(async h => {
        h.monitor.emit("ONLINE"); await flush();
        assert.equal(h.renderer.program.prepared.renderer.readinessState, "pending");
        await h.advance(21999, false);
        assert.equal(visual(h.published.at(-1)), "ENTRY");
        await h.advance(1, false);
        assert.equal(h.controller.session, null); assert.equal(h.scheduler.ends, 1);
        assert.deepEqual(history(h.published), ["A", "ENTRY", "A"]);
        assert.equal(h.a.video.currentTime, 37);
    }, { candidateReady: false });
});

test("fatal candidate retry keeps ENTRY and one return target through the new full gate", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(12000);
        const target = h.controller.session.returnTarget, sessionId = h.controller.session.sessionId;
        const candidate = h.renderer.program.prepared.renderer;
        candidate.video.dispatchEvent(new Event("error")); await flush();
        assert.equal(h.controller.entryElapsedMs, 0);
        await h.advance(5000, false);
        h.progress(); await flush();
        assert.notEqual(h.renderer.program.prepared.renderer, candidate);
        await h.advance(29999); assert.equal(h.state.getProgramSceneId(), "A");
        await h.advance(1); assert.equal(h.state.getProgramSceneId(), "LIVE");
        assert.equal(h.controller.session.sessionId, sessionId);
        assert.equal(h.controller.session.returnTarget, target);
        assert.deepEqual(history(h.published), ["A", "ENTRY", "LIVE"]);
    });
});

test("a cancelled abandonment callback cannot abort a recovered entry", async () => {
    await harness(async h => {
        await h.detect(); h.monitor.emit("OFFLINE");
        const obsolete = h.time.timers.get(h.controller.entryAbandonmentTimer).fn;
        h.monitor.emit("ONLINE"); h.progress(); await flush();
        obsolete(); assert.equal(h.controller.session.phase, "PREPARING");
        await h.advance(30000); assert.equal(h.state.getProgramSceneId(), "LIVE");
    });
});

test("a decoded frozen candidate never completes the gate and eventually abandons", async () => {
    await harness(async h => {
        h.monitor.emit("ONLINE"); await flush();
        assert.equal(h.renderer.program.prepared.renderer.readinessState, "ready");
        await h.advance(22000, false);
        assert.equal(h.controller.session, null);
        assert.deepEqual(history(h.published), ["A", "ENTRY", "A"]);
    });
});

test("an originally paused A returns paused after the full LIVE session ends", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(30000); h.monitor.emit("OFFLINE");
        await h.advance(5000, false);
        assert.equal(h.state.getProgramSceneId(), "A");
        assert.equal(h.renderer.program.renderer.video.paused, true);
        assert.equal(h.published.at(-1).playback.state, "paused");
        assert.equal(h.published.at(-1).playback.initialTime, 37);
        assert.equal(h.state.getPreviewSceneId(), "P");
    }, { paused: true });
});

for (const [kind, Surface, mediaKey] of [["media", StudioMediaSurface, "video"], ["audio", StudioAudioSurface, "audio"]]) {
    test(kind + " interruption pause cannot be undone by its normal Program pause recovery", async () => {
        const surface = new Surface({ sourceId: kind, consumer: "program", sourceUrl: "https://example.test/media", audioUrl: "https://example.test/audio" });
        const media = surface[mediaKey] = new Element(mediaKey);
        media.paused = false; media.currentTime = 37;
        media.addEventListener("pause", surface.handlePause);
        surface.pauseForInterruption(); await flush();
        assert.equal(media.paused, true);
        assert.equal(await surface.startPlayback(), false);
        await surface.resumeFromInterruption({ cueAtInterruption: 37, playbackState: "playing" });
        assert.equal(media.paused, false); assert.equal(media.currentTime, 37);
        media.removeEventListener("pause", surface.handlePause);
    });
}

test("Control displays the operational 12/30 counter while the published slate stays broadcast-safe", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(12000);
        const ui = new DominantLiveUI({ root: { dataset: {} } });
        ui.toggle = new Element("input"); ui.status = new Element("span"); ui.source = new Element("span");
        ui.render(h.controller.getSnapshot());
        assert.match(ui.status.textContent, /STABLE 12 \/ 30 s/);
        assert.equal(h.published.at(-1).source.title, "COLLEGAMENTO LIVE IN PREPARAZIONE");
        assert.deepEqual(Object.keys(h.published.at(-1).source).sort(), ["id", "kind", "title", "message", "logoUrl"].sort());
    });
});

test("entry completion and retry cannot supersede an operator TAKE with slow preparation", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(29000);
        const prepare = h.renderer.prepareProgramScene.bind(h.renderer);
        h.renderer.prepareProgramScene = async (sceneId, options) => {
            if (sceneId === "B") await new Promise(resolve => h.time.set(resolve, 7000));
            return prepare(sceneId, options);
        };
        const take = h.command.execute({ sceneId: "B", origin: "operator" });
        await h.advance(6000);
        assert.equal(h.coordinator.isBusy(), true);
        assert.equal(h.state.getProgramSceneId(), "A");
        await h.advance(1000, false);
        assert.equal((await take).ok, true);
        assert.equal(h.state.getProgramSceneId(), "B");
        assert.equal(h.controller.session, null);
        assert.deepEqual(history(h.published), ["A", "ENTRY", "B"]);
    });
});

test("entry captures fresh playback time rather than an older transport notification", async () => {
    await harness(async h => {
        h.a.video._time = 37.25; // Decoder advanced since its last timeupdate notification.
        assert.equal(h.renderer.getProgramTransport().currentTime, 37);
        await h.detect();
        assert.equal(h.controller.session.returnTarget.cueAtInterruption, 37.25);
        assert.equal(h.a.video.currentTime, 37.25); assert.equal(h.a.video.paused, true);
        h.config.change({ armed: false }); await flush();
        assert.equal(h.a.video.currentTime, 37.25);
    });
});

test("explicit re-arm starts a fresh entry when the authorized source stayed ONLINE", async () => {
    await harness(async h => {
        await h.detect(); const oldSession = h.controller.session.sessionId;
        h.config.change({ armed: false }); await flush();
        h.config.change({ armed: true }); await flush(); h.progress(); await flush();
        assert.equal(h.controller.session.phase, "PREPARING");
        assert.notEqual(h.controller.session.sessionId, oldSession);
        await h.advance(30000);
        assert.equal(h.state.getProgramSceneId(), "LIVE");
        assert.equal(h.scheduler.begins, 2); assert.equal(h.scheduler.ends, 1);
    });
});

test("20 healthy seconds plus a 2s wait plus 10 healthy seconds promotes exactly once", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(20000);
        const candidate = h.renderer.program.prepared.renderer;
        candidate.video.dispatchEvent(new Event('waiting'));
        assert.equal(h.controller.entryElapsedMs, 20000);
        await h.advance(2000, false);
        assert.equal(h.controller.entryElapsedMs, 20000);
        assert.deepEqual(history(h.published), ['A', 'ENTRY']);
        h.progress(); await flush();
        assert.equal(h.controller.entryElapsedMs, 20000);
        await h.advance(9999);
        assert.equal(h.controller.session.phase, 'PREPARING');
        await h.advance(1);
        assert.equal(h.controller.session.phase, 'LIVE');
        assert.deepEqual(history(h.published), ['A', 'ENTRY', 'LIVE']);
        assert.equal(h.scheduler.begins, 1);
        assert.equal(h.state.getPreviewSceneId(), 'P');
        assert.equal(h.controller.session.returnTarget.cueAtInterruption, 37);
    });
});

test("repeated short waits and CHECKING observations preserve accumulated health", async () => {
    await harness(async h => {
        await h.detect();
        for (let i = 0; i < 3; i++) {
            await h.advance(9000);
            const expected = (i + 1) * 9000;
            h.monitor.emit('CHECKING');
            h.renderer.program.prepared.renderer.video.dispatchEvent(new Event('waiting'));
            await h.advance(2000, false);
            assert.equal(h.controller.entryElapsedMs, expected);
            assert.deepEqual(history(h.published), ['A', 'ENTRY']);
            h.monitor.emit('ONLINE'); h.progress(); await flush();
            assert.equal(h.controller.entryElapsedMs, expected);
        }
        await h.advance(3000);
        assert.deepEqual(history(h.published), ['A', 'ENTRY', 'LIVE']);
    });
});

test("uncertainty has a fixed 5s boundary which repeated waiting cannot extend", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(20000);
        const candidate = h.renderer.program.prepared.renderer;
        candidate.video.dispatchEvent(new Event('waiting'));
        await h.advance(4000, false);
        candidate.video.dispatchEvent(new Event('waiting'));
        assert.equal(h.controller.entryElapsedMs, 20000);
        await h.advance(1000, false);
        assert.equal(h.controller.entryElapsedMs, 0);
        assert.deepEqual(history(h.published), ['A', 'ENTRY']);
        h.progress(); await flush(); await h.advance(30000);
        assert.equal(h.controller.session.phase, 'LIVE');
    });
});

test("stale source observations cannot pause or reset the active entry", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(20000);
        h.controller.handleHealth({sourceId:'live', sourceHealth:true, generation:0, state:'OFFLINE'});
        h.controller.handleHealth({sourceId:'other', sourceHealth:true, generation:999, state:'OFFLINE'});
        assert.equal(h.controller.entryElapsedMs, 20000);
        await h.advance(40000);
        assert.equal(h.controller.session.phase, 'LIVE');
    });
});

test("short progress gaps pause without earning frozen time or resetting", async () => {
    await harness(async h => {
        await h.detect(); await h.advance(20000);
        await h.advance(2000, false);
        assert.equal(h.controller.entryElapsedMs, 20000);
        h.progress(); await flush();
        await h.advance(40000);
        assert.equal(h.controller.session.phase, 'LIVE');
    });
});

test("bounded entry trace records pause resume and reset with safe runtime context", async () => {
    const { default: trace } = await import('../public/js/core/RuntimeTrace.js');
    const enabled = trace.enabled;
    trace.enabled = true; trace.clear();
    try {
        await harness(async h => {
            await h.detect(); await h.advance(20000);
            h.renderer.program.prepared.renderer.video.dispatchEvent(new Event('waiting'));
            await h.advance(2000, false); h.progress(); await flush();
            h.monitor.emit('OFFLINE');
            const entries = trace.snapshot().filter(e => e.scope === 'autolive-entry');
            const paused = entries.find(e => e.event === 'PAUSED' && e.reason === 'waiting');
            assert.equal(paused.stableElapsed, 20000);
            assert.equal(paused.sourceState, 'ONLINE');
            assert.equal(paused.waiting, true);
            for (const key of ['at','currentTime','lastProgressAge','readyState','consumerGeneration'])
                assert.equal(Number.isFinite(paused[key]), true, key);
            assert.equal(typeof paused.playerState, 'string');
            assert.ok(entries.some(e => e.event === 'RESUMED' && e.stableElapsed === 20000));
            assert.ok(entries.some(e => e.event === 'RESET' && e.reason === 'source-offline' && e.stableElapsed === 0));
            assert.ok(!JSON.stringify(entries).includes('https://'));
        });
    } finally { trace.clear(); trace.enabled = enabled; }
});

test('handoff is LIVE before synchronous Program subscribers and never republishes ENTRY', async () => {
    await harness(async h => {
        await h.detect();
        const candidate = h.renderer.program.prepared.renderer;
        const root = h.renderer.program.prepared.root;
        let detachments = 0;
        const remove = root.remove.bind(root);
        root.remove = () => { detachments++; remove(); };
        let commits = 0;
        const listener = record => {
            if (record.sceneId !== 'LIVE' && h.state.getProgramSceneId() !== 'LIVE') return;
            commits++;
            assert.equal(h.controller.session.phase, 'LIVE');
            h.controller.refreshDiagnostics();
            assert.equal(visual(h.published.at(-1)), 'LIVE');
        };
        EventBus.on(Events.STUDIO_PROGRAM_CHANGED, listener);
        try {
            await h.advance(30000);
            assert.equal(commits, 1);
            assert.equal(detachments, 0);
            assert.equal(h.renderer.program.renderer, candidate);
            assert.equal(candidate.destroyed, false);
            const revision = h.output.revision;
            await h.advance(30 * 60 * 1000);
            assert.equal(h.output.revision, revision);
            assert.equal(h.controller.health.state, 'ONLINE');
            assert.equal(h.controller.session.phase, 'LIVE');
            assert.deepEqual(history(h.published), ['A','ENTRY','LIVE']);
        } finally { EventBus.off(Events.STUDIO_PROGRAM_CHANGED, listener); }
    });
});

test('retired preparation callbacks and cleanup cannot mutate the promoted surface', async () => {
    await harness(async h => {
        await h.detect(); await h.advance(29000);
        const prepared = h.renderer.program.prepared;
        const callbacks = [...h.time.timers.values()].map(t => t.fn);
        const healthCallbacks = [...h.controller.entryHealthListeners];
        const abort = h.controller.entryAbort;
        await h.advance(1000);
        callbacks.forEach(fn => fn()); healthCallbacks.forEach(fn => fn()); abort.abort();
        h.renderer.discardPreparedProgram({ generation: prepared.generation });
        await flush();
        assert.equal(h.renderer.program.renderer, prepared.renderer);
        assert.equal(prepared.renderer.destroyed, false);
        assert.equal(h.controller.entryElapsedMs, 30000);
        assert.equal(h.controller.entryHealthListeners.size, 0);
        assert.equal(h.controller.session.phase, 'LIVE');
        assert.deepEqual(history(h.published), ['A','ENTRY','LIVE']);
    });
});

test('closed session with still ONLINE health retries after 5s and requires a fresh full gate', async () => {
    await harness(async h => {
        await h.detect(); await h.advance(30000);
        const old = h.controller.session;
        h.controller.endSession('source-loss'); await flush();
        assert.equal(h.renderer.program.renderer.video.currentTime, 37);
        assert.equal(h.controller.session, null);
        await h.advance(4999, false);
        assert.equal(h.controller.session, null);
        await h.advance(1, false); h.progress(); await flush();
        assert.equal(h.controller.session.phase, 'PREPARING');
        assert.notEqual(h.controller.session.sessionId, old.sessionId);
        h.controller.setProgramPlaybackLost(old.sessionId, true);
        await h.advance(29999);
        assert.equal(h.controller.session.phase, 'PREPARING');
        await h.advance(1);
        assert.equal(h.controller.session.phase, 'LIVE');
        assert.equal(h.scheduler.begins, 2);
        assert.equal(h.state.getPreviewSceneId(), 'P');
        assert.deepEqual(history(h.published), ['A','ENTRY','LIVE','A','ENTRY','LIVE']);
    });
});

for (const action of ['operator', 'disarm']) test(`pending reacquisition is cancelled by ${action} including stale retry`, async () => {
    await harness(async h => {
        await h.detect(); await h.advance(30000);
        h.controller.endSession('source-loss'); await flush();
        const retry = h.time.timers.get(h.controller.reacquisitionTimer).fn;
        if (action === 'operator') await h.command.execute({ sceneId: 'B', origin: 'operator' });
        else h.config.change({armed:false});
        retry(); await h.advance(70000, false);
        assert.equal(h.controller.session, null);
        assert.equal(h.state.getProgramSceneId(), action === 'operator' ? 'B' : 'A');
    });
});

test('confirmed loss restores cue and later ONLINE starts a new full entry session', async () => {
    await harness(async h => {
        await h.detect(); await h.advance(30000);
        const old = h.controller.session;
        h.monitor.emit('OFFLINE'); await h.advance(5000, false);
        assert.deepEqual(history(h.published), ['A','ENTRY','LIVE','LOSS','A']);
        assert.equal(h.renderer.program.renderer.video.currentTime, 37);
        h.monitor.emit('ONLINE'); await flush(); h.progress(); await flush();
        assert.notEqual(h.controller.session.sessionId, old.sessionId);
        await h.advance(29999); assert.equal(h.controller.session.phase,'PREPARING');
        await h.advance(1); assert.equal(h.controller.session.phase,'LIVE');
        assert.deepEqual(history(h.published), ['A','ENTRY','LIVE','LOSS','A','ENTRY','LIVE']);
    });
});

test('stale preparation waiting stalled error and health callbacks are inert after promotion', async () => {
    await harness(async h => {
        await h.detect();
        const candidate = h.renderer.program.prepared.renderer;
        const callbacks = candidate.video.listenerHistory.filter(e => e.fn.name === 'failure');
        const health = [...candidate.healthListeners];
        assert.ok(callbacks.some(e => e.name === 'waiting'));
        assert.ok(callbacks.some(e => e.name === 'stalled'));
        assert.ok(callbacks.some(e => e.name === 'error'));
        await h.advance(30000);
        callbacks.forEach(({ name, fn }) => fn(new Event(name)));
        health.forEach(fn => { fn({state:'stalled'}); fn({state:'error'}); });
        await flush(); await h.advance(10000);
        assert.equal(h.controller.session.phase, 'LIVE');
        assert.equal(h.controller.entryElapsedMs, 30000);
        assert.deepEqual(history(h.published), ['A','ENTRY','LIVE']);
    });
});

test('operator TAKE from a synchronous commit subscriber cannot resurrect LIVE ownership', async () => {
    await harness(async h => {
        await h.detect();
        const listener = record => {
            if (record.source === 'dominant-live' && h.state.getProgramSceneId() === 'LIVE')
                h.state.setProgramScene('B', { source:'operator', reason:'manual-take' });
        };
        EventBus.on(Events.STUDIO_PROGRAM_CHANGED, listener);
        try {
            await h.advance(30000); await h.advance(10000, false);
            assert.equal(h.state.getProgramSceneId(), 'B');
            assert.equal(h.controller.session, null);
            assert.equal(h.controller.latched, true);
            assert.equal(h.scheduler.ends, 1);
        } finally { EventBus.off(Events.STUDIO_PROGRAM_CHANGED, listener); }
    });
});

test('handoff trace distinguishes ENTRY from genuine LOSS and records source state at restore', async () => {
    const { default: trace } = await import('../public/js/core/RuntimeTrace.js');
    const { writeFileSync } = await import('node:fs');
    const enabled = trace.enabled, now = trace.now;
    trace.enabled = true; trace.clear();
    try {
        await harness(async h => {
            trace.now = h.time.now;
            await h.detect(); await h.advance(30000);
            h.monitor.emit('OFFLINE'); await h.advance(3000, false);
            h.monitor.emit('ONLINE'); h.progress(); await flush();
            assert.deepEqual(history(h.published), ['A','ENTRY','LIVE','LOSS','LIVE']);
            h.monitor.emit('OFFLINE'); await h.advance(5000, false);
            const entries = trace.snapshot();
            const handoff = entries.filter(e => e.scope === 'autolive-handoff');
            for (const event of ['gate-complete','commit-begin','entry-retired','live-active','active-player-observed','loss-request','close-request','restore-request'])
                assert.ok(handoff.some(e => e.event === event), event);
            const restore = handoff.find(e => e.event === 'restore-request');
            assert.equal(restore.sourceState, 'OFFLINE');
            assert.equal(Number.isFinite(restore.revision), true);
            assert.equal(entries.filter(e => e.scope === 'entry-slate' && e.event === 'show-request').length, 1);
            assert.equal(entries.filter(e => e.scope === 'loss-slate' && e.event === 'show-request').length, 2);
            writeFileSync('var/post-take-simulated-trace.json', trace.exportJSON());
        });
    } finally { trace.enabled = enabled; trace.now = now; trace.clear(); }
});

test('operator ownership stays protected across subsequent OFFLINE and ONLINE observations', async () => {
    await harness(async h => {
        await h.detect(); await h.advance(30000);
        await h.command.execute({sceneId:'B', origin:'operator'});
        h.monitor.emit('OFFLINE'); h.monitor.emit('ONLINE');
        await h.advance(70000, false);
        assert.equal(h.state.getProgramSceneId(), 'B');
        assert.equal(h.controller.session, null);
        h.config.change({armed:false}); h.config.change({armed:true}); await flush();
        assert.equal(h.controller.session.phase, 'PREPARING');
    });
});


test('A5 retained LIVE adoption restores AutoLive ownership without TAKE or Program mutation', async () => {
    await harness(async h => {
        h.state.setProgramScene('LIVE', {source:'program-output',reason:'retained-bootstrap'});
        h.renderer.program.sceneId = 'LIVE';
        h.renderer.program.renderer = {sourceId:'live'};
        h.renderer.programTransportSnapshot = Object.freeze({sourceId:'live',consumer:'program'});
        h.controller.started = true;
        h.controller.session = null;
        h.controller.pendingSession = null;
        h.controller.closingSession = null;
        h.controller.schedulerSnapshot = h.scheduler.getSnapshot();
        const before = history(h.published);
        const setting = h.controller.config.getSnapshot();
        const source = h.controller.getAuthorizedSource();
        const target = h.controller.resolveTarget(source);
        const scheduler = h.controller.schedulerSnapshot || h.scheduler.getSnapshot();
        const transport = h.renderer.getProgramTransport?.();
        assert.equal(setting.armed,true);
        assert.equal(scheduler.enabled,true);
        assert.equal(scheduler.interruptionContext,null);
        assert.equal(source?.id,'live');
        assert.equal(target?.sceneId,'LIVE');
        assert.equal(h.state.getProgramSceneId(),'LIVE');
        assert.equal(transport?.sourceId,'live');
        const adopted = h.controller.adoptRetainedLive();
        assert.equal(adopted,true);
        assert.equal(h.controller.session?.phase,'LIVE');
        assert.equal(h.controller.session?.sourceId,'live');
        assert.equal(h.controller.session?.retained,true);
        assert.equal(h.controller.acquisitionState,'ON_AIR');
        assert.deepEqual(history(h.published), before);
        assert.equal(h.scheduler.begins,0);
    });
});

test('A5 retained LIVE adoption fails closed on mismatched Program identity', async () => {
    await harness(async h => {
        h.state.setProgramScene('LIVE', {source:'program-output',reason:'retained-bootstrap'});
        h.renderer.program.renderer = {sourceId:'other'};
        h.controller.session = null;
        assert.equal(h.controller.adoptRetainedLive(),false);
        assert.equal(h.controller.session,null);
        assert.equal(h.scheduler.begins,0);
    });
});


test('A5 retained LIVE adoption retries when Program transport hydrates', async () => {
    await harness(async h => {
        h.state.setProgramScene('LIVE', {source:'program-output',reason:'retained-bootstrap'});
        h.renderer.program.sceneId = 'LIVE';
        h.controller.session = null;
        h.controller.pendingSession = null;
        h.controller.closingSession = null;
        h.controller.schedulerSnapshot = h.scheduler.getSnapshot();
        assert.equal(h.controller.adoptRetainedLive(),false);
        h.renderer.programTransportSnapshot = Object.freeze({sourceId:'live',consumer:'program'});
        h.renderer.programTransportListeners?.forEach?.(fn => fn(h.renderer.programTransportSnapshot));
        await flush();
        assert.equal(h.controller.session?.phase,'LIVE');
        assert.equal(h.controller.session?.retained,true);
        assert.equal(h.controller.acquisitionState,'ON_AIR');
        assert.equal(h.scheduler.begins,0);
    });
});


test('A5 retained LIVE adoption retries when config/bootstrap reconciliation completes', async () => {
    await harness(async h => {
        h.state.setProgramScene('LIVE', {source:'program-output',reason:'retained-bootstrap'});
        h.renderer.program.sceneId = 'LIVE';
        h.renderer.programTransportSnapshot = Object.freeze({sourceId:'live',consumer:'program'});
        h.controller.session = null;
        h.controller.pendingSession = null;
        h.controller.closingSession = null;
        h.controller.retainedAdoptionPending = true;
        h.controller.schedulerSnapshot = {enabled:false,interruptionContext:null};
        assert.equal(h.controller.tryAdoptRetainedLive(),false);
        h.controller.schedulerSnapshot = h.scheduler.getSnapshot();
        h.controller.reconcileConfiguration();
        assert.equal(h.controller.session?.phase,'LIVE');
        assert.equal(h.controller.session?.retained,true);
        assert.equal(h.controller.retainedAdoptionPending,false);
        assert.equal(h.scheduler.begins,0);
    });
});
