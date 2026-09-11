import { AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS } from "../public/js/studio/AutoLivePostTakePolicy.js";
import test from "node:test";
import trace from "../public/js/core/RuntimeTrace.js";
import { writeFileSync } from "node:fs";
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
        emit(status, sourceId = live.id) { const value = { sourceId, sourceHealth: true, authority: "external-hls", state: status, generation: ++healthGeneration };
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

test('short waiting every 10 seconds must not publish LOSS while LIVE keeps playing',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);
 for(let i=0;i<20;i++){await h.advance(9500);const v=h.renderer.program.renderer.video;v.dispatchEvent(new Event('waiting'));await h.time.advance(200);h.progress();await flush();}
 assert.deepEqual(history(h.published),['A','ENTRY','LIVE']);assert.equal(h.scheduler.ends,0);
}));

for(const event of ['waiting','stalled'])test('subsecond '+event+' preserves LIVE video and audio without revision',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const revision=h.output.revision,v=h.renderer.program.renderer.video,session=h.controller.session;
 v.dispatchEvent(new Event(event));await h.time.advance(300);assert.equal(h.binding.presentation,null);assert.equal(v.paused,false);assert.equal(v.muted,false);
 h.progress();await flush();assert.equal(h.output.revision,revision);assert.equal(h.controller.session,session);
 assert.deepEqual(history(h.published),['A','ENTRY','LIVE']);
}));
test('60 minutes of short periodic gaps produce no slate or session replacement',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const session=h.controller.session;
 for(let n=0;n<360;n++){await h.advance(9700);h.renderer.program.renderer.video.dispatchEvent(new Event(n%2?'waiting':'stalled'));await h.time.advance(300);h.progress();await flush();}
 assert.deepEqual(history(h.published),['A','ENTRY','LIVE']);assert.equal(h.controller.session,session);assert.equal(h.scheduler.ends,0);assert.equal(h.scheduler.begins,1);
 assert.equal(h.state.getPreviewSceneId(),'P');assert.equal(session.returnTarget.cueAtInterruption,37);
 writeFileSync('var/health-debounce-60min-history.json',JSON.stringify({history:history(h.published),minutes:60,shortGaps:360,begins:h.scheduler.begins,ends:h.scheduler.ends},null,2));
}));
test('currentTime polling tolerates delayed timeupdate notifications',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const v=h.renderer.program.renderer.video;
 for(let i=0;i<30;i++){v.currentTime+=1;await h.time.advance(1000);}
 assert.equal(h.binding.presentation,null);assert.deepEqual(history(h.published),['A','ENTRY','LIVE']);
}));
test('significant uncertainty shows once, deliberately retains audio, and recovers once',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const v=h.renderer.program.renderer.video,session=h.controller.session;
 v.dispatchEvent(new Event('waiting'));await h.time.advance(1999);assert.equal(h.binding.presentation,null);
 await h.time.advance(1);assert.ok(h.binding.presentation);assert.equal(v.paused,false);assert.equal(v.muted,false);
 assert.equal(h.published.at(-1).source.id,'live');assert.equal(h.published.at(-1).playback.playing,true);
 assert.deepEqual(history(h.published),['A','ENTRY','LIVE','LOSS']);
 await h.time.advance(15000);assert.equal(h.controller.session,session);assert.equal(h.scheduler.ends,0);
 h.progress();await flush();assert.deepEqual(history(h.published),['A','ENTRY','LIVE','LOSS','LIVE']);
 assert.equal(h.controller.session,session);assert.equal(h.binding.presentation,null);
}));
test('renderer-only long stall cannot close while source evidence is ONLINE',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const session=h.controller.session;
 h.renderer.program.renderer.video.dispatchEvent(new Event('stalled'));await h.time.advance(60000);
 assert.equal(h.controller.session,session);assert.equal(h.scheduler.ends,0);
 assert.equal(h.controller.endSession('source-loss'),false);assert.equal(h.controller.session,session);
 assert.deepEqual(history(h.published),['A','ENTRY','LIVE','LOSS']);
}));
test('confirmed source absence plus persistent Program loss restores A once then permits new gate',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const session=h.controller.session;
 h.monitor.emit('OFFLINE');h.renderer.program.renderer.video.dispatchEvent(new Event('waiting'));await h.time.advance(AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS);await flush();
 assert.equal(h.controller.session,null);assert.equal(h.scheduler.ends,1);assert.equal(h.renderer.program.renderer.video.currentTime,37);
 assert.deepEqual(history(h.published),['A','ENTRY','LIVE','LOSS','A']);assert.equal(h.state.getPreviewSceneId(),'P');
 await h.detect();assert.notEqual(h.controller.session.sessionId,session.sessionId);await h.advance(29000);assert.equal(h.controller.session.phase,'PREPARING');await h.advance(2000);
 assert.deepEqual(history(h.published),['A','ENTRY','LIVE','LOSS','A','ENTRY','LIVE']);
}));
test('source recovery before close withdraws confirmation even while renderer remains stalled',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const session=h.controller.session;
 h.monitor.emit('OFFLINE');h.renderer.program.renderer.video.dispatchEvent(new Event('waiting'));await h.time.advance(5500);
 h.monitor.emit('ONLINE');await h.time.advance(20000);assert.equal(h.controller.session,session);assert.equal(h.scheduler.ends,0);
}));
test('stale watchdog after operator override cannot show slate or restore A',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const owner=h.controller.activeHealth,stale=h.time.timers.get(owner.timer).fn;
 assert.ok((await h.command.execute({sceneId:'B',origin:'operator'})).ok);stale();owner.uncertain('stale');owner.check();await h.time.advance(15000);
 assert.equal(h.state.getProgramSceneId(),'B');assert.equal(h.binding.presentation,null);assert.equal(h.scheduler.begins,1);
}));
test('bounded diagnostics distinguish suppressed uncertainty and visible loss without URLs',async()=>harness(async h=>{
 const old=trace.enabled;trace.enabled=true;trace.clear();try{
 await h.detect();await h.advance(61000);const v=h.renderer.program.renderer.video;
 v.dispatchEvent(new Event('waiting'));await h.time.advance(300);h.progress();await flush();
 v.dispatchEvent(new Event('stalled'));await h.time.advance(3000);
 const decisions=trace.snapshot().filter(e=>e.scope==='autolive-visual-health');
 assert.ok(decisions.some(e=>e.state==='SUPPRESSED'));assert.ok(decisions.some(e=>e.state==='SHOWN'));
 assert.ok(decisions.every(e=>e.ownershipState==='NO'));assert.ok(!JSON.stringify(decisions).includes('https://'));
 writeFileSync('var/health-debounce-decisions.json',JSON.stringify(decisions,null,2));
 }finally{trace.enabled=old;trace.clear();}
}));

test('brief progress gap without waiting event preserves current picture and audio',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const v=h.renderer.program.renderer.video;
 await h.time.advance(1500);assert.equal(h.binding.presentation,null);assert.equal(v.paused,false);assert.equal(v.muted,false);
 h.progress();await flush();assert.deepEqual(history(h.published),['A','ENTRY','LIVE']);
}));
test('unknown source with prolonged missing playback remains bounded',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);h.monitor.emit('CHECKING');
 h.renderer.program.renderer.video.dispatchEvent(new Event('waiting'));await h.time.advance(AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS-1);
 assert.ok(h.controller.session);await h.time.advance(1);await flush();
 assert.equal(h.controller.session,null);assert.equal(h.scheduler.ends,1);assert.deepEqual(history(h.published),['A','ENTRY','LIVE','LOSS','A']);
}));
test('superseded watchdog token cannot re-arm or publish LOSS',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const owner=h.controller.activeHealth,stale=h.time.timers.get(owner.timer).fn;
 await h.advance(1000);const timer=owner.timer;stale();assert.equal(owner.timer,timer);
 assert.deepEqual(history(h.published),['A','ENTRY','LIVE']);assert.equal(h.scheduler.ends,0);
}));
