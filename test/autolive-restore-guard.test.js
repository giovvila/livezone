import SchedulerEngine from "../public/js/scheduler/SchedulerEngine.js";
import {validateSchedule} from "../public/js/scheduler/ScheduleContract.js";
import test from "node:test";
import { AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS } from "../public/js/studio/AutoLivePostTakePolicy.js";
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
    const scheduler = new SchedulerEngine({command,catalog,clock:time.now,setTimer:time.set,clearTimer:time.clear,programTransportProvider:()=>renderer.getProgramTransport()});
    scheduler.setSchedule(validateSchedule({version:1,timezone:'UTC',items:[{id:'normal-a',title:'A',start:'1970-01-01T00:00:00Z',durationSeconds:86400,sceneId:'A',transition:'CUT'}]}).schedule);
    scheduler.enabled=true;scheduler.begins=0;scheduler.ends=0;
    const begin=scheduler.beginInterruption.bind(scheduler),end=scheduler.endInterruption.bind(scheduler);
    scheduler.beginInterruption=(...args)=>{scheduler.begins++;return begin(...args);};
    scheduler.endInterruption=(...args)=>{scheduler.ends++;return end(...args);};
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
        controller.destroy(); scheduler.destroy(); binding.destroy(); output.destroy(); coordinator.destroy();
        EventBus.off(Events.STUDIO_PROGRAM_CHANGED, renderProgram);
        for (const surface of manager.getActiveInstances()) manager.destroyInstance(surface);
        globalThis.document = old.document; globalThis.setTimeout = old.setTimeout;
        globalThis.clearTimeout = old.clearTimeout; Date.now = old.now; console.log = old.log;
    }
}

test('real Scheduler schedule refresh must retain external AutoLive interruption during short loss',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const session=h.controller.session,context=h.scheduler.interruptionContext;
 assert.equal(context.kind,'external');h.monitor.emit('OFFLINE');h.renderer.program.renderer.video.dispatchEvent(new Event('waiting'));await h.time.advance(2000);
 h.scheduler.setSchedule(h.scheduler.schedule);await h.scheduler.reconcile(true);await flush();
 assert.equal(h.state.getProgramSceneId(),'LIVE');assert.equal(h.controller.session,session);assert.equal(h.scheduler.interruptionContext,context);
 h.monitor.emit('ONLINE');h.progress();await flush();assert.deepEqual(history(h.published),['A','ENTRY','LIVE','LOSS','LIVE']);
}));

