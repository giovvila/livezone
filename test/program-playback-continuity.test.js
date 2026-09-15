import test from "node:test";
import assert from "node:assert/strict";
import { programPlaybackContinuity, MAX_CONTINUITY_AGE_MS } from
    "../public/js/studio/ProgramPlaybackContinuity.js";
import { StudioStateManager } from "../public/js/core/StudioStateManager.js";
import StudioRenderer from "../public/js/studio/StudioRenderer.js";
import ProgramOutputManager from "../public/js/program-output/ProgramOutputManager.js";
import NetworkProgramOutputTransport from "../public/js/program-output/NetworkProgramOutputTransport.js";
import LocalProgramOutputTransport from "../public/js/program-output/LocalProgramOutputTransport.js";
import { createProgramOutputEnvelope } from "../public/js/program-output/ProgramOutputEnvelope.js";

const at = Date.parse("2026-09-08T10:00:00Z");
function fixture(kind = "media", playing = true) {
    const values = new Map();
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
    const state = () => {
        const value = new StudioStateManager({ storage, eventTarget: null });
        value.initialize();
        for (const id of ["a", "preview"]) value.registerScene({ id, name: id, type: "MEDIA" });
        return value;
    };
    const first = state(); first.setPreviewScene("a"); first.take(); first.setPreviewScene("preview");
    const source = { id: "source-a", kind,
        [kind === "audio" ? "audioUrl" : "url"]: "https://example.test/a" };
    const definition = { id: "a", renderer: { kind: "source", sourceId: source.id } };
    const snapshot = { version: 1, revision: 5, publisherSessionId: "previous-control",
        publishedAt: new Date(at).toISOString(), committedAt: new Date(at).toISOString(),
        scene: { id: "a", name: "a", type: "MEDIA" }, source,
        playback: { initialTime: 37, duration: 120, playing, ended: false,
            state: playing ? "playing" : "paused", startedAt: new Date(at).toISOString() },
        graphics: { items: [] }, overlays: {}, transition: { type: "cut", durationMs: 0 } };
    // Both pages restore only selection. Output transport remains the sole cue store.
    const scheduler = state();
    const returning = state();
    return { snapshot, source, storage, scheduler, returning,
        options: { stateManager: returning, catalog: { getDefinition: () => definition },
            sourceManager: { getSource: () => source }, now: at + 10000 } };
}

for (const kind of ["media", "audio"]) {
    for (const playing of [true, false]) {
        test(`${kind}: Control/Scheduler/Control restores ${playing ? "advancing" : "paused"} retained cue and Preview`, () => {
            const f = fixture(kind, playing);
            const output = new LocalProgramOutputTransport({ storage: f.storage, channelFactory: () => null });
            output.start(); output.publish(f.snapshot);
            const cue = programPlaybackContinuity(output.readRetained(), f.options);
            assert.equal(cue.transportCueTime, playing ? 47 : 37);
            assert.equal(cue.transportInitialPlayback, playing ? "playing" : "paused");
            assert.equal(cue.sourceId, "source-a");
            assert.equal(f.returning.getProgramSceneId(), "a");
            assert.equal(f.returning.getPreviewSceneId(), "preview");
            assert.equal(f.scheduler.getPreviewSceneId(), "preview");
            output.destroy();
        });
    }
}

test("continuity rejects stale/future/invalid snapshots, missing source and changed identity/URL", () => {
    const f = fixture();
    for (const candidate of [null, {}, { ...f.snapshot, revision: 0 },
        { ...f.snapshot, publishedAt: new Date(at - MAX_CONTINUITY_AGE_MS).toISOString() },
        { ...f.snapshot, publishedAt: new Date(at + 20000).toISOString() },
        { ...f.snapshot, source: { ...f.source, id: "other" } },
        { ...f.snapshot, source: { ...f.source, url: "https://example.test/replaced" } },
        { ...f.snapshot, scene: { ...f.snapshot.scene, id: "preview" } }]) {
        assert.equal(programPlaybackContinuity(candidate, f.options), null);
    }
    assert.equal(programPlaybackContinuity(f.snapshot, { ...f.options,
        sourceManager: { getSource: () => null } }), null);
    assert.equal(programPlaybackContinuity(f.snapshot, { ...f.options,
        catalog: { getDefinition: () => null } }), null);
});

test("elapsed playback at end restores ended and paused, never restarts", () => {
    const f = fixture();
    const cue = programPlaybackContinuity(f.snapshot, { ...f.options, now: at + 200000 });
    assert.equal(cue.transportCueTime, 120);
    assert.equal(cue.transportInitialEnded, true);
    assert.equal(cue.transportInitialPlayback, "paused");
});

