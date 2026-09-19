import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {StudioStateManager} from '../public/js/core/StudioStateManager.js';
import {restoreRetainedProgramIdentity,programPlaybackContinuity} from '../public/js/studio/ProgramPlaybackContinuity.js';
import ProgramOutputStore from '../server/program-output/ProgramOutputStore.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
import ProgramOutputManager from '../public/js/program-output/ProgramOutputManager.js';
import SchedulerEngine from '../public/js/scheduler/SchedulerEngine.js';
import AutoLiveEntryController from '../public/js/studio/AutoLiveEntryController.js';
const at=Date.parse('2026-09-12T20:00:00Z');
function fixture(kind='media',playing=true){
 const scenes=[{id:'video',name:'VIDEO A',type:'MEDIA'},{id:'live',name:'LIVE',type:'LIVE'},{id:'break',name:'BREAK',type:'SLATE'}];
 const sources=[{id:'recorded',kind,[kind==='audio'?'audioUrl':'url']:'https://example.test/recorded.mp4'},
 {id:'live-source',kind:'hls',enabled:true,name:'Authorized LIVE',sceneIds:['live'],url:'https://example.test/live.m3u8'}];
 const definitions=new Map(scenes.map(scene=>[scene.id,{...scene,renderer:scene.id==='break'?{kind:'slate',title:'BREAK',message:'Break',logo:'https://example.test/logo.svg'}:{kind:'source',sourceId:scene.id==='live'?'live-source':'recorded'}}]));
 const values=new Map();const storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const newState=()=>{const state=new StudioStateManager({storage,eventTarget:null});state.initialize();scenes.forEach(scene=>state.registerScene(scene));return state;};
 const catalog={getDefinition:id=>definitions.get(id),getSources:()=>sources,subscribe:fn=>{fn();return()=>{};}};
 const sourceManager={getSource:id=>sources.find(s=>s.id===id)};
 const snapshot={version:1,publisherSessionId:'control-before',revision:5,publishedAt:new Date(at).toISOString(),committedAt:new Date(at).toISOString(),scene:scenes[0],source:sources[0],
 playback:{initialTime:30,duration:300,playing,ended:false,state:playing?'playing':'paused',startedAt:new Date(at).toISOString()},graphics:{items:[]},transition:{type:'cut',durationMs:0}};
 const staleState=()=>{storage.setItem('livezone.studio.selection.v1',JSON.stringify({version:1,programSceneId:'live',previewSceneId:'break'}));return newState();};
 return {scenes,sources,snapshot,newState,staleState,catalog,sourceManager,options:stateManager=>({stateManager,catalog,sourceManager,now:at+20000})};
}
for(const kind of ['media','audio'])for(const playing of [true,false])test(kind+' retained identity precedes cue projection; playing='+playing,()=>{
 const f=fixture(kind,playing),state=f.staleState();assert.equal(programPlaybackContinuity(f.snapshot,f.options(state)),null);
 assert.equal(restoreRetainedProgramIdentity(f.snapshot,f.options(state)),true);
 assert.equal(state.getProgramSceneId(),'video');assert.equal(state.getPreviewSceneId(),'break');
 const cue=programPlaybackContinuity(f.snapshot,f.options(state));assert.equal(cue.sourceId,'recorded');assert.equal(cue.transportCueTime,playing?50:30);assert.equal(cue.transportInitialPlayback,playing?'playing':'paused');
 assert.equal(f.newState().getProgramSceneId(),'video');
});

test('armed waiting AutoLive and suspended Scheduler never publish LIVE on leave or return',t=>{
 const f=fixture(),state=f.newState();state.setProgramScene('video');state.setPreviewScene('break');let commands=0;
 const command={stateManager:state,execute(){commands++;},release(){commands++;}};
 const scheduler=new SchedulerEngine({programExecution:false,command,catalog:f.catalog});scheduler.start();
 const monitor={selectSource(){},stop(){},destroy(){},subscribe(fn){fn({sourceId:'live-source',state:'OFFLINE'});return()=>{};}};
 const config={getSnapshot:()=>({armed:true,authorizedSourceId:'live-source'}),subscribe(fn){fn();return()=>{};}};
 const controller=new AutoLiveEntryController({config,catalog:f.catalog,monitor,scheduler,command,renderer:{}});
 controller.start();assert.equal(controller.getSnapshot().armed,true);assert.equal(controller.getSnapshot().session,null);
 const store=new ProgramOutputStore(),history=[];store.subscribe(e=>history.push(e.snapshot.source.kind));
 const transport={start(){},destroy(){},publish:s=>store.accept(createProgramOutputEnvelope(s))};
 const playback={sourceId:'recorded',state:'playing',currentTime:30,duration:300,ended:false};
 const publisher=new ProgramOutputManager({stateManager:state,catalog:f.catalog,sourceManager:f.sourceManager,renderer:{subscribeProgramTransport:fn=>{fn(playback);return()=>{};}},
 graphicsManager:{subscribe:()=>()=>{},getVisibleGraphics:()=>[]},transitionCoordinator:{getSnapshot:()=>({state:'idle'})},transport,now:()=>at});
 publisher.start();controller.destroy();publisher.destroy();
 const returning=f.staleState();assert.equal(restoreRetainedProgramIdentity(store.getCurrent().snapshot,f.options(returning)),true);
 assert.equal(returning.getProgramSceneId(),'video');assert.equal(returning.getPreviewSceneId(),'break');assert.deepEqual(history,['media']);assert.equal(commands,0);
 scheduler.destroy();t.after(()=>controller.destroy());
});

