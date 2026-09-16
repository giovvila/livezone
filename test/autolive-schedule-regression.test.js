import test from 'node:test';
import assert from 'node:assert/strict';
import DominantLiveConfig from '../public/js/studio/DominantLiveConfig.js';
import StudioLiveSourcesUI from '../public/js/ui/StudioLiveSourcesUI.js';
import StudioCatalogManager from '../public/js/studio/StudioCatalogManager.js';

const source={id:'live-a',name:'LIVE A',kind:'hls',url:'https://example.test/live.m3u8',enabled:true,origin:'operator',sceneIds:['live-scene-a']};
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};};
const click=(action,id=source.id)=>({target:{closest:()=>({dataset:{action,id}})}});

test('A3 Auto Interrupt selection writes armed and source identity as one authority mutation',async()=>{
 const config=new DominantLiveConfig({storage:storage(),eventTarget:null});const patches=[];
 config.authorityMutation=async patch=>{patches.push(patch);config.lastWrite={ok:true};config.update({armed:patch.armed,authorizedSourceId:patch.authorizedSourceId},{persist:false});return {ok:true};};
 const ui=new StudioLiveSourcesUI(null,{getSources:()=>[source]},null,config);ui.show=()=>false;
 await ui.handleClick(click('authorize'));
 assert.deepEqual(patches[0],{armed:true,authorizedSourceId:'live-a'});
 assert.deepEqual(config.getSnapshot(),{armed:true,authorizedSourceId:'live-a'});
 await ui.handleClick(click('authorize'));
 assert.deepEqual(patches[1],{armed:false,authorizedSourceId:null});
 assert.deepEqual(config.getSnapshot(),{armed:false,authorizedSourceId:null});config.destroy();
});

test('A3 OFF rendering requires both armed consent and matching source',()=>{
 const previous=globalThis.document;globalThis.document={createElement:()=>({dataset:{},attributes:{},children:[],setAttribute(k,v){this.attributes[k]=v;},append(...v){this.children.push(...v);}})};
 try{const ui=new StudioLiveSourcesUI(null,null,null,{getSnapshot:()=>({armed:false,authorizedSourceId:'live-a'})});ui.started=true;ui.list={replaceChildren(...rows){this.rows=rows;}};
  ui.render([source]);const authorize=ui.list.rows[0].children[4].children[2];assert.equal(authorize.textContent,'AUTO INTERRUPT: OFF');assert.equal(authorize.attributes['aria-pressed'],'false');
 }finally{globalThis.document=previous;}
});

test('A3 operator LIVE removal revokes Auto Interrupt then removes generated scene then source',async()=>{
 const calls=[];let snapshot={armed:true,authorizedSourceId:'live-a'};
 const config={getSnapshot:()=>snapshot,lastWrite:{ok:true},async setAutoInterruptSource(id){calls.push(['autolive',id]);snapshot={armed:id!==null,authorizedSourceId:id};this.lastWrite={ok:true};return {ok:true};}};
 const catalog={getSources:()=>[source],async removeScene(id){calls.push(['scene',id]);return {ok:true};},async removeSource(id){calls.push(['source',id]);return {ok:true};}};
 const schedule={subscribe:fn=>{fn({schedule:{items:[]}});return()=>{};}};
 const ui=new StudioLiveSourcesUI(null,catalog,schedule,config);ui.show=()=>false;ui.reset=()=>{};
 await ui.handleClick(click('remove'));
 assert.deepEqual(calls,[['autolive',null],['scene','live-scene-a'],['source','live-a']]);
 assert.deepEqual(snapshot,{armed:false,authorizedSourceId:null});
});

test('A3 scheduled LIVE remains protected before any AutoLive or catalog mutation',async()=>{
 const calls=[];const config={getSnapshot:()=>({armed:true,authorizedSourceId:'live-a'}),lastWrite:{ok:true},async setAutoInterruptSource(id){calls.push(['autolive',id]);return {ok:true};}};
 const catalog={getSources:()=>[source],removeScene(id){calls.push(['scene',id]);return {ok:true};},removeSource(id){calls.push(['source',id]);return {ok:true};}};
 const schedule={subscribe:fn=>{fn({schedule:{items:[{sceneId:'live-scene-a'}]}});return()=>{};}};
 const ui=new StudioLiveSourcesUI(null,catalog,schedule,config);ui.show=()=>false;
 await ui.handleClick(click('remove'));assert.deepEqual(calls,[]);
});

test('A3 disabled LIVE scene may be removed when intentionally absent from runtime registry',()=>{
 const scenes=new Map(),sources=new Map();
 const disabled={id:'live-a',name:'LIVE A',kind:'hls',url:'https://example.test/live.m3u8',enabled:false,origin:'operator'};
 const definition={id:'live-scene-a',name:'LIVE A',type:'LIVE',renderer:{kind:'source',sourceId:'live-a'},origin:'operator'};
 sources.set(disabled.id,disabled);
 const catalog=new StudioCatalogManager({storage:storage(),eventTarget:null,baseUrl:'https://example.test/',uuidFactory:()=>null,
  studioStateManager:{registerScene:s=>(scenes.set(s.id,s),s),unregisterScene:id=>{const s=scenes.get(id);if(!s)return null;scenes.delete(id);return s;},getScene:id=>scenes.get(id)||null,getPreviewSceneId:()=>null,getProgramSceneId:()=>null,replaceScene:()=>null},
  studioSourceManager:{registerSource:s=>(sources.set(s.id,s),s),unregisterSource:id=>{const s=sources.get(id);if(!s)return null;sources.delete(id);return s;},replaceSource:s=>(sources.set(s.id,s),s),getSource:id=>sources.get(id)||null,getActiveInstances:()=>[]}});
 catalog.initialized=true;catalog.sources.set(disabled.id,disabled);catalog.definitions.set(definition.id,definition);catalog.operatorSourceIds.add(disabled.id);catalog.operatorSceneIds.add(definition.id);
 assert.equal(catalog.removeScene(definition.id).ok,true);assert.equal(catalog.definitions.has(definition.id),false);assert.equal(scenes.size,0);
});

test('A3 enabled LIVE scene still fails closed when unexpectedly absent from runtime registry',()=>{
 const sources=new Map();const enabled={id:'live-a',name:'LIVE A',kind:'hls',url:'https://example.test/live.m3u8',enabled:true,origin:'operator'};
 const definition={id:'live-scene-a',name:'LIVE A',type:'LIVE',renderer:{kind:'source',sourceId:'live-a'},origin:'operator'};sources.set(enabled.id,enabled);
 const catalog=new StudioCatalogManager({storage:storage(),eventTarget:null,baseUrl:'https://example.test/',uuidFactory:()=>null,
  studioStateManager:{registerScene:()=>null,unregisterScene:()=>null,getScene:()=>null,getPreviewSceneId:()=>null,getProgramSceneId:()=>null,replaceScene:()=>null},
  studioSourceManager:{registerSource:s=>(sources.set(s.id,s),s),unregisterSource:id=>sources.get(id)||null,replaceSource:s=>(sources.set(s.id,s),s),getSource:id=>sources.get(id)||null,getActiveInstances:()=>[]}});
 catalog.initialized=true;catalog.sources.set(enabled.id,enabled);catalog.definitions.set(definition.id,definition);catalog.operatorSourceIds.add(enabled.id);catalog.operatorSceneIds.add(definition.id);
 assert.deepEqual(catalog.removeScene(definition.id),{ok:false,reason:'scene-unregister-rejected'});assert.equal(catalog.definitions.has(definition.id),true);
});
