import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JSDOM} from 'jsdom';
import {createProgramOutputServer} from '../test-support/ReferenceAuthorityTestServer.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
import MediaAssetRepository from '../server/media-library/MediaAssetRepository.js';
import {requireOperatorSession} from '../public/js/auth/OperatorSessionClient.js';
import MediaLibraryClient from '../public/js/media-library/MediaLibraryClient.js';
import MediaLibraryManager from '../public/js/media-library/MediaLibraryManager.js';
import MediaLibraryUI from '../public/js/ui/MediaLibraryUI.js';
import ScheduleWorkspacePanels from '../public/js/ui/ScheduleWorkspacePanels.js';
import StudioGraphicsLayer from '../public/js/studio/renderers/StudioGraphicsLayer.js';
import ControlCrawlObserver from '../public/js/program-output/ControlCrawlObserver.js';
import PublicProgramController from '../public/js/public/PublicProgramController.js';
import NetworkProgramOutputTransport from '../public/js/program-output/NetworkProgramOutputTransport.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
const html=await readFile(new URL('../public/control/schedule/index.html',import.meta.url),'utf8');
const epoch=Date.parse('2026-09-13T21:06:00Z'),stamp=n=>new Date(epoch+n).toISOString();
const base={version:1,publisherSessionId:'production-fixture',revision:1,publishedAt:stamp(0),committedAt:stamp(0),scene:{id:'video-a',name:'VIDEO A',type:'MEDIA'},source:{id:'video-a',kind:'media',url:'http://example.test/video.mp4'},playback:{initialTime:5,duration:600,playing:true,ended:false,state:'playing',startedAt:stamp(0)},graphics:{items:[{id:'channel-logo',kind:'image',position:'top-left',url:'http://example.test/logo.png'}]},overlays:{},transition:{type:'cut',durationMs:0}};
// Valid transparent 1x1 PNG; other fixtures exercise the existing signature contract.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=','base64');
const fixtures=[['png','image/png',png],['webp','image/webp',Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64')],['jpg','image/jpeg',Buffer.from([255,216,255,224,0,0])]];
async function harness(t){
 const dir=await mkdtemp(join(tmpdir(),'lz-sponsor-runtime-'));const repo=new MediaAssetRepository({root:join(dir,'media')});let now=epoch;
 const auth=new OperatorAuth({username:'test-operator',password:'test-password-only',secureCookie:false});const session=auth.authenticate('test-operator','test-password-only');const cookie=auth.createCookie(session);
 const server=createProgramOutputServer({publisherToken:'sponsor-runtime-test-token',operatorAuth:auth,mediaAssetRepository:repo,schedulePath:join(dir,'schedule.json'),studioStatePath:join(dir,'studio.json'),scheduleClock:()=>now,scheduleSetTimer:()=>1,scheduleClearTimer:()=>{}});
 await new Promise(resolve=>server.server.listen(0,'127.0.0.1',resolve));await server.scheduler.ready;const origin='http://127.0.0.1:'+server.server.address().port;
 // jsdom omits the browser Origin header for same-origin XHR POSTs. Supply it at the test transport boundary.
 server.server.prependListener('request',request=>{if(!request.headers.origin)request.headers.origin=origin;});
 const dom=new JSDOM(html,{url:origin+'/control/schedule/'});dom.cookieJar.setCookieSync(cookie,origin);const old={};for(const key of ['document','FormData','Blob','location','fetch'])old[key]=globalThis[key];
 Object.assign(globalThis,{document:dom.window.document,FormData:dom.window.FormData,Blob:dom.window.Blob,location:dom.window.location,fetch:(url,options={})=>old.fetch(new URL(url,origin),{...options,headers:{...Object.fromEntries(new Headers(options.headers)),Cookie:cookie.split(';')[0]}})});
 const managers=[];const manager=()=>{const m=new MediaLibraryManager(new MediaLibraryClient({xhrFactory:()=>new dom.window.XMLHttpRequest()}));managers.push(m);return m;};
 const schedulerManager=manager(),controlManager=manager();
 t.after(async()=>{dom.window.close();Object.assign(globalThis,old);await new Promise(resolve=>server.server.close(resolve));await rm(dir,{recursive:true,force:true});});
 await requireOperatorSession();await Promise.all([schedulerManager.initialize(),controlManager.initialize()]);
 const request=async(method,path,value)=>{const response=await old.fetch(origin+path,{method,headers:{Cookie:cookie.split(';')[0],'X-Livezone-Operator-Request':'1','X-Livezone-CSRF':session.csrfToken,'Content-Type':'application/json','If-Match':'"schedule-'+server.scheduler.store.getSnapshot().revision+'"'},...(value?{body:JSON.stringify(value)}:{})});assert.ok(response.ok,await response.clone().text());return response.json();};
 const sponsor=assetId=>({id:'sponsor',name:'Sponsor',version:1,type:'overlay.sponsor',enabled:true,startAt:stamp(1000),endAt:stamp(10000),priority:1,payload:{assetId,position:'top-right',sizePercent:12,opacity:1}});
 const crawl={id:'crawl',name:'Crawl',version:1,type:'overlay.crawl',enabled:true,startAt:stamp(0),endAt:stamp(20000),priority:0,payload:{text:'Concurrent crawl',position:'bottom',direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true}};
 const publish=(patch={})=>server.store.accept(createProgramOutputEnvelope({...base,...patch}));publish();
 const retained=async()=>{const abort=new AbortController();try{const r=await old.fetch(origin+'/api/program-output/events',{signal:abort.signal});let text='';const reader=r.body.getReader();while(!text.includes('data: '))text+=new TextDecoder().decode((await reader.read()).value);return JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6));}finally{abort.abort();}};
 return {dom,repo,server,origin,schedulerManager,controlManager,request,sponsor,crawl,publish,retained,tick:n=>{now=epoch+n;server.scheduler.runtime.reconcile();},now:()=>now,upload:async(manager,fixture=fixtures[0])=>manager.importAsset(new dom.window.File([fixture[2]],'sponsor.'+fixture[0],{type:fixture[1]}))};
}
for(const fixture of fixtures)test('real repository '+fixture[0]+' upload → ACTIVE → retained SSE → Control/Public/OBS Sponsor DOM',async t=>{
 const h=await harness(t);const asset=await h.upload(h.schedulerManager,fixture);await h.request('POST','/api/studio/schedule/events',h.sponsor(asset.id));await h.request('POST','/api/studio/schedule/events',h.crawl);const ingress=h.server.store.getCurrent();h.tick(2000);
 const envelope=await h.retained(),snapshot=envelope.snapshot;assert.equal(h.server.effectiveOutput.effectiveSponsor.id,'sponsor');assert.equal(snapshot.overlays.sponsor.url,asset.url);assert.equal(snapshot.overlays.sponsor.enabled,true);assert.equal(h.server.effectiveOutput.sponsorStatus,'SPONSOR_PROJECTED');
 const response=await fetch(h.origin+asset.url);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),fixture[1]);assert.deepEqual(Buffer.from(await response.arrayBuffer()),fixture[2]);
 const root=document.createElement('div');const layer=new StudioGraphicsLayer({root,consumer:'program',graphicsManager:{subscribe:()=>()=>{},getVisibleGraphics:()=>[{graphic:{id:'channel-logo',kind:'image',position:'top-left',asset:base.graphics.items[0].url}}]}});layer.start();
 const transport=new NetworkProgramOutputTransport({role:'subscriber',eventSourceFactory:()=>({addEventListener(){},removeEventListener(){},close(){}})});const observer=new ControlCrawlObserver({layer,transport});observer.start();transport.handleProgram({data:JSON.stringify(envelope)});assert.ok(root.querySelector('.scheduled-sponsor'));assert.ok(root.querySelector('.studio-text-crawl'));assert.equal(root.children.length,3);
 const sponsorNode=layer.sponsorView.element;assert.equal(sponsorNode.style.right,'1.5%');assert.equal(sponsorNode.style.width,'12%');assert.equal(sponsorNode.style.opacity,'1');assert.equal(sponsorNode.style.zIndex,'3');
 t.after(()=>{observer.destroy();layer.destroy();});
 for(const outputMode of ['public','obs']){
  const root=document.createElement('div');root.innerHTML='<div data-public-base></div><div data-public-graphics></div>';const viewer=new PublicProgramController({root,outputMode,now:h.now});viewer.current={snapshot:base};const surface=viewer.current;
  viewer.scheduleStaleState=()=>{};viewer.renderSnapshot=()=>assert.fail('Program recreated');viewer.reconcilePlayback=()=>assert.fail('Program playback mutated');
  viewer.handleSnapshot(snapshot,{livePublisher:true});assert.ok(root.querySelector('.scheduled-sponsor'));assert.ok(root.querySelector('.public-text-crawl'));assert.ok(root.querySelector('.public-graphic--image'));assert.equal(viewer.current,surface);
  const node=viewer.sponsorView.element;viewer.handleSnapshot({...snapshot,overlays:{sponsor:snapshot.overlays.sponsor},output:{...snapshot.output,revision:snapshot.output.revision+1}},{livePublisher:true});assert.equal(viewer.sponsorView.element,node);
  viewer.sponsorView.destroy();viewer.crawlView.destroy();
 }
 assert.deepEqual(h.server.store.getCurrent(),ingress);
});
for(const layout of ['CORNER','FULLSCREEN'])for(const failure of ['missing','wrong-kind','unsafe-url','missing-file'])test(layout+' Sponsor '+failure+' is omitted with bounded diagnostic, preserving Program/crawl/logo',async t=>{
 const h=await harness(t);const asset=await h.upload(h.schedulerManager);const event=h.sponsor(asset.id);if(layout==='FULLSCREEN')event.payload={assetId:asset.id,layout,fit:'CONTAIN',opacity:1};
 // Persist a valid reference first, then simulate post-commit storage corruption.
 // D1 rejects new missing/wrong-type references at the API boundary.
 await h.request('POST','/api/studio/schedule/events',event);
 if(failure==='missing')h.repo.assets.delete(asset.id);
 if(failure==='wrong-kind')h.repo.assets.set(asset.id,{...h.repo.assets.get(asset.id),kind:'audio'});
 if(failure==='unsafe-url')h.repo.assets.set(asset.id,{...h.repo.assets.get(asset.id),url:'file:///private/sponsor.png'});
 if(failure==='missing-file')await unlink(h.repo.safeFilePath(asset.kind,asset.storedName));
 await h.request('POST','/api/studio/schedule/events',h.crawl);h.tick(2000);const output=(await h.retained()).snapshot;
 assert.equal(output.overlays.sponsor,undefined);assert.equal(output.overlays.textCrawl.enabled,true);assert.deepEqual(output.source,base.source);assert.deepEqual(output.graphics,base.graphics);
 const diagnostics=h.server.effectiveOutput.diagnostics.snapshot();assert.ok(diagnostics.some(e=>e.event.startsWith('SPONSOR_ASSET_')));assert.ok(diagnostics.length<=100);assert.ok(!JSON.stringify(diagnostics).includes(asset.id));
});
test('configured/live source panels collapse independently, persist and preserve editor/source nodes',async t=>{
 const h=await harness(t),root=document.querySelector('#schedule-workspace'),storage=h.dom.window.localStorage;const panels=new ScheduleWorkspacePanels(root,{storage});panels.start();
 const configured=root.querySelector('[data-schedule-panel=configured]'),live=root.querySelector('[data-schedule-panel=live]');const sourceList=root.querySelector('#schedule-source-list'),editor=root.querySelector('#schedule-item-form');sourceList.textContent='unchanged';
 for(const panel of [configured,live]){assert.equal(panel.querySelector('[data-panel-body]').hidden,true);assert.equal(panel.querySelector('button').getAttribute('aria-expanded'),'false');}
 configured.querySelector('button').click();assert.equal(configured.querySelector('[data-panel-body]').hidden,false);assert.equal(live.querySelector('[data-panel-body]').hidden,true);live.querySelector('button').click();configured.querySelector('button').click();
 assert.equal(live.querySelector('[data-panel-body]').hidden,false);assert.equal(root.querySelector('#schedule-source-list'),sourceList);assert.equal(sourceList.textContent,'unchanged');assert.equal(root.querySelector('#schedule-item-form'),editor);panels.destroy();
 const restored=new ScheduleWorkspacePanels(root,{storage});restored.start();assert.equal(live.querySelector('[data-panel-body]').hidden,false);assert.equal(configured.querySelector('[data-panel-body]').hidden,true);restored.destroy();assert.deepEqual(h.server.store.getCurrent().snapshot,base);
});
test('Scheduler MediaLibraryUI uses existing XHR upload and shared Control/Scheduler IDs in both directions',async t=>{
 const h=await harness(t);let selected;const ui=new MediaLibraryUI(document.querySelector('#media-library'),h.schedulerManager,{storage:h.dom.window.localStorage,storageKey:'scheduler-media-test',defaultCollapsed:true,collapseTarget:'#schedule-media-body',onSelectAsset:asset=>selected=asset});assert.equal(ui.start(),true);t.after(()=>ui.destroy());
 assert.equal(document.querySelector('#schedule-media-body').hidden,true);ui.toggle.click();assert.equal(document.querySelector('#schedule-media-body').hidden,false);
 Object.defineProperty(ui.input,'files',{configurable:true,value:[new h.dom.window.File([png],'transparent.png',{type:'image/png'})]});await ui.handleFile();assert.equal(h.schedulerManager.assets.length,1);const uploaded=h.schedulerManager.assets[0];
 await h.controlManager.refresh();assert.equal(h.controlManager.getAsset(uploaded.id).url,uploaded.url);assert.ok(ui.list.querySelector('img'));[...ui.list.querySelectorAll('button')].find(b=>b.textContent==='USA COME SPONSOR').click();assert.equal(selected.id,uploaded.id);
 const fromControl=await h.upload(h.controlManager,fixtures[1]);await h.schedulerManager.refresh();assert.equal(h.schedulerManager.getAsset(fromControl.id).url,fromControl.url);assert.equal(ui.list.children.length,2);assert.equal(h.repo.list().length,2);assert.deepEqual(h.server.store.getCurrent().snapshot,base);
});
test('shared Media Library upload broadcasts refresh to the other open workspace without manual refresh',async t=>{
 const h=await harness(t);const oldWindow=globalThis.window;h.dom.window.BroadcastChannel=globalThis.BroadcastChannel;globalThis.window=h.dom.window;
 const firstRoot=document.querySelector('#media-library'),secondRoot=firstRoot.cloneNode(true);document.body.append(secondRoot);
 const schedulerUI=new MediaLibraryUI(firstRoot,h.schedulerManager,{storage:null});const controlUI=new MediaLibraryUI(secondRoot,h.controlManager,{storage:null});schedulerUI.start();controlUI.start();
 t.after(()=>{schedulerUI.destroy();controlUI.destroy();if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;});
 const until=async predicate=>{const end=Date.now()+2000;while(!predicate()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate());};
 for(const [sender,receiver,count] of [[schedulerUI,h.controlManager,1],[controlUI,h.schedulerManager,2]]){
  Object.defineProperty(sender.input,'files',{configurable:true,value:[new h.dom.window.File([png],'shared.png',{type:'image/png'})]});await sender.handleFile();await until(()=>receiver.assets.length===count);
 }
 assert.deepEqual(h.schedulerManager.assets.map(a=>a.id),h.controlManager.assets.map(a=>a.id));
});