test("network continuity reads existing retained SSE and closes without publishing", async () => {
    const stream = new EventTarget(); let closes = 0;
    stream.close = () => closes++;
    const transport = new NetworkProgramOutputTransport({ role: "publisher",
        subscribeUrl: "http://example.test/events", eventSourceFactory: () => stream });
    const pending = transport.readRetained();
    stream.dispatchEvent(new MessageEvent("program", { data: "invalid" }));
    const snapshot = fixture().snapshot;
    stream.dispatchEvent(new MessageEvent("program", { data: JSON.stringify(createProgramOutputEnvelope(snapshot)) }));
    assert.deepEqual(await pending, snapshot);
    assert.equal(closes, 1);
    assert.equal(transport.started, false);
    assert.equal(transport.latestEnvelope, null);
});

test("network continuity bounds missing retained state and handles unavailable SSE", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const stream = new EventTarget(); let closes = 0; stream.close = () => closes++;
    const transport = new NetworkProgramOutputTransport({ role: "publisher",
        subscribeUrl: "http://example.test/events", eventSourceFactory: () => stream });
    const pending = transport.readRetained(); context.mock.timers.tick(2000);
    assert.equal(await pending, null); assert.equal(closes, 1);
    const failed = transport.readRetained(); stream.dispatchEvent(new Event("error"));
    assert.equal(await failed, null); assert.equal(closes, 2);
});

test("renderer consumes continuity once; later TAKE cannot reuse navigation cue", () => {
    const f = fixture();
    const cue = programPlaybackContinuity(f.snapshot, f.options);
    const renderer = new StudioRenderer({ studioStateManager: f.returning, initialProgramContext: cue });
    const renders = [];
    renderer.renderSlot = (...args) => renders.push(args);
    renderer.discardPreparedProgram = renderer.cancelProgramTransition = () => {};
    renderer.renderProgramFromState(); renderer.renderProgramFromState({ source: "operator" });
    assert.equal(renders[0][2], cue); assert.equal(renders[1][2], null);
    assert.equal(f.returning.getPreviewSceneId(), "preview");
});

for (const kind of ["media", "audio"]) {
    test(`${kind}: renderer passes retained cue, waits for readiness and preserves paused startup`, async () => {
        const previousDocument = globalThis.document;
        globalThis.document = { createElement: () => ({}) };
        try {
            for (const playing of [true, false]) {
                const f = fixture(kind, playing);
                const cue = programPlaybackContinuity(f.snapshot, f.options);
                let options; let activations = 0; let ready;
                const renderer = new StudioRenderer({ studioStateManager: f.returning,
                    definitionRegistry: f.options.catalog, studioSourceManager: {
                        createInstance(_id, value) { options = value; return {
                            async start() {}, waitUntilReady: () => new Promise(resolve => { ready = resolve; }),
                            activateProgram: () => { activations++; }
                        }; }
                    } });
                renderer.program.baseRoot = { replaceChildren() {} };
                renderer.setSlotRenderer = (slot, surface) => { slot.renderer = surface; };
                const pending = renderer.renderSlot(renderer.program, "a", cue);
                await Promise.resolve();
                assert.equal(activations, 0);
                assert.equal(options.initialTime, playing ? 47 : 37);
                assert.equal(options.initialPlayback, playing ? "playing" : "paused");
                ready(); await pending;
                assert.equal(activations, playing ? 1 : 0);
            }
        } finally { globalThis.document = previousDocument; }
    });
}

test("paused continuity publishes paused startup; ordinary TAKE still waits for playing", () => {
    const f = fixture("media", false); const published = [];
    const cue = programPlaybackContinuity(f.snapshot, f.options);
    const playback = { sourceId: f.source.id, state: "paused", currentTime: 37, duration: 120, ended: false };
    const manager = new ProgramOutputManager({ ...f.options, initialProgramContext: cue,
        renderer: { subscribeProgramTransport: listener => { listener(playback); return () => {}; },
            getProgramTransport: () => playback },
        graphicsManager: { subscribe: () => () => {}, getVisibleGraphics: () => [] },
        transitionCoordinator: { getSnapshot: () => ({ state: "idle" }) },
        transport: { start() {}, destroy() {}, publish: value => published.push(value) }, now: () => at + 10000 });
    manager.start();
    assert.equal(published.length, 1); assert.equal(published[0].playback.initialTime, 37);
    assert.equal(published[0].playback.playing, false);
    manager.handleProgramChanged(); assert.equal(published.length, 1);
    manager.destroy();
});


