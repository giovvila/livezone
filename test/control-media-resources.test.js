import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {ControlMediaResources} from '../public/js/studio/ControlMediaResources.js';
import resources from '../public/js/studio/ControlMediaResources.js';
import StudioMediaSurface from '../public/js/studio/renderers/StudioMediaSurface.js';
import StudioAudioSurface from '../public/js/studio/renderers/StudioAudioSurface.js';
import StudioHlsSurface from '../public/js/studio/renderers/StudioHlsSurface.js';
import LiveSourceMonitor from '../public/js/studio/LiveSourceMonitor.js';

function fixture(t,options={}){
 const dom=new JSDOM('<div id="root"></div>');t.after(()=>dom.window.close());
 const registry=new ControlMediaResources({enabled:true,...options});
 const surface={consumer:'preview',sourceId:'media-b',readinessState:'pending'};
 const video=dom.window.document.createElement('video');
 video.src='https://secret.invalid/video?token=PRIVATE';
 registry.watch(surface,video,'video');
 return {dom,registry,surface,video};
}
test('inventory sees detached preparation, transferred owner and no URLs',t=>{
 const {dom,registry,surface,video}=fixture(t);
 let item=registry.snapshot(dom.window.document).resources[0];
 assert.equal(item.connected,false);assert.equal(item.srcAssigned,true);assert.equal(item.owner,'preview');
 surface.consumer='program';dom.window.document.body.append(video);
 item=registry.snapshot(dom.window.document).resources[0];assert.equal(item.owner,'program');assert.equal(item.connected,true);
 assert.equal(registry.snapshot(dom.window.document).counts.video,1);
 assert.doesNotMatch(registry.exportJSON(),/secret|PRIVATE|https|token=/);
});
test('release records residual assigned source until cleanup, without retaining player strongly',t=>{
 const {dom,registry,surface,video}=fixture(t);
 registry.releaseSurface(surface);
 assert.equal(registry.snapshot(dom.window.document).counts.cleanupPending,1);
 video.removeAttribute('src');video.remove();
 assert.equal(registry.snapshot(dom.window.document).counts.video,0);
 assert.equal(registry.released.video,1);registry.releaseSurface(surface);assert.equal(registry.released.video,1);
 assert.ok([...registry.rows.values()][0].surface instanceof WeakRef);
});
test('diagnostic storage is bounded, overflow is explicit, events stop after release',t=>{
 const {dom,registry,surface,video}=fixture(t,{capacity:2,eventCapacity:4});
 for(let i=0;i<10;i++)video.dispatchEvent(new dom.window.Event('canplay'));
 assert.equal(registry.events.length,4);
 const others=[];for(let i=0;i<5;i++){const element=dom.window.document.createElement('audio');others.push(element);registry.watch(surface,element,'audio');}
 assert.equal(registry.rows.size,2);assert.equal(registry.snapshot(dom.window.document).truncated,true);
 registry.releaseElement(video);const last=registry.events.at(-1);video.dispatchEvent(new dom.window.Event('canplay'));
 assert.equal(registry.events.at(-1),last);
});
test('HLS identity is counted once and motion artwork is a separate element',t=>{
 const {dom,registry,surface,video}=fixture(t);surface.hls={};
 const motion=dom.window.document.createElement('video');registry.watch(surface,motion,'motion-artwork');
 const audio=dom.window.document.createElement('audio');registry.watch(surface,audio,'audio');
 assert.deepEqual(registry.snapshot(dom.window.document).counts,{video:2,audio:1,hls:1,cleanupPending:0});
 surface.hls=null;surface.destroyed=true;video.removeAttribute('src');registry.releaseSurface(surface);
 assert.equal(registry.snapshot(dom.window.document).counts.hls,0);
});
test('disabled diagnostics attach no listeners and issue no media commands',t=>{
 const {dom}=fixture(t);const registry=new ControlMediaResources();
 const video=dom.window.document.createElement('video');video.addEventListener=()=>assert.fail('disabled listener');
 video.play=video.pause=video.load=()=>assert.fail('media command');registry.watch({},video,'video');
 assert.equal(registry.rows.size,0);
});