for(const elapsed of [1000,2000,5000,14000,14999])test('production restore commands cannot expose A at '+elapsed+'ms',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);const session=h.controller.session;
 let restore=0;const execute=h.command.execute.bind(h.command);h.command.execute=async args=>{const result=await execute(args);if(args.sceneId==='A'&&result.ok)restore++;return result;};
 h.monitor.emit('OFFLINE');h.renderer.program.renderer.video.dispatchEvent(new Event('waiting'));await h.time.advance(elapsed);
 const preview=h.state.getPreviewSceneId();assert.equal((await h.command.execute({sceneId:'A',origin:'scheduler'})).ok,false);
 assert.equal((await h.command.execute({sceneId:'A',origin:'dominant-live',preservePreview:true})).ok,false);
 assert.equal(h.state.setProgramScene('A',{source:'scheduler'}),null);assert.equal(h.command.release({origin:'scheduler'}).ok,false);
 h.state.applyExternalSelection('programSceneId','A',Events.STUDIO_PROGRAM_CHANGED);
 assert.equal(await h.controller.restoreReturnTarget(session.returnTarget),false);
 assert.equal(await h.controller.finishSession(session,'stale-cleanup'),false);
 assert.equal(h.controller.endSession('activation-failed'),false);
 assert.equal(h.state.getProgramSceneId(),'LIVE');assert.equal(h.state.getPreviewSceneId(),preview);assert.equal(h.controller.session,session);
 assert.equal(restore,0);assert.equal(h.scheduler.ends,0);assert.equal(h.scheduler.begins,1);
 h.monitor.emit('ONLINE');h.progress();await flush();assert.deepEqual(history(h.published),elapsed<2000?['A','ENTRY','LIVE']:['A','ENTRY','LIVE','LOSS','LIVE']);
}));
test('actual persistent return executes exactly once after 15s with real Scheduler',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);let restore=0,close=0;const execute=h.command.execute.bind(h.command),end=h.controller.endSession.bind(h.controller);
 h.command.execute=async args=>{const result=await execute(args);if(args.sceneId==='A'&&result.ok)restore++;return result;};
 h.controller.endSession=reason=>{const result=end(reason);if(result)close++;return result;};
 h.monitor.emit('OFFLINE');h.renderer.program.renderer.video.dispatchEvent(new Event('waiting'));await h.time.advance(14999);assert.equal(restore,0);assert.equal(close,0);
 await h.time.advance(1);await flush();assert.equal(restore,1);assert.equal(close,1);assert.equal(h.scheduler.ends,1);
 assert.equal(h.renderer.program.renderer.video.currentTime,37);assert.equal(h.state.getPreviewSceneId(),'P');
 assert.deepEqual(history(h.published),['A','ENTRY','LIVE','LOSS','A']);
}));
test('guard also checks TAKE at the state mutation boundary; operator remains authorized',async()=>harness(async h=>{
 await h.detect();await h.advance(61000);h.state.setPreviewScene('A',{source:'operator'});
 assert.equal(h.state.take({source:'scheduler'}),null);assert.equal(h.state.getProgramSceneId(),'LIVE');
 assert.ok((await h.command.execute({sceneId:'B',origin:'operator'})).ok);assert.equal(h.controller.session,null);assert.equal(h.state.getProgramSceneId(),'B');
}));
test('real schedule-refresh bypass trace documents old closure and fixed same-session recovery',async()=>harness(async h=>{
 const old=trace.enabled;trace.enabled=true;trace.clear();try{
 await h.detect();await h.advance(61000);const session=h.controller.session;
 h.monitor.emit('OFFLINE');h.renderer.program.renderer.video.dispatchEvent(new Event('waiting'));await h.time.advance(2000);
 // Simulate a lost context to exercise the final command guard independently of setSchedule fix.
 h.scheduler.interruptionContext=null;await h.scheduler.reconcile(true);await flush();
 assert.equal(h.controller.session,session);assert.equal(h.state.getProgramSceneId(),'LIVE');
 assert.ok(trace.snapshot().some(e=>e.event==='program-write-blocked'&&e.consumer==='scheduler'));
 h.monitor.emit('ONLINE');h.progress();await flush();assert.deepEqual(history(h.published),['A','ENTRY','LIVE','LOSS','LIVE']);
 writeFileSync('var/restore-guard-command-trace.json',trace.exportJSON());
 }finally{trace.enabled=old;trace.clear();}
}));

test('legacy discarded-context path writes A before closing as manual override, without a restore call',async()=>harness(async h=>{
 const old=trace.enabled;trace.enabled=true;trace.clear();try{
 await h.detect();await h.advance(61000);const session=h.controller.session;
 h.monitor.emit('OFFLINE');h.renderer.program.renderer.video.dispatchEvent(new Event('waiting'));await h.time.advance(2000);
 const deadline=h.controller.lossGraceDeadline,remaining=h.controller.activeHealth.remainingLossMs();let restoreCalls=0;const restore=h.controller.restoreReturnTarget.bind(h.controller);
 h.controller.restoreReturnTarget=(...args)=>{restoreCalls++;return restore(...args);};
 // Explicit fault injection reinstates the baseline context discard and removes
 // only the new state guard. Remaining Scheduler/command/render/output code is real.
 h.controller.removeProgramGuard();h.scheduler.interruptionContext=null;
 h.scheduler.setSchedule(h.scheduler.schedule);await h.scheduler.reconcile(true);await flush();
 assert.equal(h.state.getProgramSceneId(),'A');assert.equal(h.controller.session,null);assert.equal(restoreCalls,0);
 assert.equal(h.scheduler.ends,1);assert.equal(h.scheduler.begins,1);assert.ok(remaining>0);
 assert.deepEqual(history(h.published),['A','ENTRY','LIVE','LOSS','A']);
 h.monitor.emit('ONLINE');await h.time.advance(2000);assert.equal(h.controller.session,null);assert.equal(h.state.getProgramSceneId(),'A');
 writeFileSync('var/restore-guard-legacy-path.json',JSON.stringify({sessionId:session.sessionId,at:63000,deadline,remaining,sessionClosed:true,finalLiveSameSession:null,
  commandPath:'SchedulerEngine.setSchedule -> lost external context -> reconcile(true) -> StudioProgramCommand.execute -> StudioTransitionCoordinator.transition -> StudioStateManager.take',
  origin:'scheduler',restoreReturnTargetCalls:restoreCalls,sessionCloseCount:h.scheduler.ends,history:history(h.published),entries:trace.snapshot()},null,2));
 }finally{trace.enabled=old;trace.clear();}
}));