for (const kind of ['media','audio']) {
 test(kind + ': hidden browser pause cannot replace retained playing timeline', t => {
  const oldDocument=globalThis.document;t.after(()=>{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;});
  globalThis.document={visibilityState:'visible'};
  const f=fixture(kind),published=[];
  const playing={sourceId:f.source.id,state:'playing',currentTime:37,duration:120,ended:false};
  const manager=new ProgramOutputManager({...f.options,renderer:{subscribeProgramTransport:fn=>{fn(playing);return()=>{};},getProgramTransport:()=>playing},
   graphicsManager:{subscribe:()=>()=>{},getVisibleGraphics:()=>[]},transitionCoordinator:{getSnapshot:()=>({state:'idle'})},
   transport:{start(){},destroy(){},publish:s=>published.push(s)},now:()=>at});
  t.after(()=>manager.destroy());manager.start();assert.equal(published.length,1);
  globalThis.document.visibilityState='hidden';manager.handleProgramTransport({...playing,state:'paused',currentTime:40});
  assert.equal(published.length,1);assert.equal(manager.programTransport.state,'playing');
  manager.handleGraphicsChanged();assert.equal(published.at(-1).playback.playing,true);
  const restored=programPlaybackContinuity(published.at(-1),{...f.options,now:at+20000});
  assert.equal(restored.transportCueTime,57);assert.equal(restored.transportInitialPlayback,'playing');
  assert.equal(f.returning.getPreviewSceneId(),'preview');
  globalThis.document.visibilityState='visible';manager.handleProgramTransport({...playing,state:'paused',currentTime:58});
  assert.equal(published.at(-1).playback.playing,false);
  const paused=programPlaybackContinuity(published.at(-1),{...f.options,now:at+30000});assert.equal(paused.transportCueTime,58);
 });
}

for (const kind of ['media','audio']) for (const playing of [true,false,null]) {
 test(kind + ': actual surface resumes projected navigation cue, playing=' + playing, async t => {
  const {default:Media}=await import('../public/js/studio/renderers/StudioMediaSurface.js');
  const {default:Audio}=await import('../public/js/studio/renderers/StudioAudioSurface.js');
  class Element extends EventTarget {
   constructor(){super();this.paused=true;this.currentTime=0;this.duration=120;this.readyState=4;this.seeking=false;this.ended=false;this.seekable={length:1,start:()=>0,end:()=>120};this.children=[];this.playCalls=0;}
   replaceChildren(...x){this.children=x;} appendChild(x){this.children.push(x);} setAttribute(){} removeAttribute(){} remove(){} load(){}
   pause(){this.paused=true;}
   play(){this.playCalls++;this.paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve();}
  }
  const previous=globalThis.document;t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  globalThis.document={createElement:()=>new Element()};
  const f=fixture(kind,playing!==false);const cue=programPlaybackContinuity(playing===null?null:f.snapshot,{...f.options,now:at+20000});let surface;
  const renderer=new StudioRenderer({studioStateManager:f.returning,definitionRegistry:f.options.catalog,studioSourceManager:{
   createInstance(id,options){surface=kind==='media'?new Media({sourceId:id,sourceUrl:f.source.url,...options}):new Audio({sourceId:id,audioUrl:f.source.audioUrl,...options});return surface;},destroyInstance(){return true;}
  }});
  renderer.program.baseRoot=new Element();
  const pending=renderer.renderSlot(renderer.program,'a',cue);await Promise.resolve();
  const element=surface.video||surface.audio;
  element.dispatchEvent(new Event('loadedmetadata'));element.dispatchEvent(new Event('seeked'));element.dispatchEvent(new Event('loadeddata'));element.dispatchEvent(new Event('canplay'));
  await pending;await Promise.resolve();
  const expected=playing===null?0:playing?57:37;assert.equal(element.currentTime,expected);assert.equal(element.paused,playing===false);
  if(!element.paused)element.currentTime+=1;
  assert.equal(surface.getTransport().currentTime,expected+(playing===false?0:1));assert.equal(element.playCalls>0,playing!==false);
  assert.equal(f.returning.getPreviewSceneId(),'preview');surface.destroy();
 });
}


test('delayed retained response remains authoritative before renderer bootstrap', async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const stream=new EventTarget();stream.close=()=>{};
 const transport=new NetworkProgramOutputTransport({role:'publisher',subscribeUrl:'http://example.test/events',eventSourceFactory:()=>stream});
 const pending=transport.readRetained();t.mock.timers.tick(1500);
 const f=fixture();stream.dispatchEvent(new MessageEvent('program',{data:JSON.stringify(createProgramOutputEnvelope(f.snapshot))}));
 assert.equal(programPlaybackContinuity(await pending,f.options).transportCueTime,47);
});
