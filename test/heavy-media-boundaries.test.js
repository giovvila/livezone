import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {JSDOM} from 'jsdom';
import MediaLibraryRoutes from '../server/media-library/MediaLibraryRoutes.js';
import PublicProgramController from '../public/js/public/PublicProgramController.js';
import {expectedPlaybackTime,validateProgramOutputSnapshot} from '../public/js/program-output/ProgramOutputContract.js';

for(const [kind,mime] of [['video','video/mp4'],['audio','audio/mpeg']]){
 test('production managed '+kind+' serves independent simultaneous ranges',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lz-heavy-boundary-'));
  assert.ok(resolve(root).startsWith(resolve(tmpdir())));
  const path=join(root,'fixture');const bytes=Buffer.alloc(4*1024*1024);
  bytes.fill(0x31,0,1024*1024);bytes.fill(0x72,3*1024*1024);
  await writeFile(path,bytes);
  const routes=new MediaLibraryRoutes({repository:{safeFilePath:()=>path,list:()=>[{storedName:'fixture',mimeType:mime}]}});
  const server=createServer((req,res)=>void routes.serveFile(req,res,kind,'fixture'));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+server.address().port+'/fixture';
  const ranges=[[0,65535],[bytes.length-65536,bytes.length-1]];
  await Promise.all(ranges.map(async([start,end])=>{
   const response=await fetch(url,{headers:{Range:`bytes=${start}-${end}`},signal:AbortSignal.timeout(5000)});
   assert.equal(response.status,206);assert.equal(response.headers.get('accept-ranges'),'bytes');
   assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${bytes.length}`);
   assert.equal(response.headers.get('content-length'),String(end-start+1));assert.equal(response.headers.get('content-type'),mime);
   assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(start,end+1));
  }));
  for(const range of [`bytes=${bytes.length-32}-`,'bytes=-32']){
   const response=await fetch(url,{headers:{Range:range}});assert.equal(response.status,206);
   assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(-32));
  }
  const head=await fetch(url,{method:'HEAD',headers:{Range:'bytes=0-99'}});
  assert.equal(head.status,206);assert.equal(head.headers.get('content-length'),'100');assert.equal((await head.arrayBuffer()).byteLength,0);
  const invalid=await fetch(url,{headers:{Range:`bytes=${bytes.length}-`}});assert.equal(invalid.status,416);await invalid.arrayBuffer();
 });
}
test('Range parser preserves byte offsets beyond signed 32 bits',()=>{
 const routes=new MediaLibraryRoutes();
 assert.deepEqual(routes.parseRange('bytes=4294967296-',5368709120),{start:4294967296,end:5368709119});
 assert.deepEqual(routes.parseRange('bytes=-65536',5368709120),{start:5368643584,end:5368709119});
});

function snapshot(kind,{initialTime=0,playing=true}={}){
 const at='2026-09-14T00:00:00.000Z';
 return {version:1,revision:1,publisherSessionId:'heavy-fixture',publishedAt:at,committedAt:at,
  scene:{id:kind,name:kind,type:'MEDIA'},source:kind==='audio'?{id:kind,kind,audioUrl:'http://fixture.test/audio.mp3'}:{id:kind,kind,url:'http://fixture.test/video.mp4'},
  playback:{initialTime,duration:43200,playing,ended:false,state:playing?'playing':'paused',startedAt:at},
  graphics:{items:[]},transition:{type:'cut',durationMs:0}};
}
for(const kind of ['media','audio'])for(const initialTime of [0,36000])for(const playing of [true,false]){
 test(`${kind} preparation: cue ${initialTime}, ${playing?'playing':'paused'}, empty buffered/seekable`,async t=>{
  const dom=new JSDOM('<div id="root"></div>');const previous=globalThis.document;globalThis.document=dom.window.document;
  t.after(()=>{globalThis.document=previous;dom.window.close();});
  const proto=dom.window.HTMLMediaElement.prototype;let plays=0,seeks=0,mediaCreated=0;
  Object.defineProperty(proto,'readyState',{get(){return this.state||0;}});
  Object.defineProperty(proto,'duration',{get:()=>43200});
  Object.defineProperty(proto,'buffered',{get:()=>({length:0})});Object.defineProperty(proto,'seekable',{get:()=>({length:0})});
  Object.defineProperty(proto,'currentTime',{get(){return this.time||0;},set(value){seeks++;this.time=value;queueMicrotask(()=>this.dispatchEvent(new dom.window.Event('seeked')));}});
  proto.load=function(){if(!this.getAttribute('src'))return;queueMicrotask(()=>{this.state=1;this.dispatchEvent(new dom.window.Event('loadedmetadata'));this.state=2;this.dispatchEvent(new dom.window.Event('loadeddata'));});};
  proto.play=()=>{plays++;return new Promise(()=>{});};proto.pause=()=>{};
  const create=dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement=(name,...args)=>{if(['video','audio'].includes(name))mediaCreated++;return create(name,...args);};
  const value=snapshot(kind,{initialTime,playing});const before=structuredClone(value);
  assert.ok(validateProgramOutputSnapshot(value));
  const now=Date.parse(value.playback.startedAt)+120000;
  const controller=new PublicProgramController({now:()=>now});
  const root=document.querySelector('#root');const abort=new AbortController();
  const cleanup=await controller.createSource(root,value,{signal:abort.signal});t.after(cleanup);
  const media=root.querySelector('audio,video');
  assert.equal(media.currentTime,initialTime+(playing?120:0));assert.equal(mediaCreated,1);
  assert.equal(seeks,initialTime||playing?1:0);assert.equal(plays,playing?1:0);
  assert.deepEqual(value,before,'preparation does not mutate retained Program');
 });
}
test('long cue arithmetic uses seconds, clamps end, keeps paused cue and rejects invalid duration',()=>{
 const value=snapshot('audio',{initialTime:36000});
 assert.equal(expectedPlaybackTime(value,Date.parse(value.playback.startedAt)+3600000),39600);
 assert.equal(expectedPlaybackTime(value,Date.parse(value.playback.startedAt)+86400000),43200);
 assert.equal(expectedPlaybackTime({...value,playback:{...value.playback,playing:false}},Date.parse(value.playback.startedAt)+86400000),36000);
 for(const duration of [NaN,Infinity,-1])assert.equal(validateProgramOutputSnapshot({...value,playback:{...value.playback,duration}}),null);
});