for(const [kind,Surface] of [['video',StudioMediaSurface],['audio',StudioAudioSurface],['hls',StudioHlsSurface]]){
 test('production '+kind+' hooks observe creation and complete source cleanup',async t=>{
  const dom=new JSDOM('<div id="root"></div>');const previous=globalThis.document,enabled=resources.enabled;
  globalThis.document=dom.window.document;resources.enabled=true;resources.rows.clear();
  const proto=dom.window.HTMLMediaElement.prototype;proto.pause=()=>{};proto.load=()=>{};proto.play=()=>Promise.resolve();proto.canPlayType=()=> 'probably';
  const surface=new Surface({sourceId:'heavy',sourceUrl:'http://fixture.test/video',audioUrl:'http://fixture.test/audio',consumer:'program',initialPlayback:'paused'});
  t.after(()=>{surface.destroy();resources.enabled=enabled;resources.rows.clear();globalThis.document=previous;dom.window.close();});
  await surface.start(document.querySelector('#root'));
  const before=resources.snapshot(document);assert.equal(before.counts.video+before.counts.audio,1);
  assert.equal(before.resources[0].srcAssigned,true);
  surface.destroy();const after=resources.snapshot(document);
  assert.equal(after.counts.video+after.counts.audio,0);assert.equal(after.counts.cleanupPending,0);
  assert.equal(after.resources[0].srcAssigned,false);assert.equal(after.resources[0].released,true);
 });
}
test('Technical no-signal attempts own one HLS and release it before retry beside long audio',async t=>{
 const dom=new JSDOM('<div id="audio"></div><div id="technical"></div>');
 const previous={document:globalThis.document,Hls:globalThis.Hls,enabled:resources.enabled};
 globalThis.document=dom.window.document;resources.enabled=true;resources.rows.clear();
 const proto=dom.window.HTMLMediaElement.prototype;proto.pause=()=>{};proto.load=()=>{};proto.play=()=>Promise.resolve();proto.canPlayType=()=>'';
 let active=0,peak=0;
 globalThis.Hls=class {static isSupported(){return true;}static Events={MANIFEST_PARSED:'manifest',ERROR:'error'};
  constructor(){active++;peak=Math.max(peak,active);}on(){}loadSource(){}attachMedia(){}destroy(){active--;}};
 const audio=new StudioAudioSurface({sourceId:'audio-12',audioUrl:'http://fixture.test/audio',consumer:'program',initialPlayback:'paused'});
 const timers=new Map();let id=0;
 const monitor=new LiveSourceMonitor({maxRetryDelayMs:30000,setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimer:key=>timers.delete(key),
  consumerFactory:source=>{const surface=new StudioHlsSurface({sourceId:source.id,sourceUrl:source.url,consumer:'technical'});
   return {start:()=>surface.start(document.querySelector('#technical')),destroy:()=>surface.destroy()};}});
 t.after(()=>{monitor.destroy();audio.destroy();resources.enabled=previous.enabled;resources.rows.clear();globalThis.document=previous.document;globalThis.Hls=previous.Hls;dom.window.close();});
 await audio.start(document.querySelector('#audio'));
 monitor.selectSource({id:'technical',kind:'hls',url:'http://fixture.test/no-signal.m3u8'});
 assert.deepEqual(resources.snapshot(document).counts,{video:1,audio:1,hls:1,cleanupPending:0});
 const fire=ms=>{const entry=[...timers].find(([,timer])=>timer.ms===ms);assert.ok(entry);timers.delete(entry[0]);entry[1].fn();};
 for(let attempt=0;attempt<3;attempt++){
  fire(12000);assert.equal(active,0);assert.equal(resources.snapshot(document).counts.video,0);
  assert.equal(audio.destroyed,false);fire([5000,5000,10000][attempt]);assert.equal(active,1);
 }
 assert.equal(peak,1);monitor.destroy();assert.equal(active,0);
});
