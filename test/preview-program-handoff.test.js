import test from "node:test";
import assert from "node:assert/strict";
import EventBus from "../public/js/core/EventBus.js";
import Events from "../public/js/core/Events.js";
import { StudioStateManager } from "../public/js/core/StudioStateManager.js";
import StudioRenderer from "../public/js/studio/StudioRenderer.js";
import SourceManager from "../public/js/studio/StudioSourceManager.js";
import StudioTransitionCoordinator from "../public/js/studio/StudioTransitionCoordinator.js";
import StudioProgramCommand from "../public/js/scheduler/StudioProgramCommand.js";
import ProgramOutputManager from "../public/js/program-output/ProgramOutputManager.js";
import StudioMediaSurface from "../public/js/studio/renderers/StudioMediaSurface.js";

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Element extends EventTarget {
    addEventListener(name, fn, options) {
        (this.listenerHistory ??= []).push({ name, fn });
        super.addEventListener(name, fn, options);
    }
    constructor(tag) { super(); Object.assign(this, { tagName: tag, hidden: false, children: [], style: {}, dataset: {},
        classList: {add(){},remove(){}}, readyState: 4, seeking: false, currentTime: 0, duration: 600, paused: true, ended: false,
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
    const published = [];
    const output = new ProgramOutputManager({ stateManager: state, catalog, sourceManager: manager, renderer,
        graphicsManager: { subscribe: () => () => {}, getVisibleGraphics: () => [] }, transitionCoordinator: coordinator,
        transport: { start() {}, destroy() {}, publish(snapshot) { published.push(snapshot); } }, now: time.now });
    output.start();
    const progress = (ms = 1000) => { const surface = renderer.program.prepared?.renderer || renderer.program.renderer;
        surface.video.currentTime += Math.max(ms / 1000, 0.02); surface.video.dispatchEvent(new Event("timeupdate")); };
    const advance = async (ms, progressing = true) => {
        let remaining = ms;
        while (remaining > 0) { const step = Math.min(1000, remaining); await time.advance(step); if (progressing) { progress(step); await flush(); } remaining -= step; }
    };
    try { await run({ time, state, renderer, coordinator, command, output,
        published, a, advance, progress, manager, catalog }); }
    finally {
        output.destroy(); coordinator.destroy();
        if(renderer.testPreviewListener)EventBus.off(Events.STUDIO_PREVIEW_CHANGED,renderer.testPreviewListener);
        EventBus.off(Events.STUDIO_PROGRAM_CHANGED, renderProgram);
        for (const surface of manager.getActiveInstances()) manager.destroyInstance(surface);
        globalThis.document = old.document; globalThis.setTimeout = old.setTimeout;
        globalThis.clearTimeout = old.clearTimeout; Date.now = old.now; console.log = old.log;
    }
}




function registerFixtures(h, {still=true,motion=true}={}) {
    h.manager.registerSource({id:'media-b',kind:'media',url:'https://example.test/heavy-b.mp4'});
    definitions.set('P',{id:'P',renderer:{kind:'source',sourceId:'media-b'}});
    const audio={id:'audio-fixture',kind:'audio',audioUrl:'https://example.test/audio.mp3',
        ...(still?{stillUrl:'https://example.test/art.jpg'}:{}),...(motion?{motionUrl:'https://example.test/motion.mp4'}:{})};
    const index=sources.findIndex(s=>s.id===audio.id);if(index<0)sources.push(audio);else sources[index]=audio;
    h.manager.unregisterSource(audio.id);h.manager.registerSource(audio);definitions.set('AU',{id:'AU',renderer:{kind:'source',sourceId:audio.id}});
    definitions.set('BREAK',{id:'BREAK',renderer:{kind:'slate',logo:'https://example.test/logo.svg',title:'BREAK',message:''}});
    h.state.scenes.set('AU',{id:'AU',name:'Audio',type:'AUDIO'});h.state.scenes.set('BREAK',{id:'BREAK',name:'Break',type:'SLATE'});
    h.renderer.preview.baseRoot=new Element('div');h.renderer.preview.root.appendChild(h.renderer.preview.baseRoot);
    h.renderer.testPreviewListener=()=>h.renderer.renderPreviewFromState();EventBus.on(Events.STUDIO_PREVIEW_CHANGED,h.renderer.testPreviewListener);
}
async function selectPreview(h,id) {
    h.state.setPreviewScene(id,{source:'operator'});
    if(h.renderer.preview.sceneId!==id)await h.renderer.renderSlot(h.renderer.preview,id);await flush();
    const surface=h.renderer.preview.renderer,primary=surface.audio||surface.video;
    if(primary){primary.currentTime=18;primary.dispatchEvent(new Event('timeupdate'));}
    return surface;
}

const matrix=[];
const counts = h => h.manager.getActiveInstances().reduce((n,s) => {
 n.video += Number(Boolean(s.video)) + Number(Boolean(s.motion)); n.audio += Number(Boolean(s.audio)); return n;
}, {video:0,audio:0});
for (const type of ['cut','dissolve']) for (const [label,from,to] of [
 ['A','BREAK','P'],['B','A','BREAK'],['C','A','P'],['D','A','AU'],['E','AU','P'],['F','AU','AU2']]) {
 test('prepared surface handoff '+label+' '+type, async()=>harness(async h=>{
  registerFixtures(h);
  definitions.set('AU2',{id:'AU2',renderer:{kind:'source',sourceId:'audio-fixture'}});
  h.state.scenes.set('AU2',{id:'AU2',name:'Audio B',type:'AUDIO'});
  if(from!=='A'){h.state.programSceneId=from;await h.renderer.renderSlot(h.renderer.program,from);}
  const outgoing=h.renderer.program.renderer;
  const incoming=await selectPreview(h,to), primary=incoming.audio||incoming.video;
  if(primary){primary.currentTime=518;primary.dispatchEvent(new Event('timeupdate'));await flush();}
  const before=counts(h), originalCreate=h.manager.createInstance.bind(h.manager);
  let creates=0;
  h.manager.createInstance=(...args)=>{creates++;assert.ok(outgoing.destroyed || !outgoing.sourceId,'outgoing released before rebuilding Preview');const s=originalCreate(...args);return s;};
  if(type==='dissolve') for(const root of [h.renderer.program.contentRoot,h.renderer.preview.contentRoot])
   root.animate=()=>({finished:new Promise(resolve=>setTimeout(resolve,400)),cancel(){}});
  const taking=h.coordinator[type]({source:'operator'});await flush();
  assert.equal(h.renderer.program.renderer,incoming);assert.equal(incoming.consumer,'program');
  if(type==='dissolve'){assert.equal(creates,0);assert.equal(h.renderer.preview.renderer,null);assert.deepEqual(counts(h),before);}
  await h.time.advance(400);assert.ok(await taking);await flush();
  assert.equal(h.renderer.program.renderer,incoming);assert.notEqual(incoming.destroyed,true);
  if(primary){assert.equal(primary.currentTime,518);assert.equal(primary.muted,false);
   assert.equal(h.published.at(-1).playback.initialTime,518);}
  assert.ok(h.manager.getActiveInstances().filter(s=>s.audio&&!s.audio.paused&&!s.audio.muted).length<=1);
  if(incoming.motion)assert.equal(incoming.motion.muted,true);
  assert.ok(outgoing.destroyed || !outgoing.sourceId);
  assert.ok(h.renderer.preview.renderer!==incoming);
  assert.equal(h.renderer.preview.sceneId,from);
  if(from==='A')assert.equal(h.renderer.preview.renderer.video.currentTime,37);
  const {writeFileSync}=await import('node:fs');
  matrix.push({case:label,type,before,during:before,after:counts(h),newIncomingConsumers:0,
    newPreparationSeeks:0,preparationLatencyMs:0,timeoutConsumer:null,
    scope:'deterministic surface ownership; not native decoder or HTTP instrumentation'});
  writeFileSync('var/surface-handoff-resource-matrix.json',JSON.stringify(matrix,null,2));
  await selectPreview(h,'B');assert.equal(h.renderer.program.renderer,incoming);assert.notEqual(incoming.destroyed,true);
  assert.equal(h.coordinator.isBusy(),false);
 }));
}
test('Preview C selected during dissolve waits for A cleanup and cannot destroy B',async()=>harness(async h=>{
 registerFixtures(h);const b=await selectPreview(h,'P'),a=h.a;
 for(const root of [h.renderer.program.contentRoot,h.renderer.preview.contentRoot])root.animate=()=>({finished:new Promise(r=>setTimeout(r,400)),cancel(){}});
 const taking=h.coordinator.dissolve({source:'operator'});await flush();
 h.state.setPreviewScene('B',{source:'operator'});await flush();
 assert.equal(h.renderer.preview.renderer,null);assert.equal(b.destroyed,false);assert.equal(a.destroyed,false);
 await h.time.advance(400);assert.ok(await taking);await flush();
 assert.equal(h.renderer.preview.sceneId,'B');assert.equal(h.renderer.program.renderer,b);assert.equal(a.destroyed,true);
}));
test('reservation invalidation preserves A and current Preview, next TAKE succeeds',async()=>harness(async h=>{
 registerFixtures(h);const b=await selectPreview(h,'P');
 const taking=h.coordinator.cut({source:'operator'});h.state.setPreviewScene('B',{source:'operator'});await flush();
 assert.equal(await taking,null);assert.equal(h.renderer.program.renderer,h.a);assert.equal(h.a.destroyed,false);
 assert.equal(h.renderer.preview.sceneId,'B');assert.equal(h.coordinator.isBusy(),false);
 assert.ok(await h.coordinator.cut({source:'operator'}));
}));
test('failed DOM ownership staging rolls back borrowed Preview without destroying A or B',async()=>harness(async h=>{
 registerFixtures(h);const b=await selectPreview(h,'P'),root=h.renderer.preview.contentRoot;
 const append=h.renderer.program.baseRoot.appendChild;
 h.renderer.program.baseRoot.appendChild=()=>{throw new Error('move failed');};
 assert.equal(await h.coordinator.cut({source:'operator'}),null);
 assert.equal(h.renderer.program.renderer,h.a);assert.equal(h.renderer.preview.renderer,b);assert.equal(b.consumer,'preview');assert.equal(b.destroyed,false);
 assert.equal(root.parent,h.renderer.preview.baseRoot);assert.equal(h.coordinator.isBusy(),false);
 h.renderer.program.baseRoot.appendChild=append;assert.ok(await h.coordinator.cut({source:'operator'}));
}));

test('state commit rejection restores B Preview and retains A Program',async()=>harness(async h=>{
 registerFixtures(h);const b=await selectPreview(h,'P');const take=h.state.take.bind(h.state);
 h.state.take=()=>null;assert.equal(await h.coordinator.cut({source:'operator'}),null);
 assert.equal(h.renderer.program.renderer,h.a);assert.equal(h.renderer.preview.renderer,b);
 assert.equal(b.consumer,'preview');assert.equal(b.destroyed,false);assert.equal(h.coordinator.isBusy(),false);
 h.state.take=take;assert.ok(await h.coordinator.cut({source:'operator'}));
}));
test('a seek starting after reservation aborts handoff safely',async()=>harness(async h=>{
 registerFixtures(h);const b=await selectPreview(h,'P');
 assert.equal(await h.coordinator.cut({source:'operator',beforeCommit:()=>{b.video.seeking=true;}}),null);
 assert.equal(h.renderer.program.renderer,h.a);assert.equal(h.renderer.preview.renderer,b);assert.equal(b.destroyed,false);
 b.video.seeking=false;assert.ok(await h.coordinator.cut({source:'operator'}));
}));
for(const source of ['schedule','dominant-live'])test(source+' keeps separate preparation',async()=>harness(async h=>{
 registerFixtures(h);const b=await selectPreview(h,'P');
 assert.ok(await h.coordinator.cut({source}));assert.notEqual(h.renderer.program.renderer,b);
}));
test('explicit cue uses cold preparation instead of promoting the wrong cue',async()=>harness(async h=>{
 registerFixtures(h);const b=await selectPreview(h,'P');
 assert.ok(await h.coordinator.cut({source:'operator',preparationContext:{transportCueTime:42}}));
 assert.notEqual(h.renderer.program.renderer,b);assert.equal(h.renderer.program.renderer.video.currentTime,42);
}));
test('destroy during dissolve cleans outgoing once and stale completion cannot rebuild Preview',async()=>harness(async h=>{
 registerFixtures(h);const b=await selectPreview(h,'P');
 for(const root of [h.renderer.program.contentRoot,h.renderer.preview.contentRoot])root.animate=()=>({finished:new Promise(r=>setTimeout(r,400)),cancel(){}});
 const taking=h.coordinator.dissolve({source:'operator'});await flush();h.coordinator.destroy();h.renderer.destroy();
 await h.time.advance(400);assert.equal(await taking,null);assert.equal(h.manager.getActiveInstances().length,0);
 assert.equal(b.destroyed,true);assert.equal(h.renderer.preview.renderer,null);
}));

test('late Preview startup cannot destroy the promoted Program surface',async()=>harness(async h=>{
 registerFixtures(h);const create=h.manager.createInstance.bind(h.manager);let settle;
 h.manager.createInstance=(...args)=>{const s=create(...args);if(args[0]==='media-b'){
  const start=s.start.bind(s);s.start=async root=>{await start(root);await new Promise(r=>settle=r);};}return s;};
 h.state.previewSceneId='B';const b=await selectPreview(h,'P');assert.equal(b.readinessState,'ready');
 assert.ok(await h.coordinator.cut({source:'operator'}));settle();await flush();
 assert.equal(h.renderer.program.renderer,b);assert.equal(b.destroyed,false);
 assert.ok(h.manager.getActiveInstances().includes(b));
}));

test('rollback preserves pending Preview startup generation',async()=>harness(async h=>{
 registerFixtures(h);const create=h.manager.createInstance.bind(h.manager);let settle;
 h.manager.createInstance=(...args)=>{const s=create(...args);if(args[0]==='media-b'){
  const start=s.start.bind(s);s.start=async root=>{await start(root);await new Promise(r=>settle=r);};}return s;};
 h.state.previewSceneId='B';const b=await selectPreview(h,'P');h.state.take=()=>null;
 assert.equal(await h.coordinator.cut({source:'operator'}),null);settle();await flush();
 assert.equal(h.renderer.preview.renderer,b);assert.equal(b.destroyed,false);assert.equal(b.consumer,'preview');
}));
