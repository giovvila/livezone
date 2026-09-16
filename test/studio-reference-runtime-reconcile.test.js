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
  studioStateManager:{getScene:id=>runtime.get(id)||null,registerScene:value=>{if(runtime.has(value.id))return null;runtime.set(value.id,value);registered.push(value.id);return value;}},
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