test('retained LIVE identity is preserved without manufacturing AutoLive ownership',()=>{
 const f=fixture(),state=f.newState();state.setProgramScene('video');state.setPreviewScene('break');
 const live={...f.snapshot,scene:f.scenes[1],source:f.sources[1]};
 assert.equal(restoreRetainedProgramIdentity(live,f.options(state)),true);assert.equal(state.getProgramSceneId(),'live');assert.equal(state.getPreviewSceneId(),'break');
 assert.equal(programPlaybackContinuity(live,f.options(state)),null);
});

test('missing retained keeps canonical Studio selection; no authorized LIVE fallback',()=>{
 const f=fixture(),state=f.newState();state.setProgramScene('video');state.setPreviewScene('break');
 const restarted=new ProgramOutputStore();assert.equal(restarted.getCurrent(),null);
 assert.equal(restoreRetainedProgramIdentity(null,f.options(state)),false);assert.equal(state.getProgramSceneId(),'video');assert.equal(state.getPreviewSceneId(),'break');
});

test('retained empty clears only Program; BREAK Preview does not become Program',()=>{
 const f=fixture(),state=f.staleState();assert.equal(restoreRetainedProgramIdentity({...f.snapshot,scene:null,source:null},f.options(state)),true);
 assert.equal(state.getProgramSceneId(),null);assert.equal(state.getPreviewSceneId(),'break');
});

test('missing or mismatched registered source rejects retained identity before selection',()=>{
 const f=fixture(),state=f.staleState();
 assert.equal(restoreRetainedProgramIdentity({...f.snapshot,source:{...f.sources[0],id:'different'}},f.options(state)),false);
 assert.equal(restoreRetainedProgramIdentity({...f.snapshot,scene:{...f.scenes[0],id:'missing'}},f.options(state)),false);
 assert.equal(restoreRetainedProgramIdentity({...f.snapshot,publishedAt:new Date(at-7*3600000).toISOString()},f.options(state)),false);
 assert.equal(state.getProgramSceneId(),'live');assert.equal(state.getPreviewSceneId(),'break');
});

test('stale LIVE revision cannot replace newer retained VIDEO during bootstrap',()=>{
 const f=fixture(),state=f.staleState(),store=new ProgramOutputStore();
 const live={...f.snapshot,revision:4,scene:f.scenes[1],source:f.sources[1]};
 assert.equal(store.accept(createProgramOutputEnvelope(live)).accepted,true);
 assert.equal(store.accept(createProgramOutputEnvelope(f.snapshot)).accepted,true);
 assert.equal(store.accept(createProgramOutputEnvelope(live)).accepted,false);
 assert.equal(restoreRetainedProgramIdentity(store.getCurrent().snapshot,f.options(state)),true);assert.equal(state.getProgramSceneId(),'video');
});

test('production Control selects retained identity before cue and renderer startup',async()=>{
 const entry=await readFile(new URL('../public/js/entries/control-room-app.js',import.meta.url),'utf8');
 const read=entry.indexOf('await programOutputTransport.readRetained()');const restore=entry.indexOf('restoreRetainedProgramIdentity(retainedProgram');
 assert.ok(read<restore);assert.ok(restore<entry.indexOf('programPlaybackContinuity(retainedProgram'));assert.ok(restore<entry.indexOf('studioRenderer = new StudioRenderer'));
 assert.match(entry,/programExecution: false/);
});


test('A5 Control passes retained bootstrap resolution into AutoLive before controller start',async()=>{
 const entry=await readFile(new URL('../public/js/entries/control-room-app.js',import.meta.url),'utf8');
 const read=entry.indexOf('let retainedProgram = await programOutputTransport.readRetained()');
 const resolved=entry.indexOf('let retainedProgramIdentityResolved = restoreRetainedProgramIdentity(retainedProgram');
 const ctor=entry.indexOf('dominantLiveController = new AutoLiveEntryController({');
 const resolvedArg=entry.indexOf('retainedProgramIdentityResolved,',ctor);
 const retainedArg=entry.indexOf('retainedProgram,',ctor);
 const start=entry.indexOf('dominantLiveController.start()',ctor);
 assert.ok(read>=0&&read<resolved&&resolved<ctor&&ctor<resolvedArg&&resolvedArg<retainedArg&&retainedArg<start);
});


test('A5 Control retries retained Program read once before declaring it absent',async()=>{
 const entry=await readFile(new URL('../public/js/entries/control-room-app.js',import.meta.url),'utf8');
 const first=entry.indexOf('let retainedProgram = await programOutputTransport.readRetained()');
 const firstRestore=entry.indexOf('let retainedProgramIdentityResolved = restoreRetainedProgramIdentity(retainedProgram');
 const retry=entry.indexOf('await programOutputTransport.readRetained({ timeoutMs: 4000 })');
 const unresolved=entry.indexOf('if (!retainedProgramIdentityResolved)',firstRestore);
 assert.ok(first>=0&&first<firstRestore&&firstRestore<unresolved&&unresolved<retry);
});


test('A5 Control retries a present but unresolved retained snapshot before AutoLive evaluation',async()=>{
 const entry=await readFile(new URL('../public/js/entries/control-room-app.js',import.meta.url),'utf8');
 const unresolved=entry.indexOf('if (!retainedProgramIdentityResolved)');
 const retry=entry.indexOf('await programOutputTransport.readRetained({ timeoutMs: 4000 })',unresolved);
 const assign=entry.indexOf('retainedProgram = retry',retry);
 const resolveAgain=entry.indexOf('retainedProgramIdentityResolved = restoreRetainedProgramIdentity(retainedProgram',assign);
 const ctor=entry.indexOf('dominantLiveController = new AutoLiveEntryController({');
 assert.ok(unresolved>=0&&unresolved<retry&&retry<assign&&assign<resolveAgain&&resolveAgain<ctor);
});
