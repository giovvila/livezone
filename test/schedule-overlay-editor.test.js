import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import ScheduleWorkspaceUI from '../public/js/ui/ScheduleWorkspaceUI.js';
import ScheduleApiClient from '../public/js/scheduler/ScheduleApiClient.js';
import ServerScheduleStore from '../public/js/scheduler/ServerScheduleStore.js';
import {overlayFromEditor,overlayToEditor,eventMode} from '../public/js/scheduler/ScheduleEventEditorAdapter.js';
import {createProgramOutputServer} from '../test-support/ReferenceAuthorityTestServer.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
const html=await readFile(new URL('../public/control/schedule/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/css/schedule-workspace.css',import.meta.url),'utf8');
const now=Date.parse('2026-09-13T10:00:00Z');
const assets=[['asset-00000000-0000-4000-8000-000000000001','image/png'],['asset-00000000-0000-4000-8000-000000000002','image/webp'],['asset-00000000-0000-4000-8000-000000000003','image/jpeg'],['video','video/mp4']].map(([id,mimeType])=>({id,mimeType,kind:mimeType.startsWith('image/')?'image':'video',url:'/media-library/files/image/'+id+'.png',originalName:id,size:100}));
async function harness(t){
 const dom=new JSDOM(html,{url:'http://localhost/control/schedule/'}),old={document:globalThis.document,FormData:globalThis.FormData};
 globalThis.document=dom.window.document;globalThis.FormData=dom.window.FormData;
 const style=document.createElement('style');style.textContent=css;document.head.append(style);
 const dir=await mkdtemp(join(tmpdir(),'lz-editor-'));const server=createProgramOutputServer({publisherToken:'editor-test-publisher',operatorAuth:new OperatorAuth({disabled:true}),schedulePath:join(dir,'schedule.json'),studioStatePath:join(dir,'studio.json'),mediaAssetRepository:{initialize:async()=>{},list:()=>assets,get:id=>assets.find(a=>a.id===id)||null},scheduleClock:()=>now,scheduleSetTimer:()=>1,scheduleClearTimer:()=>{}});
 await new Promise(resolve=>server.server.listen(0,'127.0.0.1',resolve));await server.scheduler.ready;
 const requests=[];const base='http://127.0.0.1:'+server.server.address().port;
 const client=new ScheduleApiClient({request:(path,options)=>{requests.push({path,...options});return fetch(base+path,options);},eventSourceFactory:()=>({addEventListener(){},removeEventListener(){},close(){}})});
 const store=new ServerScheduleStore({client,storage:null});await store.start();
 const manager={listAssets:()=>assets,getAsset:id=>assets.find(a=>a.id===id),refresh:async()=>{}};
 const catalog={subscribe:()=>()=>{},getDefinitions:()=>[],getDefinition:()=>null,getSources:()=>[{id:'video-a',name:'VIDEO A',kind:'media',origin:'managed'}]};
 let serial=0;const ui=new ScheduleWorkspaceUI({root:document.querySelector('#schedule-workspace'),store,catalog,mediaLibraryManager:manager,clock:()=>now,uuidFactory:()=>String(++serial),clockTicker:{subscribe:()=>()=>{}}});
 t.after(async()=>{ui.destroy();store.destroy();await new Promise(resolve=>server.server.close(resolve));await rm(dir,{recursive:true,force:true});dom.window.close();globalThis.document=old.document;globalThis.FormData=old.FormData;});
 assert.equal(ui.start(),true);const form=ui.form,editor=ui.overlayEditor;
 const set=(name,value)=>{const node=form.elements[name];if(typeof value==='boolean')node.checked=value;else node.value=value;};
 const mode=value=>{set('eventMode',value);form.elements.eventMode.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
 const fill=(kind='CRAWL')=>{mode(kind);for(const [name,value] of Object.entries({overlayTitle:kind+' event',overlayDate:'2026-09-13',overlayTime:'20:05:00',overlayDuration:'300',overlayPriority:'2',crawlText:'Evening news',sponsorAssetId:'asset-00000000-0000-4000-8000-000000000001'}))set(name,value);};
 const save=()=>ui.handleFormSubmit({preventDefault(){}});
 const button=(id,action)=>ui.list.querySelector(`button[data-id="${id}"][data-action="${action}"]`);
 const action=async(id,kind)=>{await ui.handleListClick({target:button(id,kind)});while(editor.busy)await new Promise(resolve=>setTimeout(resolve,1));};
 return {dom,ui,editor,form,client,store,server,requests,set,mode,fill,save,action};
}
function visible(node){return !node.closest('[hidden]');}
test('production Event Editor exposes PROGRAMMA, TEXT CRAWL and SPONSOR; Program defaults and original fields',async t=>{
 const h=await harness(t);const selector=h.form.querySelector('#schedule-event-type');assert.ok(visible(selector));assert.deepEqual([...selector.options].map(o=>o.textContent),['PROGRAMMA','TEXT CRAWL','SPONSOR']);assert.equal(selector.value,'PROGRAMMA');
 for(const name of ['title','sourceTargetId','behavior','startMode','date','time','duration','transition'])assert.ok(visible(h.form.elements[name]),name);
 assert.ok(visible(h.form.querySelector('#schedule-content-kind')));assert.equal(h.form.querySelector('input[name=targetKind]:checked').value,'source');assert.equal(visible(h.editor.overlay),false);
 for(const mode of ['CRAWL','SPONSOR']){h.mode(mode);assert.equal(visible(h.editor.program),false);assert.equal(h.dom.window.getComputedStyle(h.editor.program).display,'none');assert.ok(h.editor.program.disabled);assert.ok(visible(mode==='CRAWL'?h.editor.crawl:h.editor.sponsor));assert.equal(new FormData(h.form).has('sourceTargetId'),false);}
});
test('production Program save/edit remains in existing schema and execution suspended',async t=>{
 const h=await harness(t);h.set('title','VIDEO A');h.set('date','2026-09-13');h.set('time','20:00:00');h.set('duration','00:30:00');await h.save();
 assert.equal(h.client.state.schedule.programPlan.items.length,1);assert.equal(h.client.state.schedule.events.length,0);assert.match(h.ui.serverBanner.textContent,/PROGRAM EXECUTION SUSPENDED/);
 const item=h.ui.schedule.items[0];h.mode('SPONSOR');await h.action(item.id,'edit');assert.equal(h.editor.mode,'PROGRAMMA');assert.equal(h.form.elements.title.value,'VIDEO A');assert.equal(h.form.elements.sourceTargetId.value,'video-a');
});
for(const kind of ['CRAWL','SPONSOR'])test('production '+kind+' create, hydrate, update, enable/disable, delete via server API',async t=>{
 const h=await harness(t);h.fill(kind);await h.save();let event=h.client.state.schedule.events[0];assert.equal(eventMode(event),kind);assert.equal(event.payload.assetId,kind==='SPONSOR'?'asset-00000000-0000-4000-8000-000000000001':undefined);
 assert.ok(h.ui.list.textContent.includes(kind==='CRAWL'?'TEXT CRAWL':'SPONSOR'));
 await h.action(event.id,'edit');assert.equal(h.editor.mode,kind);assert.equal(h.form.elements.overlayTime.value,'20:05:00');assert.equal(h.form.elements.overlayPriority.value,'2');
 h.set('overlayTitle','Edited');await h.save();assert.equal(h.client.state.schedule.events[0].name,'Edited');
 await h.action(event.id,'toggle');assert.equal(h.client.state.schedule.events[0].enabled,false);await h.action(event.id,'toggle');assert.equal(h.client.state.schedule.events[0].enabled,true);
 await h.action(event.id,'remove');assert.equal(h.client.state.schedule.events.length,0);
 const writes=h.requests.filter(r=>r.method);assert.ok(writes.every(r=>r.path.startsWith('/api/studio/schedule/events')));assert.ok(writes.every(r=>/^"schedule-\d+"$/.test(r.headers['If-Match'])));
 assert.equal(h.server.store.getCurrent(),null);assert.equal(h.client.state.schedule.programPlan?.items.length||0,0);
});
test('production Media Library picker opens and selects transparent PNG; thumbnail adds no background',async t=>{
 const h=await harness(t);h.mode('SPONSOR');h.editor.pick.click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(h.editor.picker.root.hidden,false);
 assert.ok(h.editor.picker.root.textContent.includes('asset-00000000-0000-4000-8000-000000000001'));assert.ok(h.editor.picker.root.textContent.includes('asset-00000000-0000-4000-8000-000000000002'));assert.ok(h.editor.picker.root.textContent.includes('asset-00000000-0000-4000-8000-000000000003'));assert.ok(!h.editor.picker.root.textContent.includes('video/mp4'));
 h.editor.picker.root.querySelector('[data-picker-asset="asset-00000000-0000-4000-8000-000000000001"]').click();h.editor.picker.root.querySelector('[data-picker-confirm]').click();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(h.form.elements.sponsorAssetId.value,'asset-00000000-0000-4000-8000-000000000001');const thumb=h.ui.root.querySelector('#schedule-sponsor-thumbnail');assert.equal(thumb.hidden,false);assert.equal(thumb.getAttribute('src'),assets[0].url);assert.equal(thumb.style.background,'');
});
test('same day Program coverage unaffected by overlapping crawl and multiple priority sponsors; zero Program/Preview command requests',async t=>{
 const h=await harness(t);h.set('title','VIDEO A');h.set('date','2026-09-13');h.set('time','20:00:00');h.set('duration','00:30:00');await h.save();const plan=structuredClone(h.client.state.schedule.programPlan),coverage=h.ui.covered.textContent;h.requests.length=0;
 for(const kind of ['CRAWL','SPONSOR','SPONSOR']){h.fill(kind);await h.save();}
 assert.equal(h.client.state.schedule.events.length,3);assert.deepEqual(h.client.state.schedule.programPlan,plan);assert.equal(h.ui.covered.textContent,coverage);assert.equal(h.ui.list.children.length,4);
 assert.equal(h.requests.filter(r=>r.method&& !r.path.includes('/schedule/events')).length,0);
 h.ui.selectDate('2026-09-14');assert.equal(h.ui.list.children.length,0);
});
test('mode switching drops incompatible values and editing IDs without leaking payload fields',async t=>{
 const h=await harness(t);h.fill('SPONSOR');await h.save();await h.action(h.client.state.schedule.events[0].id,'edit');h.mode('CRAWL');assert.equal(h.editor.editId,null);assert.equal(h.form.elements.sponsorAssetId.value,'');h.set('overlayTitle','Crawl');h.set('overlayTime','20:05');h.set('crawlText','Text');await h.save();
 const crawl=h.client.state.schedule.events.find(e=>e.type==='overlay.crawl');assert.deepEqual(Object.keys(crawl.payload).sort(),['background','direction','position','repeat','speed','styleId','text']);assert.equal(h.client.state.schedule.events[0].type,'overlay.sponsor');
});
for(const [kind,field,value] of [['CRAWL','crawlText',' '],['CRAWL','crawlSpeed','invalid'],['CRAWL','crawlDirection','up'],['SPONSOR','sponsorAssetId','video'],['SPONSOR','sponsorSize','31'],['SPONSOR','sponsorOpacity','101'],['SPONSOR','sponsorPosition','middle'],['CRAWL','overlayDuration','0'],['SPONSOR','overlayTime','']])test('editor rejects '+kind+' invalid '+field,async t=>{
 const h=await harness(t);h.fill(kind);h.set(field,value);await h.save();assert.equal(h.client.state.schedule.events.length,0);assert.ok(h.ui.feedback.classList.contains('is-error'));assert.ok(h.ui.feedback.textContent.length<200);
});
test('server revision conflict refreshes without retry; unsaved overlay draft retained',async t=>{
 const h=await harness(t);h.fill('CRAWL');const value=overlayFromEditor('CRAWL',new FormData(h.form),{timezone:'Europe/Rome'});
 const request=h.requests;const response=await fetch('http://127.0.0.1:'+h.server.server.address().port+'/api/studio/schedule/events',{method:'POST',headers:{'Content-Type':'application/json','If-Match':'"schedule-0"'},body:JSON.stringify({...value,id:'external',version:1})});assert.equal(response.status,201);
 await h.save();assert.match(h.ui.feedback.textContent,/SCHEDULE CHANGED/);assert.equal(h.form.elements.crawlText.value,'Evening news');assert.equal(h.client.state.schedule.events.length,1);assert.equal(request.filter(r=>r.method==='POST').length,1);
});
test('degraded server locks every editor mode and textarea; reconnect restores correct active fields',async t=>{
 const h=await harness(t);h.fill('CRAWL');h.client.connectionLost('SSE_DISCONNECTED');assert.ok(h.form.elements.crawlText.matches(':disabled'));assert.ok(h.form.elements.eventMode.disabled);assert.ok(h.editor.program.disabled);await h.save();assert.equal(h.client.state.schedule.events.length,0);
 await h.client.refresh();assert.ok(!h.form.elements.crawlText.matches(':disabled'));assert.ok(h.editor.program.disabled);assert.match(h.ui.serverBanner.textContent,/PROGRAM EXECUTION SUSPENDED/);
});
for(const asset of assets.filter(a=>a.kind==='image'))test('adapter accepts '+asset.mimeType+' and round trips timezone and opacity',async t=>{
 const h=await harness(t);h.fill('SPONSOR');h.set('sponsorAssetId',asset.id);h.set('sponsorOpacity','0');await h.save();const event=h.client.state.schedule.events[0];assert.equal(event.payload.opacity,0);assert.equal(event.startAt,'2026-09-13T18:05:00.000Z');assert.equal(overlayToEditor(event,'Europe/Rome').overlayTime,'20:05:00');
});
test('production submit button and list click bindings save and open Sponsor editor',async t=>{
 const h=await harness(t);h.fill('SPONSOR');assert.equal(h.form.checkValidity(),true);
 h.form.querySelector('button[type=submit]').click();
 while(h.editor.busy)await new Promise(resolve=>setTimeout(resolve,1));
 assert.equal(h.client.state.schedule.events.length,1);
 const button=h.ui.list.querySelector('button[data-overlay="true"][data-action="edit"]');button.click();assert.equal(h.editor.mode,'SPONSOR');assert.equal(h.form.elements.sponsorAssetId.value,'asset-00000000-0000-4000-8000-000000000001');
});
test('changing mode while library refresh is pending cannot populate the new mode',async t=>{
 const h=await harness(t);h.mode('SPONSOR');let resolve;h.editor.manager.refresh=()=>new Promise(r=>resolve=r);const choosing=h.editor.chooseAsset();h.mode('CRAWL');resolve();await choosing;
 assert.equal(h.editor.picker.root.hidden,true);assert.equal(h.form.elements.sponsorAssetId.value,'');assert.equal(h.editor.mode,'CRAWL');
});
test('shared Gallery selection uses Sponsor assetId without altering an existing Sponsor draft',async t=>{
 const h=await harness(t);h.editor.useAsset(assets[0]);assert.equal(h.editor.mode,'SPONSOR');assert.equal(h.form.elements.sponsorAssetId.value,assets[0].id);
 h.set('overlayTitle','Sponsor draft');h.set('overlayTime','20:05');h.editor.useAsset(assets[1]);assert.equal(h.form.elements.overlayTitle.value,'Sponsor draft');assert.equal(h.form.elements.sponsorAssetId.value,assets[1].id);await h.save();assert.equal(h.client.state.schedule.events[0].payload.assetId,assets[1].id);
});
test('Sponsor draft selected before another workspace removes the asset fails cleanly before save',async t=>{
 const h=await harness(t);h.fill('SPONSOR');h.editor.manager.refresh=async()=>{h.editor.manager.getAsset=()=>null;};await h.save();assert.equal(h.ui.feedback.textContent,'ASSET NON DISPONIBILE');assert.equal(h.client.state.schedule.events.length,0);assert.equal(h.requests.filter(request=>request.method==='POST').length,0);
});
test('Sponsor draft cannot save when shared library refresh is unavailable',async t=>{
 const h=await harness(t);h.fill('SPONSOR');h.editor.manager.refresh=async()=>{throw Error('offline');};await h.save();assert.equal(h.ui.feedback.textContent,'ASSET NON DISPONIBILE');assert.equal(h.client.state.schedule.events.length,0);
});

for(const fit of ['CONTAIN','COVER'])test('fullscreen editor save/edit and mode switch '+fit,async t=>{
 const h=await harness(t);h.fill('SPONSOR');h.set('sponsorLayout','FULLSCREEN');h.form.elements.sponsorLayout.dispatchEvent(new h.dom.window.Event('change'));
 assert.equal(visible(h.form.elements.sponsorPosition),false);assert.equal(h.dom.window.getComputedStyle(h.form.elements.sponsorPosition.closest('label')).display,'none');assert.equal(visible(h.form.elements.sponsorSize),false);assert.equal(visible(h.form.elements.sponsorFit),true);assert.equal(new FormData(h.form).has('sponsorSize'),false);h.set('sponsorFit',fit);await h.save();
 let event=h.client.state.schedule.events[0];assert.equal(event.payload.layout,'FULLSCREEN');assert.equal(event.payload.fit,fit);assert.equal(event.payload.position,undefined);assert.equal(event.payload.sizePercent,undefined);
 await h.action(event.id,'edit');assert.equal(h.form.elements.sponsorLayout.value,'FULLSCREEN');assert.equal(h.form.elements.sponsorFit.value,fit);h.set('sponsorLayout','CORNER');h.form.elements.sponsorLayout.dispatchEvent(new h.dom.window.Event('change'));assert.equal(visible(h.form.elements.sponsorFit),false);assert.equal(visible(h.form.elements.sponsorSize),true);await h.save();event=h.client.state.schedule.events[0];assert.equal(event.payload.layout,'CORNER');assert.equal(event.payload.fit,undefined);assert.equal(event.payload.sizePercent,12);
});