// Fullscreen extends the same scheduled Sponsor slot and renderer.
for(const fit of ['CONTAIN','COVER'])for(const kind of ['media','audio','hls'])test('fullscreen '+fit+' retains '+kind+' on Control/Public/OBS and late join',async t=>{
 const h=await harness(t),asset=await h.upload(h.schedulerManager);const source=kind==='audio'?{id:'video-a',kind:'audio',audioUrl:'http://example.test/audio.mp3'}:{...base.source,kind};assert.equal(h.publish({source,revision:2}).accepted,true);
 const event=h.sponsor(asset.id);event.payload={assetId:asset.id,layout:'FULLSCREEN',fit,opacity:0.75};await h.request('POST','/api/studio/schedule/events',event);await h.request('POST','/api/studio/schedule/events',h.crawl);
 const ingress=h.server.store.getCurrent();h.tick(2000);const snapshot=(await h.retained()).snapshot;assert.equal(snapshot.overlays.sponsor.layout,'FULLSCREEN');assert.deepEqual(snapshot.source,source);
 const root=document.createElement('div'),preview=document.createElement('div');preview.textContent='Preview unchanged';
 const layer=new StudioGraphicsLayer({root,consumer:'program',graphicsManager:{subscribe:()=>()=>{},getVisibleGraphics:()=>[]}});layer.start();layer.crawlView.now=h.now;layer.sponsorView.now=h.now;layer.setEffectiveOverlays(snapshot.overlays);t.after(()=>layer.destroy());
 const crawl=layer.crawlView.element,timer=layer.crawlView.timer;assert.equal(layer.sponsorView.element.style.width,'100%');assert.equal(layer.sponsorView.element.style.height,'100%');assert.equal(layer.sponsorView.element.style.objectFit,fit.toLowerCase());assert.equal(layer.sponsorView.element.style.zIndex,'5');assert.equal(layer.sponsorView.element.style.opacity,'0.75');
 for(const outputMode of ['public','obs']){
  const root=document.createElement('div');root.innerHTML='<div data-public-base></div><div data-public-graphics></div>';const viewer=new PublicProgramController({root,outputMode,now:h.now});viewer.current={snapshot:{...base,source}};const surface=viewer.current;
  viewer.scheduleStaleState=()=>{};viewer.renderSnapshot=()=>assert.fail('Program player recreated');viewer.reconcilePlayback=()=>assert.fail('Program audio/playback changed');viewer.handleSnapshot(snapshot,{livePublisher:true});
  assert.equal(viewer.current,surface);assert.equal(viewer.sponsorView.element.style.objectFit,fit.toLowerCase());assert.equal(viewer.sponsorView.element.parentNode.style.zIndex,'5');
  // A fresh subscriber receives the active fullscreen layer in the retained SSE.
  const late=(await h.retained()).snapshot;assert.equal(late.overlays.sponsor.layout,'FULLSCREEN');
  const lateRoot=document.createElement('div');lateRoot.innerHTML='<div data-public-base></div><div data-public-graphics></div>';const lateViewer=new PublicProgramController({root:lateRoot,outputMode,now:h.now});lateViewer.renderOverlays(late.overlays);assert.equal(lateRoot.querySelector('.scheduled-sponsor').style.width,'100%');lateViewer.sponsorView.destroy();lateViewer.crawlView.destroy();
  h.tick(11000);const ended=(await h.retained()).snapshot;viewer.handleSnapshot(ended,{livePublisher:true});assert.equal(viewer.current,surface);assert.equal(viewer.sponsorView.element,null);viewer.sponsorView.destroy();viewer.crawlView.destroy();h.tick(2000);
 }
 h.tick(11000);layer.setEffectiveOverlays((await h.retained()).snapshot.overlays);assert.equal(layer.crawlView.element,crawl);assert.equal(layer.crawlView.timer,timer);assert.equal(layer.sponsorView.element,null);assert.equal(preview.textContent,'Preview unchanged');assert.deepEqual(h.server.store.getCurrent(),ingress);
});
for(const state of ['ENTRY','LOSS','BREAK'])test('fullscreen suppression and recovery '+state,async t=>{
 const h=await harness(t),asset=await h.upload(h.schedulerManager),event=h.sponsor(asset.id);event.payload={assetId:asset.id,layout:'FULLSCREEN',fit:'CONTAIN',opacity:1};await h.request('POST','/api/studio/schedule/events',event);h.tick(2000);
 const {AUTO_LIVE_ENTRY_ID}=await import('../public/js/program-output/AutoLiveEntrySlate.js');const {AUTO_LIVE_LOSS_SLATE_ID}=await import('../public/js/program-output/AutoLiveLossSlate.js');
 const patch=state==='ENTRY'?{scene:{id:AUTO_LIVE_ENTRY_ID,name:'Entry',type:'SLATE'},source:{id:AUTO_LIVE_ENTRY_ID,kind:'break',title:'Entry',message:'Preparing',logoUrl:'https://example.test/logo.png'}}:state==='LOSS'?{graphics:{items:[{id:AUTO_LIVE_LOSS_SLATE_ID,kind:'image',position:'top-left',url:'http://example.test/loss.png'}]}}:{scene:{id:'break',name:'Break',type:'SLATE'},source:{id:'break',kind:'break',title:'Break',message:'Break',logoUrl:'https://example.test/logo.png'}};
 assert.equal(h.publish({...patch,revision:2}).accepted,true);assert.equal((await h.retained()).snapshot.overlays.sponsor.enabled,state==='BREAK');assert.equal(h.publish({revision:3}).accepted,true);const restored=(await h.retained()).snapshot.overlays.sponsor;assert.equal(restored.enabled,true);assert.equal(restored.scheduled.startAt,event.startAt);assert.equal(restored.scheduled.endAt,event.endAt);
});
test('fullscreen and corner share existing deterministic Sponsor priority winner',async t=>{
 const h=await harness(t),asset=await h.upload(h.schedulerManager);const corner=h.sponsor(asset.id),full={...corner,id:'fullscreen',priority:10,payload:{assetId:asset.id,layout:'FULLSCREEN',fit:'CONTAIN',opacity:1}};await h.request('POST','/api/studio/schedule/events',corner);await h.request('POST','/api/studio/schedule/events',full);h.tick(2000);assert.equal((await h.retained()).snapshot.overlays.sponsor.layout,'FULLSCREEN');await h.request('PATCH','/api/studio/schedule/events/sponsor',{priority:20});assert.equal((await h.retained()).snapshot.overlays.sponsor.layout,'CORNER');
});
test('fullscreen persisted future active expired references remain protected',async t=>{
 const h=await harness(t),asset=await h.upload(h.schedulerManager),event=h.sponsor(asset.id);event.payload={assetId:asset.id,layout:'FULLSCREEN',fit:'CONTAIN',opacity:1};await h.request('POST','/api/studio/schedule/events',event);
 for(const time of [0,2000,11000]){h.tick(time);const audit=await h.server.assetReferences.inspect(asset);assert.ok(audit.referenceCount>0);assert.equal(audit.eligible,false);}
});
