// Cold fallback contract: reusePreview:false deliberately exercises bounded duplicate preparation.
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




import StudioAudioSurface from '../public/js/studio/renderers/StudioAudioSurface.js';

test('primary ready AUDIO does not wait for an optional still or motion', async () => {
    const old=globalThis.document;globalThis.document={createElement:tag=>{const el=new Element(tag);if(tag==='img'||tag==='video')Object.defineProperty(el,'src',{get:()=>el._src,set:v=>{el._src=v;}});return el;}};
    const surface=new StudioAudioSurface({sourceId:'audio',audioUrl:'https://example.test/audio.mp3',
        stillUrl:'https://example.test/still.jpg',motionUrl:'https://example.test/motion.mp4',consumer:'program',instanceId:'audio-program'});
    try {
        await surface.start(new Element('div'));
        surface.imageReady=false;surface.motionReady=false;surface.metadataReady=true;surface.audioReady=true;
        surface.markReady();
        assert.equal(surface.readinessState,'ready');
    } finally {surface.destroy();globalThis.document=old;}
});

function registerFixtures(h, {still=true,motion=true}={}) {
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
function slowArtwork({neverStill=false,pendingMotion=false,neverMotion=false}={}) {
    const create=document.createElement;
    document.createElement=tag=>{
        const el=create(tag);
        if((tag==='img'&&neverStill)||(tag==='video'&&neverMotion)){
            el.readyState=0;Object.defineProperty(el,'src',{get:()=>el._src,set:v=>{el._src=v;}});
        }
        if(tag==='video'&&(pendingMotion||neverMotion))el.play=()=>new Promise(()=>{});
        return el;
    };
    return ()=>{document.createElement=create;};
}
for(const type of ['cut','dissolve']) for(const variation of ['plain','still','motion','slow-motion','pending-motion','missing-art'])
 test(`ready Preview AUDIO ${variation} ${type} preserves primary cue and optional fallback`,async()=>{
    await harness(async h=>{
        registerFixtures(h,{still:variation!=='plain'&&variation!=='motion',motion:!['plain','still'].includes(variation)});
        const preview=await selectPreview(h,'AU');assert.equal(preview.readinessState,'ready');
        const restore=slowArtwork({neverStill:variation==='missing-art',neverMotion:['slow-motion','missing-art'].includes(variation),pendingMotion:variation==='pending-motion'});
        try {
            const take=h.coordinator.transition({reusePreview:false,type,durationMs:type==='cut'?0:400,source:'operator'});
            const candidate=h.renderer.program.prepared.renderer, audio=candidate.audio;
            assert.equal(audio.autoplay,false);assert.equal(audio.muted,true);
            assert.equal(candidate.motionStarted,undefined);
            assert.equal(candidate.motion?.src,undefined);
            await flush();await h.time.advance(0);assert.ok(await take);
            assert.equal(h.state.getProgramSceneId(),'AU');assert.equal(candidate.audio,audio);
            assert.equal(audio.currentTime,18);assert.equal(audio.muted,false);
            assert.equal(h.manager.getActiveInstances().filter(s=>s.audio&&!s.audio.paused&&!s.audio.muted).length,1);
            assert.equal(h.published.at(-1).source.kind,'audio');assert.equal(h.published.at(-1).playback.initialTime,18);
            assert.equal(h.published.at(-1).source.stillUrl,candidate.stillUrl||undefined);
            assert.equal(h.published.at(-1).source.motionUrl,candidate.motionUrl||undefined);
            if(candidate.motion){assert.equal(candidate.motion.muted,true);assert.equal(candidate.motion.loop,true);}
            if(variation==='missing-art')assert.equal(candidate.placeholder.hidden,false);
            if(variation==='slow-motion'){
                assert.equal(candidate.image.hidden,false);assert.equal(candidate.motion.hidden,true);
                candidate.motion.readyState=4;candidate.motion.dispatchEvent(new Event('loadeddata'));await flush();
                assert.equal(candidate.motion.hidden,false);assert.equal(candidate.audio,audio);assert.equal(audio.currentTime,18);
            }
            await h.time.advance(13000);assert.equal(h.state.getProgramSceneId(),'AU');
            await selectPreview(h,'B');assert.equal(h.renderer.program.renderer,candidate);
        } finally {restore();}
    });
});

test('unavailable primary AUDIO still times out and releases TAKE',async()=>{
    await harness(async h=>{
        registerFixtures(h);await selectPreview(h,'AU');
        const create=document.createElement;document.createElement=tag=>{const e=create(tag);if(tag==='audio')e.readyState=0;return e;};
        try {
            const take=h.coordinator.cut({reusePreview:false,source:'operator'});await h.time.advance(12000);
            assert.equal(await take,null);assert.equal(h.state.getProgramSceneId(),'A');assert.equal(h.coordinator.isBusy(),false);
            await selectPreview(h,'B');assert.ok(await h.coordinator.cut({reusePreview:false,source:'operator'}));
        } finally {document.createElement=create;}
    });
});

const resourceRows=[];
function resourceState(h) {
    const elements=h.manager.getActiveInstances().flatMap(s=>[['video',s.video],['audio',s.audio],['motion',s.motion]].filter(([,e])=>e).map(([component,e])=>({
        component,instanceId:s.instanceId,consumer:s.consumer,tag:e.tagName,loaded:Boolean(e.src||e.children?.some(c=>c.src)),
        readyState:e.readyState,networkState:e.networkState??0,currentTime:e.currentTime,seeking:e.seeking,
        paused:e.paused,pendingPlay:e.pendingPlay===true
    })));
    return {videos:elements.filter(e=>e.tag==='video').length,audios:elements.filter(e=>e.tag==='audio').length,
        loadedVideos:elements.filter(e=>e.tag==='video'&&e.loaded).length,elements};
}
for(const [label,program,preview] of [['A','BREAK','P'],['B','A','BREAK'],['C','A','P'],['D','A','AU'],['E','AU','P']])
 test(`resource matrix ${label}: ${program} Program and ${preview} Preview`,async()=>{
    await harness(async h=>{
        registerFixtures(h);
        if(program!=='A'){h.state.setProgramScene(program,{source:'operator'});await flush();}
        await selectPreview(h,preview);
        const before=resourceState(h),create=document.createElement;
        document.createElement=tag=>{
            const e=create(tag);
            if(['video','audio'].includes(tag)){
                e.readyState=0;e.networkState=2;
                const play=e.play.bind(e);e.play=async()=>{e.pendingPlay=true;try{return await play();}finally{e.pendingPlay=false;}};
                h.time.set(()=>{e.readyState=4;e.networkState=1;for(const event of ['loadedmetadata','loadeddata','canplay'])e.dispatchEvent(new Event(event));},100);
            }
            return e;
        };
        try {
            const at=h.time.now(),take=h.coordinator.cut({reusePreview:false,source:'operator'}),during=resourceState(h);
            let completedAt;const completed=take.then(result=>{completedAt=h.time.now();return result;});
            await h.time.advance(100);assert.ok(await completed);
            const after=resourceState(h);
            assert.equal(h.state.getProgramSceneId(),preview);
            if(label==='A')assert.equal(before.videos,1);
            if(label==='B')assert.equal(during.videos,1);
            if(label==='C')assert.equal(during.videos,3);
            if(label==='D'){assert.equal(during.videos,3);assert.equal(during.loadedVideos,2);assert.equal(during.audios,2);}
            if(label==='E'){assert.equal(during.videos,3);assert.equal(during.audios,1);}
            resourceRows.push({case:label,program,preview,kind:'deterministic-element-census-not-browser-GPU-measurement',before,during,after,
                configuredPrimaryDelayMs:100,preparationLatencyMs:completedAt-at,timeoutConsumer:null,httpRangeConcurrency:'measured separately'});
            const {writeFileSync}=await import('node:fs');writeFileSync('var/generic-take-resource-matrix.json',JSON.stringify(resourceRows,null,2));
        } finally {document.createElement=create;}
    });
});

test('motion pending play is not duplicated by repeated health events',async()=>{
    const surface=new StudioAudioSurface({sourceId:'audio',audioUrl:'https://example.test/a.mp3',consumer:'program',instanceId:'pending-motion'});
    let calls=0,resolvePlay;surface.motion={play(){calls++;return new Promise(r=>resolvePlay=r);}};
    const first=surface.startMotionPlayback();const second=surface.startMotionPlayback();
    assert.equal(calls,1);resolvePlay();await first;await second;assert.equal(surface.motionPlayPending,null);
});

test('deactivating outgoing AUDIO does not automatically restart it',async()=>{
    const old=document;globalThis.document={createElement:tag=>new Element(tag)};
    const s=new StudioAudioSurface({sourceId:'out',audioUrl:'https://example.test/out.mp3',consumer:'program',instanceId:'out'});
    try{await s.start(new Element('div'));await s.activateProgram();assert.equal(s.audio.paused,false);
        s.deactivateProgram();await flush();assert.equal(s.audio.paused,true);
    }finally{s.destroy();globalThis.document=old;}
});

for(const scene of ['B','LIVE'])test(`normal prepared ${scene==='B'?'IMAGE':'LIVE'} retains required-media TAKE path`,async()=>{
    await harness(async h=>{registerFixtures(h);await selectPreview(h,scene);
        assert.ok(await h.coordinator.cut({reusePreview:false,source:'operator'}));assert.equal(h.state.getProgramSceneId(),scene);
        assert.equal(h.published.at(-1).scene.id,scene);
    });
});

test('A-E HTTP range matrix completes concurrent representative VIDEO/AUDIO reads',async t=>{
    const fs=await import('node:fs');if(!fs.existsSync('public/media/demo2.mp4'))return t.skip('protected local asset absent');
    const {createProgramOutputServer}=await import('../server/program-output-server.js');const {once}=await import('node:events');
    const {server}=createProgramOutputServer({publisherToken:'generic-media-range-test',mediaAssetRepository:{initialize:async()=>{},list:()=>[]}});
    server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
    const results=[];
    try {
        for(const [label,videos,audios] of [['A',2,0],['B',1,0],['C',3,0],['D',2,2],['E',3,1]]){
            const paths=[...Array(videos).fill('demo2.mp4'),...Array(audios).fill('test-audio.mp3')];
            let active=0,peak=0;const started=performance.now();
            const lengths=await Promise.all(paths.map(async(name,index)=>{
                active++;peak=Math.max(peak,active);const start=index*65536;
                try{const response=await fetch(`${base}/media/${name}`,{headers:{Range:`bytes=${start}-${start+65535}`},signal:AbortSignal.timeout(5000)});
                    assert.equal(response.status,206);const buffer=await response.arrayBuffer();assert.equal(buffer.byteLength,65536);return buffer.byteLength;
                }finally{active--;}
            }));
            results.push({case:label,videoRangeRequests:videos,audioRangeRequests:audios,peakClientRequests:peak,elapsedMs:performance.now()-started,lengths,
                scope:'real HTTP controlled range reads; not browser decoder load'});
        }
        fs.writeFileSync('var/generic-take-http-matrix.json',JSON.stringify(results,null,2));
    }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('late primary play and rejected optional motion promises cannot revive retired audio or leak errors',async()=>{
    const s=new StudioAudioSurface({sourceId:'late',audioUrl:'https://example.test/a.mp3',consumer:'program',instanceId:'late'});
    let resume;s.audio={paused:true,play(){return new Promise(r=>{resume=()=>{this.paused=false;r();};});},pause(){this.paused=true;}};
    const primary=s.startPlayback();s.deactivateProgram();resume();assert.equal(await primary,false);assert.equal(s.audio.paused,true);
    let reject;s.motion={play:()=>new Promise((_,r)=>reject=r)};
    const first=s.startMotionPlayback(),second=s.startMotionPlayback();reject(new Error('artwork unavailable'));
    assert.deepEqual(await Promise.all([first,second]),[false,false]);assert.equal(s.motionFailed,true);
});

test('AUDIO nonzero cue issues one seek while readiness events repeat',async()=>{
    const previous=globalThis.document;let seeks=0,position=0;
    globalThis.document={createElement:tag=>{const e=new Element(tag);if(tag==='audio')Object.defineProperty(e,'currentTime',{
        get:()=>position,set:v=>{position=v;seeks++;e.seeking=true;}});return e;}};
    const s=new StudioAudioSurface({sourceId:'cue',audioUrl:'https://example.test/a.mp3',consumer:'program',instanceId:'cue',initialTime:18});
    try {
        s.beginProgramPreparation();await s.start(new Element('div'));const ready=s.waitUntilReady({timeoutMs:12000});
        for(let i=0;i<20;i++){s.handleLoadedMetadata();s.handleAudioReady();s.handleTransportUpdate();}
        assert.equal(seeks,1);assert.equal(s.readinessState,'pending');assert.equal(s.audio.paused,true);
        s.audio.seeking=false;s.handleSeeked();await ready;assert.equal(s.readinessState,'ready');assert.equal(position,18);
    }finally{s.destroy();globalThis.document=previous;}
});
