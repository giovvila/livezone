import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {createProgramOutputServer} from '../test-support/ReferenceAuthorityTestServer.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
import MediaAssetRepository from '../server/media-library/MediaAssetRepository.js';
import ReferenceClient from '../public/js/studio/ReferenceClient.js';
import StudioReferenceAuthority from '../public/js/studio/StudioReferenceAuthority.js';
import ChannelLogoReferenceClient from '../public/js/studio/ChannelLogoReferenceClient.js';
import PreviewOwnershipClient from '../public/js/studio/PreviewOwnershipClient.js';
import MediaLibraryClient from '../public/js/media-library/MediaLibraryClient.js';
import MediaLibraryManager from '../public/js/media-library/MediaLibraryManager.js';
import MediaLibraryUI from '../public/js/ui/MediaLibraryUI.js';
import StudioMediaUI from '../public/js/ui/StudioMediaUI.js';
import {operatorFetch,requireOperatorSession,setReferenceClientHeaders} from '../public/js/auth/OperatorSessionClient.js';
import {REFERENCE_AUTHORITY_CHANGED,isReferenceAuthorityMutation,notifyReferenceAuthorityChanged} from '../public/js/media-library/ReferenceAuthorityNotifications.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';

const markup='<section><input id="media-library-input"><select id="media-library-filter"><option value="">ALL</option></select><ul id="media-library-list"></ul><p id="media-library-status"></p><button id="media-library-toggle"></button></section>';
const settle=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.ok(predicate(),'projection did not converge');};
async function harness(t,role='CONTROL'){
    const root=await mkdtemp(join(tmpdir(),'lz-convergence-')),repo=new MediaAssetRepository({root:join(root,'media')});await repo.initialize();

    const auth=new OperatorAuth({username:'operator',password:'convergence-test-password',secureCookie:false}),session=auth.authenticate('operator','convergence-test-password');
    const owner=createProgramOutputServer({operatorAuth:auth,publisherToken:'convergence-test-publisher',mediaAssetRepository:repo,studioStatePath:join(root,'studio.json'),schedulePath:join(root,'schedule.json')});
    await new Promise(r=>owner.server.listen(0,'127.0.0.1',r));await owner.scheduler.ready;const base='http://127.0.0.1:'+owner.server.address().port;
    await fetch(base+'/readyz');
    const temp=join(repo.tempRoot,'image');await writeFile(temp,Buffer.from([137,80,78,71,13,10,26,10]));const asset=await repo.importTempFile({tempPath:temp,originalName:'test.png',mimeType:'image/png',size:8});
    const dom=new JSDOM(markup,{url:base+'/control/'}),prior={window:globalThis.window,document:globalThis.document,location:globalThis.location,fetch:globalThis.fetch};
    t.after(async()=>{Object.assign(globalThis,prior);dom.window.close();await new Promise(r=>{owner.server.closeAllConnections();owner.server.close(r);});});
    Object.assign(globalThis,{window:dom.window,document:dom.window.document,location:dom.window.location});
    const requests=[];globalThis.fetch=(url,options={})=>{const target=new URL(url,base),headers=new Headers(options.headers);headers.set('Cookie',auth.createCookie(session).split(';')[0]);headers.set('Origin',base);requests.push({path:target.pathname,method:options.method||'GET'});return prior.fetch(target,{...options,headers});};
    setReferenceClientHeaders(null);await requireOperatorSession();const client=new ReferenceClient({role,storage:null});await client.initialize();
    const catalog={sources:new Map(),definitions:new Map(),serializeSource:value=>value,loadOverlay:()=>({issues:[]})};
    const authority=new StudioReferenceAuthority({catalog,client}),logos=new ChannelLogoReferenceClient();
    const ownership={assets:[],complete:true,ownerLabel:'Empty Preview'},preview=new PreviewOwnershipClient({getOwnership:()=>ownership,storage:null});
    const manager=new MediaLibraryManager(new MediaLibraryClient());await manager.initialize();
    const uis=[];const mount=()=>{const section=document.createElement('div');section.innerHTML=markup;document.body.append(section);const ui=new MediaLibraryUI(section,manager,{storage:null});uis.push(ui);ui.start();return ui;};
    const date='2026-09-14T10:00:00.000Z',envelope=createProgramOutputEnvelope({version:1,revision:1,publisherSessionId:'fixture',publishedAt:date,committedAt:date,scene:null,source:null,playback:{initialTime:0,duration:null,playing:false,ended:false,state:'ready',startedAt:date},graphics:{items:[]},transition:{type:'cut',durationMs:0}});owner.store.accept(envelope);
    const complete=async()=>{await client.updateLegacy({assets:[],complete:true}).then(result=>client.confirmLegacy(result.legacy.revision));assert.equal(await authority.initialize(),true);if(role==='CONTROL'){assert.equal(await logos.initialize({preview:null,program:null}),true);await preview.start();}};
    const request=async(path,method='GET',body)=>{const r=await operatorFetch(path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
    t.after(async()=>{uis.forEach(ui=>ui.destroy());preview.stopped=true;clearTimeout(preview.timer);await settle(()=>uis.every(ui=>!ui.authorityRefreshing));setReferenceClientHeaders(null);Object.assign(globalThis,prior);dom.window.close();await new Promise(r=>{owner.server.closeAllConnections();owner.server.close(r);});await rm(root,{recursive:true,force:true});});
    return {owner,client,authority,logos,preview,ownership,manager,mount,complete,asset,request,requests,catalog,dom};
}

for(const role of ['CONTROL','SCHEDULER'])test(role+' real current handshake and UI convergence after boot acknowledgements',async t=>{
    const h=await harness(t,role),ui=h.mount();await settle(()=>!ui.authorityRefreshing);assert.match(ui.authorityStatus.textContent,/INCOMPLETE/);
    await h.complete();await settle(()=>ui.authorityStatus.textContent==='REFERENCE CHECK COMPLETE');assert.equal(h.owner.referenceClients.snapshot().clients[0].state,'CURRENT_CAPABLE');
    assert.equal(h.requests.some(r=>r.method==='DELETE'),false);
});
test('UI mounted after authority boot discards the pre-adoption cached audit',async t=>{const h=await harness(t);assert.equal(h.manager.inventory.state,'INCOMPLETE');await h.complete();const ui=h.mount();await settle(()=>ui.authorityStatus.textContent==='REFERENCE CHECK COMPLETE');});
test('logo with no pending change confirms both consumers',async t=>{const h=await harness(t);await h.complete();for(const name of ['preview','program']){const {body}=await h.request('/api/media-library/channel-logo/'+name);assert.equal(body.logo.pending,false);}});
test('stale pending empty logo is reconciled by acknowledged current initialization',async t=>{const h=await harness(t);await h.request('/api/media-library/channel-logo/preview','PUT',{revision:0,asset:null});assert.equal(await h.logos.initialize({preview:null,program:null}),true);assert.equal((await h.request('/api/media-library/channel-logo/preview')).body.logo.pending,false);});
test('equal local/server logo does not remain pending',async t=>{const h=await harness(t);await h.complete();assert.equal(await h.logos.initialize({preview:null,program:null}),true);assert.equal((await h.request('/api/media-library/reference-inventory')).body.inventory.state,'COMPLETE');});
test('stale logo revision yields explicit conflict and cannot apply locally',async t=>{const h=await harness(t);await h.complete();await h.request('/api/media-library/channel-logo/preview','PUT',{revision:1,asset:null});let applied=false;await assert.rejects(h.logos.execute('preview',null,()=>{applied=true;}),{code:'REVISION_CONFLICT'});assert.equal(applied,false);});
test('Preview media references are acknowledged on production ownership route',async t=>{const h=await harness(t);h.ownership.assets=[h.asset.id];await h.complete();assert.equal(h.preview.available,true);assert.equal(h.owner.previewOwnership.snapshot().references[0].assetId,h.asset.id);});
test('Preview known empty is explicitly confirmed without an asset ID',async t=>{const h=await harness(t);await h.complete();assert.deepEqual(h.owner.previewOwnership.snapshot(),{complete:true,references:[]});});
test('transport unavailable presentation does not imply unknown ownership',async t=>{const h=await harness(t);const ui={started:true,name:{},time:{},state:{},setButtonsDisabled:()=>{}};StudioMediaUI.prototype.renderUnavailable.call(ui);assert.equal(ui.state.textContent,'UNAVAILABLE');await h.complete();assert.equal(h.owner.previewOwnership.snapshot().complete,true);});
test('Control boot publishes ownership even for empty Preview',async t=>{const h=await harness(t);await h.complete();assert.ok(h.requests.some(r=>r.path==='/api/media-library/preview-ownership'&&r.method==='POST'));assert.ok(h.requests.some(r=>r.path.startsWith('/api/media-library/preview-ownership/')&&r.method==='PUT'));});
test('Preview acknowledgement updates availability',async t=>{const h=await harness(t);await h.complete();assert.equal(h.preview.available,true);h.ownership.complete=false;await h.preview.report();assert.equal(h.preview.available,false);});
test('equal catalog reconciliation remains confirmed without advancing revision',async t=>{const h=await harness(t);await h.complete();const revision=h.owner.studioStateCoordinator.getSnapshot().revision;assert.equal(await h.authority.initialize(),true);assert.equal(h.owner.studioStateCoordinator.getSnapshot().revision,revision);assert.equal([...h.owner.referenceClients.clients.values()][0].catalog,'RECONCILED');});
test('valid legacy canonical source is safely imported',async t=>{const h=await harness(t);h.catalog.sources.set('image',{id:'image',name:'Image',kind:'image',assetId:h.asset.id});await h.complete();assert.equal(h.owner.studioStateCoordinator.getSnapshot().sources[0].assetId,h.asset.id);});
test('no-op catalog confirmation closes the current registration pending state',async t=>{const h=await harness(t);assert.equal([...h.owner.referenceClients.clients.values()][0].catalog,'PENDING');await h.authority.initialize();assert.equal([...h.owner.referenceClients.clients.values()][0].catalog,'RECONCILED');});
test('catalog conflict remains incomplete and preserves authoritative record',async t=>{const h=await harness(t);h.catalog.sources.set('image',{id:'image',name:'Original',kind:'image',assetId:h.asset.id});await h.complete();h.catalog.sources.set('image',{id:'image',name:'Conflicting',kind:'image',assetId:h.asset.id});assert.equal(await h.authority.initialize(),false);assert.equal(h.authority.issue,'CATALOG_AUTHORITY_CONFLICT');assert.equal(h.owner.studioStateCoordinator.getSnapshot().sources[0].name,'Original');assert.equal((await h.request('/api/media-library/reference-inventory')).body.inventory.state,'INCOMPLETE');});
for(const component of ['logo','preview','catalog'])test('live completeness refresh follows '+component+' confirmation',async t=>{
    const h=await harness(t);await h.complete();const ui=h.mount();await settle(()=>ui.authorityStatus.textContent==='REFERENCE CHECK COMPLETE');
    if(component==='logo'){await h.request('/api/media-library/channel-logo/preview','PUT',{revision:1,asset:null});}
    if(component==='preview'){h.ownership.complete=false;await h.preview.report();}
    if(component==='catalog')await h.client.reportInvalid();
    await settle(()=>ui.authorityStatus.textContent.includes('INCOMPLETE'));
    if(component==='logo')await h.request('/api/media-library/channel-logo/preview','POST',{revision:2});
    if(component==='preview'){h.ownership.complete=true;await h.preview.report();}
    if(component==='catalog')await h.authority.initialize();
    await settle(()=>ui.authorityStatus.textContent==='REFERENCE CHECK COMPLETE');
});
test('DELETE UI stays absent until COMPLETE then displays asset eligibility without deletion',async t=>{const h=await harness(t),ui=h.mount();await settle(()=>!ui.authorityRefreshing);assert.equal(ui.list.querySelector('.media-library-item__delete'),null);await h.complete();await settle(()=>!!ui.list.querySelector('.media-library-item__delete'));assert.equal(h.manager.audits[h.asset.id].eligible,true);assert.equal(h.requests.some(r=>r.method==='DELETE'),false);});
test('authority reconciliation does not mutate retained Program',async t=>{const h=await harness(t),before=h.owner.store.getCurrent();await h.complete();h.mount();notifyReferenceAuthorityChanged();assert.equal(h.owner.store.getCurrent(),before);});
test('authority projection refresh never changes the provided Preview state',async t=>{const h=await harness(t),before=structuredClone(h.ownership);await h.complete();const ui=h.mount();await settle(()=>!ui.authorityRefreshing);assert.deepEqual(h.ownership,before);});
test('GET audits and unrelated commands cannot create notification loops',()=>{assert.equal(isReferenceAuthorityMutation('/api/media-library/assets','GET'),false);assert.equal(isReferenceAuthorityMutation('/api/program-output','POST'),false);assert.equal(isReferenceAuthorityMutation('/api/studio/state/catalog/reconcile','POST'),true);});
test('authority invalidation contains no payload and UI unsubscribes on destruction',async t=>{const h=await harness(t),ui=h.mount();await settle(()=>!ui.authorityRefreshing);let observed;window.addEventListener(REFERENCE_AUTHORITY_CHANGED,event=>{observed=event;},{once:true});ui.destroy();const count=h.requests.length;notifyReferenceAuthorityChanged();await new Promise(r=>setTimeout(r,10));assert.equal(observed.detail,undefined);assert.equal(h.requests.length,count);});
test('authority changes during a slow refresh are coalesced and re-read after it',async()=>{
    let release,calls=0;const gate=new Promise(r=>{release=r;});const ui={started:true,manager:{refresh:async()=>{calls++;if(calls===1)await gate;}}};
    const first=MediaLibraryUI.prototype.refreshAuthority.call(ui);await MediaLibraryUI.prototype.refreshAuthority.call(ui);await MediaLibraryUI.prototype.refreshAuthority.call(ui);release();await first;assert.equal(calls,2);
});

test('Scheduler in another document refreshes from Control authority broadcast',async t=>{
    const h=await harness(t);await h.complete();
    const peers=new Set();class Channel{constructor(){peers.add(this);}postMessage(data){for(const peer of peers)if(peer!==this)peer.onmessage?.({data});}close(){peers.delete(this);}}
    window.BroadcastChannel=Channel;
    const other=new JSDOM(markup,{url:location.origin+'/control/schedule/'}),manager=new MediaLibraryManager(new MediaLibraryClient());
    const ui=new MediaLibraryUI(other.window.document.querySelector('section'),manager,{storage:null});
    try{ui.start();await settle(()=>ui.authorityStatus.textContent==='REFERENCE CHECK COMPLETE');
        await h.client.reportInvalid();await settle(()=>ui.authorityStatus.textContent.includes('INCOMPLETE'));
        await h.authority.initialize();await settle(()=>ui.authorityStatus.textContent==='REFERENCE CHECK COMPLETE');
    }finally{ui.destroy();await settle(()=>!ui.authorityRefreshing);other.window.close();delete window.BroadcastChannel;}
});
