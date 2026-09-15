import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import PublicProgramController from '../public/js/public/PublicProgramController.js';
import StudioMediaSurface from '../public/js/studio/renderers/StudioMediaSurface.js';
import trace from '../public/js/core/RuntimeTrace.js';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(t,{duration=6914,cue=3600,timeout=1000}={}){
 const dom=new JSDOM('<div id="control"></div><div id="public"><div data-public-base></div><div data-public-graphics></div></div>');
 const previous=globalThis.document;globalThis.document=dom.window.document;
 const log=[],proto=dom.window.HTMLMediaElement.prototype;
 Object.defineProperty(proto,'readyState',{get(){return this.state||0;}});
 Object.defineProperty(proto,'duration',{get:()=>duration});
 Object.defineProperty(proto,'currentTime',{get(){return this.time||0;},set(value){this.time=value;log.push('seek-request');this.dispatchEvent(new dom.window.Event('seeking'));queueMicrotask(()=>{this.dispatchEvent(new dom.window.Event('seeked'));if(this.readyAfterSeek){this.state=2;this.dispatchEvent(new dom.window.Event('loadeddata'));}});}});
 proto.load=()=>{};proto.pause=()=>{};proto.play=function(){log.push('play-request');this.dispatchEvent(new dom.window.Event('playing'));return Promise.resolve();};
 const at='2026-09-14T00:00:00.000Z';
 const snapshot={version:1,revision:1,publisherSessionId:'mp4-order',publishedAt:at,committedAt:at,
  scene:{id:'media',name:'MEDIA',type:'MEDIA'},source:{id:'media',kind:'media',url:'http://fixture.test/media/demo2.mp4'},
  playback:{initialTime:cue,duration,playing:true,ended:false,state:'playing',startedAt:at},
  graphics:{items:[]},transition:{type:'cut',durationMs:0}};
 const controller=new PublicProgramController({root:document.querySelector('#public'),transport:{destroy(){}},now:()=>Date.parse(at)});
 const wait=controller.waitForReady.bind(controller);controller.waitForReady=(element,events,_ms,signal)=>wait(element,events,timeout,signal);
 const abort=new AbortController();
 t.after(()=>{abort.abort();controller.destroy();globalThis.document=previous;dom.window.close();});
 const emit=(element,type,state)=>{if(state!==undefined)element.state=state;log.push(type);element.dispatchEvent(new dom.window.Event(type));};
 return {dom,log,snapshot,controller,abort,emit,root:document.querySelector('[data-public-base]')};
}
for(const [name,duration,cue] of [['small',34,10],['large',6914,3600]])test(name+' current Public path waits for decoded data before projected seek',async t=>{
 const h=fixture(t,{duration,cue});const original=structuredClone(h.snapshot);
 const pending=h.controller.createSource(h.root,h.snapshot,{signal:h.abort.signal});
 const video=h.root.querySelector('video');assert.equal(video.preload,'auto');
 h.emit(video,'loadstart');h.emit(video,'loadedmetadata',1);h.emit(video,'durationchange');await flush();
 assert.equal(video.currentTime,0);assert.equal(h.log.includes('seek-request'),false);
 h.emit(video,'loadeddata',2);const cleanup=await pending;t.after(cleanup);
 assert.equal(video.currentTime,cue);assert.ok(h.log.indexOf('loadeddata')<h.log.indexOf('seek-request'));
 assert.ok(h.log.indexOf('seek-request')<h.log.indexOf('play-request'));
 assert.deepEqual(h.snapshot,original);
});
test('metadata without decoded data times out and clears the current-path candidate source',async t=>{
 const h=fixture(t,{timeout:30});const pending=h.controller.createSource(h.root,h.snapshot,{signal:h.abort.signal});
 const failed=assert.rejects(pending,/Public source unavailable/);const video=h.root.querySelector('video');
 h.emit(video,'loadedmetadata',1);await failed;
 assert.equal(h.log.includes('seek-request'),false);assert.equal(video.getAttribute('src'),null);
});
for(const cue of [1,3600,6900])test('isolated metadata-first experiment requests cue '+cue+' before initial loadeddata',async t=>{
 const h=fixture(t,{cue});const video=document.createElement('video');h.root.append(video);
 video.preload='metadata';video.autoplay=false;video.readyAfterSeek=true;
 // Experimental ordering only: not a patched production controller. The same
 // production wait/seek primitives are exercised with deterministic media events.
 const metadata=h.controller.waitForReady(video,['loadedmetadata'],1000,h.abort.signal);
 video.src=h.snapshot.source.url;video.load();h.emit(video,'loadedmetadata',1);await metadata;
 const data=h.controller.waitForReady(video,['loadeddata','canplay'],1000,h.abort.signal);
 await h.controller.seekRecordedMedia(video,h.snapshot,1000,h.abort.signal);await data;
 assert.equal(video.currentTime,cue);assert.equal(video.readyState,2);assert.equal(h.log[0],'loadedmetadata');
 assert.equal(h.log[1],'seek-request');assert.equal(h.log.includes('play-request'),false);
 video.preload='auto';await video.play();assert.equal(h.log.at(-1),'play-request');
 video.removeAttribute('src');video.remove();
});
for(const same of [true,false])test('Control plus Public '+(same?'same large MP4':'different small MP4')+' has exactly two independent source elements',async t=>{
 const h=fixture(t);const control=new StudioMediaSurface({consumer:'program',sourceId:'media-b',sourceUrl:h.snapshot.source.url});
 t.after(()=>control.destroy());await control.start(document.querySelector('#control'));
 const primary=control.video,before=h.log.length;
 if(!same)h.snapshot.source={id:'small',kind:'media',url:'http://fixture.test/media/demo.mp4'};
 const pending=h.controller.createSource(h.root,h.snapshot,{signal:h.abort.signal});const secondary=h.root.querySelector('video');
 assert.equal(control.video,primary);assert.notEqual(primary,secondary);assert.equal(h.log.length,before);
 h.emit(secondary,'loadedmetadata',1);h.emit(secondary,'loadeddata',2);const cleanup=await pending;t.after(cleanup);
 assert.equal(document.querySelectorAll('video,audio').length,2);assert.equal(control.video,primary);assert.equal(control.destroyed,false);
 assert.equal(primary.currentTime,0);assert.equal(primary.getAttribute('src'),'http://fixture.test/media/demo2.mp4');
});
test('aborted Public preparation clears source without altering an existing Control element',async t=>{
 const h=fixture(t);const control=document.createElement('video');control.src='http://fixture.test/control.mp4';document.querySelector('#control').append(control);
 const pending=h.controller.createSource(h.root,h.snapshot,{signal:h.abort.signal});const failed=assert.rejects(pending);
 const candidate=h.root.querySelector('video');h.abort.abort();await failed;
 assert.equal(candidate.getAttribute('src'),null);assert.equal(control.getAttribute('src'),'http://fixture.test/control.mp4');
});
test('MP4 diagnostics capture metadata and seek order without URLs and detach on cleanup',async t=>{
 const h=fixture(t);const enabled=trace.enabled;trace.enabled=true;trace.clear();t.after(()=>{trace.enabled=enabled;trace.clear();});
 const pending=h.controller.createSource(h.root,h.snapshot,{signal:h.abort.signal});const video=h.root.querySelector('video');
 Object.defineProperty(video,'buffered',{get:()=>({length:1,start:()=>0,end:()=>111})});
 h.emit(video,'loadedmetadata',1);h.emit(video,'loadeddata',2);const cleanup=await pending;
 const events=trace.snapshot().map(entry=>entry.event);
 assert.ok(events.includes('mp4-element-created'));assert.ok(events.includes('mp4-src-assigned'));
 assert.ok(events.indexOf('player-loadedmetadata')<events.indexOf('mp4-seek-request'));
 assert.ok(events.includes('mp4-buffered'));assert.doesNotMatch(trace.exportJSON(),/https?:|fixture\.test/);
 cleanup();const count=trace.snapshot().length;h.emit(video,'loadedmetadata',1);assert.equal(trace.snapshot().length,count);
});
test('three failed preparation attempts clean their layers and remain in safe waiting state',async t=>{
 const h=fixture(t,{timeout:20});let retries=0;h.controller.scheduleRecovery=()=>{retries++;};h.controller.latestSnapshot=h.snapshot;
 for(let attempt=0;attempt<3;attempt++){
  await h.controller.renderSnapshot(h.snapshot);
  assert.equal(document.querySelectorAll('#public video').length,0);assert.equal(h.controller.pendingRender,null);
  assert.match(h.root.textContent,/UNAVAILABLE/);
 }
 assert.equal(retries,3);
});
