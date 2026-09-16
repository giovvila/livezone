import test from 'node:test';
import assert from 'node:assert/strict';
import StudioReferenceAuthority from '../public/js/studio/StudioReferenceAuthority.js';

const live=id=>({id,name:id,kind:'hls',url:'https://example.test/live.m3u8',enabled:true,origin:'operator'});
const scene=(id,sourceId)=>({id,name:id,type:'LIVE',renderer:{kind:'source',sourceId},origin:'operator'});
function catalog({enabled=true,runtimeScene=false}={}){
 const source={...live('live-a'),enabled},definition=scene('live-scene-a','live-a');
 const runtime=new Map(runtimeScene?[[definition.id,definition]]:[]),registered=[];
 return {
  sources:new Map([[source.id,source]]),definitions:new Map([[definition.id,definition]]),
  studioStateManager:{getScene:id=>runtime.get(id)||null,getScenes:()=>[...runtime.values()],registerScene:value=>{if(runtime.has(value.id))return null;runtime.set(value.id,value);registered.push(value.id);return value;},
   unregisterScene:id=>{const value=runtime.get(id);if(!value)return null;runtime.delete(id);return value;},getPreviewSceneId:()=>null,getProgramSceneId:()=>null},
  studioSourceManager:{getSources:()=>[source],getSource:id=>id===source.id?source:null,getActiveInstances:()=>[],registerSource:()=>source,unregisterSource:()=>source,replaceSource:()=>source},
  serializeSource:value=>({id:value.id,name:value.name,kind:value.kind,url:value.url,enabled:value.enabled,origin:value.origin}),
  loadOverlay:()=>({issues:[]}),registered,runtime
 };
}
const request=async(url)=>url==='/api/studio/state'
 ?{state:{revision:1}}
 :{state:{revision:1,sources:[],scenes:[]}};

test('A3 reference bootstrap repairs an enabled persisted scene missing from runtime registry',async()=>{
 const c=catalog();const authority=new StudioReferenceAuthority({catalog:c,request});
 assert.equal(await authority.initialize(),true);assert.equal(authority.ready,true);
 assert.deepEqual(c.registered,['live-scene-a']);assert.ok(c.runtime.has('live-scene-a'));
});

test('A3 reference bootstrap does not runtime-register a disabled LIVE definition',async()=>{
 const c=catalog({enabled:false});const authority=new StudioReferenceAuthority({catalog:c,request});
 assert.equal(await authority.initialize(),true);assert.deepEqual(c.registered,[]);assert.equal(c.runtime.size,0);
});

test('A3 reference bootstrap is idempotent when runtime scene already exists',async()=>{
 const c=catalog({runtimeScene:true});const authority=new StudioReferenceAuthority({catalog:c,request});
 assert.equal(await authority.initialize(),true);assert.deepEqual(c.registered,[]);assert.equal(c.runtime.size,1);
});

test('A3 draft runtime scene mutations are isolated and ordered for compound remove',()=>{
 const c=catalog({runtimeScene:true});const authority=new StudioReferenceAuthority({catalog:c,request});
 const draft=authority.createDraftManager(c.studioStateManager,['registerScene','replaceScene','unregisterScene']);
 assert.ok(draft.getScene('live-scene-a'));
 assert.ok(draft.unregisterScene('live-scene-a'));
 assert.equal(draft.getScene('live-scene-a'),null);
 assert.equal(draft.unregisterScene('live-scene-a'),null);
 assert.ok(c.runtime.has('live-scene-a'),'live runtime registry must remain untouched by staging');
});

test('A3 draft runtime source mutations are isolated and ordered',()=>{
 const c=catalog({runtimeScene:true});const authority=new StudioReferenceAuthority({catalog:c,request});
 const draft=authority.createDraftManager(c.studioSourceManager,['registerSource','replaceSource','unregisterSource']);
 assert.ok(draft.getSource('live-a'));
 assert.ok(draft.unregisterSource('live-a'));
 assert.equal(draft.getSource('live-a'),null);
 assert.ok(c.studioSourceManager.getSource('live-a'),'live source registry must remain untouched by staging');
});
