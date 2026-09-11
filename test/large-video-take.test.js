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
        published, a, advance, progress }); }
    finally {
        output.destroy(); coordinator.destroy();
        EventBus.off(Events.STUDIO_PROGRAM_CHANGED, renderProgram);
        for (const surface of manager.getActiveInstances()) manager.destroyInstance(surface);
        globalThis.document = old.document; globalThis.setTimeout = old.setTimeout;
        globalThis.clearTimeout = old.clearTimeout; Date.now = old.now; console.log = old.log;
    }
}



function delayedVideo(h, { metadataAt = 0, frameAt = 0, seekAt = 0, pendingPlay = true } = {}) {
    const create = document.createElement;
    document.createElement = tag => {
        const el = create(tag);
        if (tag !== 'video') return el;
        el.readyState = 0; el.duration = NaN; el.networkState = 2;
        Object.defineProperty(el, 'src', { get: () => el._src, set: value => { el._src = value; } });
        Object.defineProperty(el, 'currentTime', { get: () => el._time, set: value => {
            el._time = value; el.seeking = true;
            h.time.set(() => { el.seeking = false; el.dispatchEvent(new Event('seeked')); }, seekAt);
        }});
        if (pendingPlay) el.play = () => new Promise(() => {});
        h.time.set(() => { el.duration = 6914.138; el.readyState = 1; el.dispatchEvent(new Event('loadedmetadata')); }, metadataAt);
        h.time.set(() => { el.readyState = 4; el.paused = false;
            el.dispatchEvent(new Event('loadeddata')); el.dispatchEvent(new Event('canplay')); el.dispatchEvent(new Event('playing'));
        }, frameAt);
        return el;
    };
    return () => { document.createElement = create; };
}

for (const [name, options] of [
    ['normal VIDEO', {pendingPlay:false}],
    ['delayed metadata', {metadataAt:8000,frameAt:9000}],
    ['delayed canplay', {metadataAt:100,frameAt:11000}],
    ['pending play with a ready frame', {metadataAt:100,frameAt:500}],
    ['delayed seek', {metadataAt:100,frameAt:200,seekAt:8000}]
]) test(`normal production TAKE succeeds with ${name}`, async () => {
    await harness(async h => {
        const restore = delayedVideo(h, options);
        try {
            const take = h.coordinator.cut({source:'operator', preparationContext:
                name === 'delayed seek' ? {transportCueTime:123} : null});
            assert.equal(h.coordinator.isBusy(), true);
            await h.time.advance(11999); await take;
            assert.equal(h.coordinator.isBusy(), false);
            assert.equal(h.state.getProgramSceneId(), 'P');
            assert.equal(h.published.at(-1).scene.id, 'P');
            if (name === 'delayed seek') assert.equal(h.renderer.program.renderer.video.currentTime,123);
        } finally { restore(); }
    });
});

for (const failure of ['metadata','frame','seek']) test(`bounded ${failure} failure releases busy, preserves Program and allows another TAKE`, async () => {
    await harness(async h => {
        const restore = delayedVideo(h, {metadataAt:failure==='metadata'?20000:0,
            frameAt:failure==='seek'?100:20000, seekAt:20000});
        try {
            const take=h.coordinator.cut({source:'operator',preparationContext:failure==='seek'?{transportCueTime:123}:null});
            await h.time.advance(11999); assert.equal(h.coordinator.isBusy(),true);
            await h.time.advance(1); assert.equal(await take,null);
            assert.equal(h.coordinator.isBusy(),false);
            assert.equal(h.coordinator.getLastTransitionResult().errorCode,'readiness-timeout');
            assert.equal(h.state.getProgramSceneId(),'A');
            assert.equal(h.state.getPreviewSceneId(),'P');
            assert.equal(h.published.at(-1).scene.id,'A');
            h.state.setPreviewScene('B',{source:'operator'});
            assert.ok(await h.coordinator.cut({source:'operator'}));
            assert.equal(h.state.getProgramSceneId(),'B');
            await h.time.advance(20000);
            assert.equal(h.state.getProgramSceneId(),'B');
        } finally { restore(); }
    });
});

test('TAKE button and controlled feedback recover without reload after pending play timeout', async () => {
    const {default:StudioUI}=await import('../public/js/ui/StudioUI.js');
    const {default:singleton}=await import('../public/js/core/StudioStateManager.js');
    await harness(async h => {
        const old={}; for(const method of ['getScenes','getPreviewSceneId','getProgramSceneId']){
            old[method]=singleton[method];singleton[method]=h.state[method].bind(h.state);
        }
        const ui=Object.assign(Object.create(StudioUI.prototype),{started:true,transitionCoordinator:h.coordinator,
            takeButton:new Element('button'),takeFeedback:new Element('p'),sceneList:new Element('div'),emptyState:new Element('div'),
            createSceneButton:()=>new Element('button')});
        const off=h.coordinator.subscribe(()=>ui.renderFromState());
        ui.renderFromState();
        const restore=delayedVideo(h,{metadataAt:20000,frameAt:20000});
        try {
            assert.equal(ui.takeButton.disabled,false);
            const take=ui.handleTakeClick(); assert.equal(ui.takeButton.disabled,true);
            await h.time.advance(12000);await take;
            assert.equal(ui.takeButton.disabled,false);
            assert.equal(ui.takeFeedback.hidden,false);
            assert.match(ui.takeFeedback.textContent,/TAKE non completato/);
        } finally {off();restore();Object.assign(singleton,old);}
    });
});

test('normal TAKE snapshots Preview cue into a separate Program media instance', async () => {
    await harness(async h => {
        const preview=new StudioMediaSurface({sourceId:'media',sourceUrl:'https://example.test/a.mp4',instanceId:'preview-test',consumer:'preview'});
        await preview.start(new Element('div'));preview.video.currentTime=456;await flush();
        h.renderer.preview.sceneId='P';h.renderer.setSlotRenderer(h.renderer.preview,preview);
        assert.ok(await h.coordinator.cut({source:'operator'}));
        assert.notEqual(h.renderer.program.renderer,preview);
        assert.equal(h.renderer.program.renderer.video.currentTime,456);
        assert.equal(h.state.getPreviewSceneId(),'A');
        assert.equal(h.published.at(-1).scene.id,'P');
        preview.destroy();
    });
});
