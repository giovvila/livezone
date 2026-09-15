import trace from '../core/RuntimeTrace.js';

const EVENTS=['loadstart','loadedmetadata','loadeddata','canplay','play','playing','pause','seeking','seeked','waiting','stalled','error','emptied','timeupdate'];
const safe=value=>typeof value==='string'&&/^[a-zA-Z0-9_ .-]{1,128}$/.test(value)?value:'unknown';
const finite=value=>Number.isFinite(value)?value:null;
// Read-only diagnostics: no media commands, polling, URL collection or strong
// references to players. Truncation is explicit rather than hiding lost owners.
export class ControlMediaResources {
 constructor({enabled=false,capacity=128,eventCapacity=512,now=()=>Date.now()}={}){
  this.enabled=enabled;this.capacity=Math.min(256,Math.max(1,capacity));
  this.eventCapacity=Math.min(1000,Math.max(1,eventCapacity));this.now=now;
  this.rows=new Map();this.ids=new WeakMap();this.surfaceIds=new WeakMap();this.nextSurfaceId=1;this.events=[];this.nextId=1;this.dropped=0;
  this.created={video:0,audio:0};this.released={video:0,audio:0};
 }
 watch(surface,element,kind){
  if(!this.enabled||!element||typeof WeakRef!=='function')return;
  try{
   if(this.ids.has(element))return;
   for(const [id,row] of this.rows)if(!row.element.deref()||row.released&&!this.describe(row)?.cleanupPending){this.rows.delete(id);if(this.rows.size<this.capacity)break;}
   if(this.rows.size>=this.capacity){this.dropped++;return;}
   if(!this.surfaceIds.has(surface))this.surfaceIds.set(surface,this.nextSurfaceId++);
   const id=this.nextId++,row={id,surfaceId:this.surfaceIds.get(surface),element:new WeakRef(element),surface:new WeakRef(surface),kind:safe(kind),released:false,lastSample:0,progressAt:null,lastTime:null};
   row.listener=event=>{try{
    const media=row.element.deref();if(!media)return;
    const at=this.now();if(event.type==='timeupdate'){
     if(row.lastTime!==null&&media.currentTime>row.lastTime)row.progressAt=at;
     row.lastTime=media.currentTime;if(at-row.lastSample<1000)return;row.lastSample=at;
    }
    this.record(event.type,row);
   }catch{/* Diagnostics never alter playback. */}};
   this.rows.set(id,row);this.ids.set(element,id);
   this.created[element.tagName?.toLowerCase()==='audio'?'audio':'video']++;
   EVENTS.forEach(event=>element.addEventListener(event,row.listener));this.record('created',row);
  }catch{/* Diagnostics never alter playback. */}
 }
 releaseElement(element){
  try{
   const row=this.rows.get(this.ids.get(element));if(!row||row.released)return;
   row.released=true;EVENTS.forEach(event=>element.removeEventListener(event,row.listener));
   this.released[element.tagName?.toLowerCase()==='audio'?'audio':'video']++;
   this.record('released',row);
  }catch{/* Best-effort diagnostics. */}
 }
 releaseSurface(surface){for(const row of this.rows.values())if(row.surface.deref()===surface){const element=row.element.deref();if(element)this.releaseElement(element);}}
 noteSurface(event,surface){if(!this.enabled)return;try{for(const row of this.rows.values())if(!row.released&&row.surface.deref()===surface)this.record(safe(event),row);}catch{}}
 mark(event,sceneId){if(!this.enabled)return;try{this.events.push({at:this.now(),event:safe(event),sceneId:safe(sceneId)});if(this.events.length>this.eventCapacity)this.events.shift();}catch{}}
 owner(surface){try{return safe(this.ownerProvider?.(surface)||surface?.consumer||'unattributed');}catch{return 'unattributed';}}
 describe(row){
  const element=row.element.deref(),surface=row.surface.deref();if(!element)return null;
  const assigned=Boolean(element.getAttribute?.('src')||element.querySelector?.('source[src]'));
  let hidden=!element.isConnected||!!element.hidden;
  // Avoid style/layout reads; this flags structural hiding, not viewport occlusion.
  for(let parent=element.parentElement;parent;parent=parent.parentElement){if(parent.hidden||parent.style?.display==='none'||parent.style?.visibility==='hidden'||parent.style?.opacity==='0')hidden=true;}
  const ranges=property=>{const range=element[property],result=[];try{for(let i=0;i<Math.min(range?.length||0,4);i++)result.push([finite(range.start(i)),finite(range.end(i))]);}catch{}return result;};
  return {id:row.id,surfaceId:row.surfaceId,owner:this.owner(surface),sourceId:safe(surface?.sourceId),kind:row.kind,
   element:element.tagName?.toLowerCase(),connected:!!element.isConnected,hidden,
   paused:element.paused===true,readyState:finite(element.readyState),networkState:finite(element.networkState),
   srcAssigned:assigned,preload:element.preload||'browser-default',currentTime:finite(element.currentTime),duration:finite(element.duration),
   playbackActive:element.paused===false&&!element.ended&&element.readyState>=2,
   progressObserved:row.progressAt!==null&&this.now()-row.progressAt<3000,
   decoding:'not-measurable',networkLoading:element.networkState===2,
   cleanupPending:row.released&&(assigned||!!element.isConnected),released:row.released,
   readiness:safe(surface?.readinessState),hls:!!surface?.hls&&!surface?.destroyed,
   buffered:ranges('buffered'),seekable:ranges('seekable')};
 }
 record(event,row){const entry=this.describe(row);if(!entry)return;
  this.events.push({at:this.now(),event,...entry});if(this.events.length>this.eventCapacity)this.events.shift();}
 snapshot(document=globalThis.document){
  const resources=[],seen=new Set(),hls=new Set();
  for(const [id,row] of this.rows){const element=row.element.deref();if(!element){this.rows.delete(id);continue;}
   seen.add(element);const value=this.describe(row);if(value){resources.push(value);const surface=row.surface.deref();if(value.hls)hls.add(surface.hls);}}
  let untracked=0;for(const element of document?.querySelectorAll?.('video,audio')||[]){if(seen.has(element))continue;untracked++;
   if(resources.length<this.capacity)resources.push({owner:'unattributed',element:element.tagName.toLowerCase(),connected:true,srcAssigned:!!element.getAttribute('src'),paused:element.paused,readyState:element.readyState,networkState:element.networkState,decoding:'not-measurable'});}
  const active=resources.filter(row=>!row.released||row.cleanupPending);
  const owners={};for(const row of active){if(!row.surfaceId)continue;(owners[row.owner]??=new Set()).add(row.surfaceId);}
  const performance=globalThis.performance;const entries=performance?.getEntriesByType?.('resource')||[];
  return {version:1,at:this.now(),enabled:this.enabled,truncated:this.dropped>0||resources.length>=this.capacity&&untracked>0,
   dropped:this.dropped,untracked,surfacesByOwner:Object.fromEntries(Object.entries(owners).map(([owner,ids])=>[owner,ids.size])),created:{...this.created},released:{...this.released},
   counts:{video:active.filter(r=>r.element==='video').length,audio:active.filter(r=>r.element==='audio').length,hls:hls.size,
    cleanupPending:resources.filter(r=>r.cleanupPending).length},
   browser:{resourceEntries:entries.length,mediaResourceEntries:entries.filter(r=>['video','audio'].includes(r.initiatorType)).length,
    usedJSHeapSize:finite(performance?.memory?.usedJSHeapSize),rangeHeaders:'not-exposed-by-resource-timing'},resources};
 }
 exportJSON(){return JSON.stringify({inventory:this.snapshot(),events:this.events},null,2);}
}
const resources=new ControlMediaResources({enabled:trace.enabled});
export default resources;
export function installControlMediaResources(ownerProvider){
 resources.ownerProvider=ownerProvider;
 if(!resources.enabled)return;
 try{Object.defineProperty(globalThis,'livezoneControlMediaResources',{configurable:true,value:Object.freeze({
  snapshot:()=>resources.snapshot(),exportJSON:()=>resources.exportJSON(),clearEvents:()=>{resources.events=[];}
 })});}catch{/* Diagnostics must not block Control bootstrap. */}
}
