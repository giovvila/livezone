import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, rename, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MediaAssetRepository from '../server/media-library/MediaAssetRepository.js';
import AssetMutationCoordinator from '../server/media-library/AssetMutationCoordinator.js';
import AssetReferenceInventory from '../server/media-library/AssetReferenceInventory.js';
import PreviewOwnership from '../server/media-library/PreviewOwnership.js';
import AuthoritativeStateRepository from '../server/studio/AuthoritativeStateRepository.js';
import StudioStateCoordinator from '../server/studio/StudioStateCoordinator.js';
import ScheduleStore from '../server/scheduler/ScheduleStore.js';
import StudioCatalogManager from '../public/js/studio/StudioCatalogManager.js';
import StudioReferenceAuthority from '../public/js/studio/StudioReferenceAuthority.js';
import PreviewOwnershipClient from '../public/js/studio/PreviewOwnershipClient.js';
import { JSDOM } from 'jsdom';
import MediaLibraryUI from '../public/js/ui/MediaLibraryUI.js';
import MediaLibraryManager from '../public/js/media-library/MediaLibraryManager.js';
import { createProgramOutputServer } from '../test-support/ReferenceAuthorityTestServer.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';

const stamp = n => new Date(n).toISOString();
const sponsor = (assetId, patch = {}) => ({ id: 'sponsor', version: 1, type: 'overlay.sponsor', name: 'Sponsor Estate',
    enabled: true, startAt: stamp(1000), endAt: stamp(10000), priority: 1,
    payload: { assetId, position: 'top-right', sizePercent: 12, opacity: 1 }, ...patch });
const imageSource = assetId => ({ id: 'source', kind: 'image', name: 'Test image', assetId });
const scene = { id: 'scene', name: 'Scene News', type: 'IMAGE', renderer: { kind: 'source', sourceId: 'source' } };
const media = {
    image: ['png', 'image/png', Buffer.from([137,80,78,71,13,10,26,10])],
    video: ['mp4', 'video/mp4', Buffer.from([0,0,0,0,102,116,121,112,105,115,111,109])],
    audio: ['mp3', 'audio/mpeg', Buffer.from('ID3audio')]
};
async function harness(t) {
    const root = await mkdtemp(join(tmpdir(), 'lz-reference-authority-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = new MediaAssetRepository({ root: join(root, 'media') }); await repo.initialize();
    const mutations = new AssetMutationCoordinator(); repo.mutationCoordinator = mutations;
    const studio = new StudioStateCoordinator({ repository: new AuthoritativeStateRepository({ path: join(root, 'studio.json') }) });
    await studio.initialize(); studio.mutationCoordinator = mutations;
    const schedule = new ScheduleStore({ path: join(root, 'schedule.json') }); await schedule.initialize(); schedule.mutationCoordinator = mutations;
    const runtime = { program: {scene:null,source:null}, extra: [], complete: true, now: 0 };
    const preview = new PreviewOwnership({ coordinator: mutations, clock: () => runtime.now,
        validate: value => inventory.validate(value) });
    const inventory = new AssetReferenceInventory({ repository: repo, preview, inventories: () => [
        { name: 'Studio', complete: runtime.complete, data: studio.getSnapshot() },
        { name: 'Schedule', complete: true, data: schedule.getSnapshot() },
        { name: 'PROGRAM', classification: 'RUNTIME', complete: true, data: runtime.program },
        { name: 'CHANNEL LOGO', complete: true, data: runtime.extra }
    ] });
    studio.referenceValidator = value => inventory.validate(value);
    schedule.referenceValidator = value => inventory.validate(value);
    const upload = async (kind = 'image') => {
        const [extension, mimeType, bytes] = media[kind], tempPath = join(repo.tempRoot, 'upload.tmp');
        await writeFile(tempPath, bytes);
        return repo.importTempFile({ tempPath, originalName: `test.${extension}`, mimeType, size: bytes.length });
    };
    const remove = id => repo.delete(id, { isReferenced: async asset => {
        const audit = await inventory.inspect(asset);
        if (!audit.eligible) throw Object.assign(new Error('blocked'), { code: audit.referenceCount ? 'ASSET_REFERENCED' : 'REFERENCE_AUDIT_UNAVAILABLE' });
        return false;
    } });
    const catalog = (sources, scenes = []) => studio.updateCatalog({ sources, scenes, revision: studio.getSnapshot().revision });
    return { root, repo, mutations, studio, schedule, runtime, preview, inventory, upload, remove, catalog };
}

for (const kind of ['image','video','audio']) test(`complete inventory permits unused ${kind} file and metadata removal`, async t => {
    const h = await harness(t), asset = await h.upload(kind);
    assert.equal((await h.inventory.inspect(asset)).status, 'UNUSED');
    await h.remove(asset.id); assert.equal(h.repo.get(asset.id), null);
    await assert.rejects(stat(h.repo.safeFilePath(asset.kind, asset.storedName)), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(h.repo.manifestPath)).assets, []);
});

for (const [name, kind, source] of [
    ['VIDEO', 'video', id => ({ id:'source', name:'Video', kind:'media', assetId:id })],
    ['IMAGE', 'image', imageSource],
    ['AUDIO', 'audio', id => ({ id:'source', name:'Audio', kind:'audio', audioAssetId:id })]
]) test(`${name} canonical reference blocks deletion`, async t => {
    const h = await harness(t), asset = await h.upload(kind);
    await h.catalog([source(asset.id)]);
    const audit = await h.inventory.inspect(asset);
    assert.equal(audit.status, 'USED'); assert.equal(audit.references[0].classification, 'PERSISTED');
    assert.equal(audit.references[0].ownerId, 'source'); await assert.rejects(h.remove(asset.id), { code:'ASSET_REFERENCED' });
});
for (const [field, kind] of [['stillAssetId','image'],['motionAssetId','video']]) test(`AUDIO ${field} protects artwork`, async t => {
    const h = await harness(t), audio = await h.upload('audio'), asset = await h.upload(kind);
    await h.catalog([{ id:'source', name:'Radio One', kind:'audio', audioAssetId:audio.id, [field]:asset.id }]);
    await assert.rejects(h.remove(asset.id), { code:'ASSET_REFERENCED' });
});
for (const [period, patch] of [['future',{startAt:stamp(90000),endAt:stamp(100000)}],['active',{}],
    ['expired',{startAt:stamp(0),endAt:stamp(1)}],['disabled',{enabled:false}]]) test(`${period} persisted Sponsor remains protective`, async t => {
    const h = await harness(t), asset = await h.upload();
    assert.equal((await h.schedule.insert(sponsor(asset.id,patch),0)).ok,true);
    const audit = await h.inventory.inspect(asset);
    assert.ok(audit.references.some(ref=>ref.kind==='SCHEDULE EVENT'&&ref.ownerLabel==='Sponsor Estate'));
    await assert.rejects(h.remove(asset.id), {code:'ASSET_REFERENCED'});
});
test('scene reachability includes useful scene owner and multiple references', async t => {
    const h=await harness(t),a=await h.upload(); await h.catalog([imageSource(a.id)],[scene]);
    await h.schedule.insert(sponsor(a.id),0);
    const audit=await h.inventory.inspect(a);
    assert.ok(audit.references.some(ref=>ref.ownerLabel==='Scene News'&&ref.kind==='SCENE'));
    assert.ok(audit.referenceCount>=3);
});
test('Channel Logo canonical ID assignment is protective',async t=>{
    const h=await harness(t),a=await h.upload();
    await h.mutations.run(()=>{h.inventory.validate({logoAssetId:a.id});h.runtime.extra={logoAssetId:a.id};});
    await assert.rejects(h.remove(a.id),{code:'ASSET_REFERENCED'});
});
test('retained Program URL resolves through full repository URL without protocol changes',async t=>{
    const h=await harness(t),a=await h.upload();
    h.runtime.program={source:{id:'program-source',kind:'image',url:'https://studio.example'+a.url}};
    const audit=await h.inventory.inspect(a);assert.equal(audit.status,'USED');
    assert.equal(audit.references[0].classification,'RUNTIME');
    await assert.rejects(h.remove(a.id),{code:'ASSET_REFERENCED'});
});
test('no basename identity and unknown managed URL makes inventory incomplete',async t=>{
    const h=await harness(t),a=await h.upload();h.runtime.extra={url:'https://external.example/'+a.storedName};
    assert.equal((await h.inventory.inspect(a)).status,'UNUSED');
    h.runtime.extra={url:'/media-library/files/image/not-in-manifest.png'};
    assert.equal((await h.inventory.inspect(a)).status,'UNKNOWN');
});
test('encoded URL accepted by the file route still resolves to the canonical asset ID',async t=>{
    const h=await harness(t),a=await h.upload();
    h.runtime.program={source:{kind:'image',url:'https://studio.example'+a.url.replace('/media-library/','/%6dedia-library/')}};
    assert.equal((await h.inventory.inspect(a)).status,'USED');await assert.rejects(h.remove(a.id),{code:'ASSET_REFERENCED'});
});
test('metadata aliases cannot delete a managed file owned by another asset',async t=>{
    const h=await harness(t),a=await h.upload(),id='asset-00000000-0000-4000-8000-000000000099';
    h.repo.assets.set(id,{...a,id});await assert.rejects(h.remove(a.id),{code:'FILE_OWNERSHIP_CONFLICT'});
    assert.ok(h.repo.get(a.id));assert.ok(await stat(h.repo.safeFilePath(a.kind,a.storedName)));
});
test('crawl text and lower-third text cannot invent asset ownership',async t=>{
    const h=await harness(t),a=await h.upload();h.runtime.extra={text:a.id,title:a.id,subtitle:a.id};
    assert.equal((await h.inventory.inspect(a)).status,'UNUSED');
});
test('incomplete inventory never classifies asset UNUSED',async t=>{
    const h=await harness(t),a=await h.upload();h.runtime.complete=false;
    assert.equal((await h.inventory.inspect(a)).status,'UNKNOWN');await assert.rejects(h.remove(a.id),{code:'REFERENCE_AUDIT_UNAVAILABLE'});
});

// Both orders are explicit, without timeouts or sleep-based race assumptions.
for (const kind of ['source-create','source-update','sponsor-create','channel-logo']) {
    test(`${kind} wins coordination before DELETE; final check blocks`,async t=>{
        const h=await harness(t),a=await h.upload();
        if(kind==='source-update')await h.catalog([{id:'source',kind:'image',name:'Old',url:'https://external.example/old.png'}]);
        assert.equal((await h.inventory.inspect(a)).eligible,true);
        const creation=kind==='sponsor-create'?h.schedule.insert(sponsor(a.id),0):kind==='channel-logo'?
            h.mutations.run(()=>{h.inventory.validate({logoAssetId:a.id});h.runtime.extra={logoAssetId:a.id};}):h.catalog([imageSource(a.id)]);
        const deletion=h.remove(a.id);
        const results=await Promise.allSettled([creation,deletion]);
        assert.equal(results[0].status,'fulfilled');if(kind==='sponsor-create')assert.equal(results[0].value.ok,true);
        assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.code,'ASSET_REFERENCED');assert.ok(h.repo.get(a.id));
    });
    test(`DELETE wins before ${kind}; no broken reference commits`,async t=>{
        const h=await harness(t),a=await h.upload();await h.remove(a.id);
        if(kind==='sponsor-create')assert.equal((await h.schedule.insert(sponsor(a.id),0)).code,'ASSET_UNAVAILABLE');
        else if(kind==='channel-logo')await assert.rejects(h.mutations.run(()=>h.inventory.validate({logoAssetId:a.id})),{code:'ASSET_UNAVAILABLE'});
        else await assert.rejects(h.catalog([imageSource(a.id)]),{code:'ASSET_UNAVAILABLE'});
        assert.equal(h.studio.getSnapshot().sources.length,0);assert.equal(h.schedule.listEvents().length,0);
    });
}
test('Preview arrives after confirmation audit but before final recheck',async t=>{
    const h=await harness(t),a=await h.upload();assert.equal((await h.inventory.inspect(a)).eligible,true);
    const s=await h.preview.open('operator');await h.preview.update(s.sessionId,'operator',{sequence:1,assets:[a.id]});
    await assert.rejects(h.remove(a.id),{code:'ASSET_REFERENCED'});
});
test('Program arrives before final recheck and blocks deletion',async t=>{
    const h=await harness(t),a=await h.upload();assert.equal((await h.inventory.inspect(a)).eligible,true);
    await h.mutations.run(()=>{h.inventory.validate({assetId:a.id});h.runtime.program={assetId:a.id};});
    await assert.rejects(h.remove(a.id),{code:'ASSET_REFERENCED'});
});
test('duplicate concurrent DELETE is bounded with one success and one not-found',async t=>{
    const h=await harness(t),a=await h.upload();const results=await Promise.allSettled([h.remove(a.id),h.remove(a.id)]);
    assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected']);assert.equal(results[1].reason.code,'ASSET_NOT_FOUND');
});
test('reference creation cannot pass while delete is quarantined',async t=>{
    const h=await harness(t),a=await h.upload();let release,entered;
    const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r),original=h.repo.writeManifest.bind(h.repo);
    h.repo.writeManifest=async()=>{entered();await gate;await original();};
    const deletion=h.remove(a.id);await reached;
    let completed=false;const creation=h.schedule.insert(sponsor(a.id),0).then(result=>{completed=true;return result;});
    await new Promise(r=>setImmediate(r));assert.equal(completed,false);release();
    await deletion;assert.equal((await creation).code,'ASSET_UNAVAILABLE');
});
test('type mismatch prevents source and sponsor persistence',async t=>{
    const h=await harness(t),audio=await h.upload('audio');
    await assert.rejects(h.catalog([imageSource(audio.id)]),{code:'ASSET_TYPE_MISMATCH'});
    assert.equal((await h.schedule.insert(sponsor(audio.id),0)).code,'ASSET_TYPE_MISMATCH');
});
test('catalog CAS rejects stale client without losing existing references',async t=>{
    const h=await harness(t),a=await h.upload();await h.catalog([imageSource(a.id)]);
    await assert.rejects(h.studio.updateCatalog({sources:[],scenes:[],revision:0}),{code:'REVISION_CONFLICT'});
    assert.equal((await h.inventory.inspect(a)).status,'USED');
});

test('unconfirmed Preview session makes inventory UNKNOWN',async t=>{
    const h=await harness(t),a=await h.upload();await h.preview.open('operator');
    assert.equal((await h.inventory.inspect(a)).status,'UNKNOWN');
});
test('Preview change releases previous ownership',async t=>{
    const h=await harness(t),a=await h.upload(),b=await h.upload(),s=await h.preview.open('operator');
    await h.preview.update(s.sessionId,'operator',{sequence:1,assets:[a.id]});
    await h.preview.update(s.sessionId,'operator',{sequence:2,assets:[b.id]});
    assert.equal((await h.inventory.inspect(a)).status,'UNUSED');assert.equal((await h.inventory.inspect(b)).status,'USED');
});
for(const close of [true,false])test(`Preview ${close?'explicit close releases':'lease expiry retains uncertain'} ownership`,async t=>{
    const h=await harness(t),a=await h.upload(),s=await h.preview.open('operator');
    await h.preview.update(s.sessionId,'operator',{sequence:1,assets:[a.id]});
    if(close)await h.preview.close(s.sessionId,'operator');else h.runtime.now=30001;
    assert.equal((await h.inventory.inspect(a)).status,close?'UNUSED':'UNKNOWN');
    if(!close){assert.equal((await h.inventory.inspect(a)).referenceCount,1);await h.preview.close(s.sessionId,'operator');}
    await assert.rejects(h.preview.update(s.sessionId,'operator',{sequence:99,assets:[]}),{code:'OWNERSHIP_SESSION_EXPIRED'});
});
test('multiple Control sessions protect the union; stale sequence and wrong principal rejected',async t=>{
    const h=await harness(t),a=await h.upload(),b=await h.upload(),s1=await h.preview.open('one'),s2=await h.preview.open('two');
    await h.preview.update(s1.sessionId,'one',{sequence:2,assets:[a.id]});
    await h.preview.update(s2.sessionId,'two',{sequence:1,assets:[b.id]});
    await assert.rejects(h.preview.update(s1.sessionId,'one',{sequence:1,assets:[]}),{code:'OWNERSHIP_STALE_UPDATE'});
    await assert.rejects(h.preview.update(s1.sessionId,'two',{sequence:3,assets:[]}),{code:'OWNERSHIP_SESSION_EXPIRED'});
    assert.equal((await h.inventory.inspect(a)).status,'USED');assert.equal((await h.inventory.inspect(b)).status,'USED');
});
test('unavailable Preview service fails closed',async t=>{
    const h=await harness(t),a=await h.upload();h.preview.available=false;
    await assert.rejects(h.remove(a.id),{code:'REFERENCE_AUDIT_UNAVAILABLE'});
});
test('uncertain Preview report retains protection and marks the inventory UNKNOWN',async t=>{
    const h=await harness(t),a=await h.upload(),s=await h.preview.open('operator');
    await h.preview.update(s.sessionId,'operator',{sequence:1,assets:[a.id]});
    await h.preview.update(s.sessionId,'operator',{sequence:2,assets:[],complete:false});
    const audit=await h.inventory.inspect(a);assert.equal(audit.status,'UNKNOWN');assert.equal(audit.referenceCount,1);
    await h.preview.update(s.sessionId,'operator',{sequence:3,assets:[],complete:true});
    assert.equal((await h.inventory.inspect(a)).status,'UNUSED');
});

for(const phase of ['journal','quarantined','metadata','unlinked'])test(`fresh repository recovers interrupted delete at ${phase}`,async t=>{
    const h=await harness(t),a=await h.upload(),q='delete-00000000-0000-4000-8000-000000000001.tmp';
    await h.repo.writeDeleteJournal({version:1,asset:a,quarantine:q});
    if(phase!=='journal')await rename(h.repo.safeFilePath(a.kind,a.storedName),join(h.repo.tempRoot,q));
    if(['metadata','unlinked'].includes(phase)){h.repo.assets.delete(a.id);await h.repo.writeManifest();}
    if(phase==='unlinked')await unlink(join(h.repo.tempRoot,q));
    const restored=new MediaAssetRepository({root:h.repo.root});await restored.initialize();
    assert.equal(!!restored.get(a.id),phase!=='unlinked');
    if(phase!=='unlinked')assert.equal((await stat(restored.safeFilePath(a.kind,a.storedName))).size,a.size);
    await assert.rejects(readFile(restored.deleteJournalPath),{code:'ENOENT'});
});
test('malformed recovery marker fails closed and preserves bytes',async t=>{
    const h=await harness(t);await writeFile(h.repo.deleteJournalPath,'bad');
    const restored=new MediaAssetRepository({root:h.repo.root});await assert.rejects(restored.initialize(),{code:'DELETE_RECOVERY_REQUIRED'});
    assert.equal(await readFile(h.repo.deleteJournalPath,'utf8'),'bad');
});
test('recovery rejects journal path traversal',async t=>{
    const h=await harness(t),a=await h.upload();await h.repo.writeDeleteJournal({version:1,asset:a,quarantine:'../../unrelated'});
    const restored=new MediaAssetRepository({root:h.repo.root});await assert.rejects(restored.initialize(),{code:'DELETE_RECOVERY_REQUIRED'});
    assert.ok(await stat(h.repo.safeFilePath(a.kind,a.storedName)));
});

function localCatalog() {
    const storage={getItem:()=>null,setItem:()=>{}};
    const state={registerScene:()=>true,unregisterScene:()=>true,replaceScene:()=>true,getPreviewSceneId:()=>null,getProgramSceneId:()=>null};
    const source={registerSource:()=>true,unregisterSource:()=>true,replaceSource:()=>true,getActiveInstances:()=>[],getSource:()=>null};
    const catalog=new StudioCatalogManager({storage,studioStateManager:state,studioSourceManager:source,eventTarget:null,
        baseUrl:'http://studio.example/',uuidFactory:()=> '00000000-0000-4000-8000-000000000010'});
    catalog.initialize();return catalog;
}
test('browser catalog commits server references before local persistence/runtime application',async()=>{
    const catalog=localCatalog();let release,entered;const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r);
    const authority=new StudioReferenceAuthority({catalog,request:async(url,options)=>{
        assert.equal(catalog.sources.size,0);entered();await gate;return {state:{revision:1,...JSON.parse(options.body)}};
    }});authority.ready=true;authority.revision=0;catalog.referenceAuthority=authority;
    const operation=catalog.addSource({kind:'image',name:'Image',url:'https://external.example/image.png'});
    await reached;assert.equal(catalog.sources.size,0);release();assert.equal((await operation).ok,true);assert.equal(catalog.sources.size,1);
});
test('server reference failure leaves browser catalog, Program and Preview untouched',async()=>{
    const catalog=localCatalog();const authority=new StudioReferenceAuthority({catalog,request:async()=>{throw Object.assign(Error(),{code:'ASSET_UNAVAILABLE'});}});
    authority.ready=true;authority.revision=0;catalog.referenceAuthority=authority;
    const result=await catalog.addSource({kind:'image',name:'Image',url:'https://external.example/image.png'});
    assert.equal(result.reason,'ASSET_UNAVAILABLE');assert.equal(catalog.sources.size,0);assert.equal(catalog.definitions.size,0);
});
test('a conflicting browser catalog is never silently overwritten during adoption',async()=>{
    const catalog=localCatalog();const authority=new StudioReferenceAuthority({catalog,request:async(url)=>{if(url.endsWith('/reconcile'))throw Object.assign(Error(),{code:'CATALOG_AUTHORITY_CONFLICT'});return {state:{initialized:true,revision:2,sources:[imageSource('asset-other')],scenes:[]}};}});
    assert.equal(await authority.initialize(),false);assert.equal(authority.issue,'CATALOG_AUTHORITY_CONFLICT');assert.equal(catalog.sources.size,0);
});
test('Preview client late callback cannot replace a newer report',async()=>{
    const resolvers=[];const client=new PreviewOwnershipClient({getOwnership:()=>({complete:true,assets:[],ownerLabel:'Preview'}),
        fetcher:()=>new Promise(resolve=>resolvers.push(resolve))});
    client.sessionId='session';const first=client.report(),second=client.report();
    resolvers[1]({ok:true,json:async()=>({ok:true})});await second;
    resolvers[0]({ok:false,json:async()=>({ok:false})});await first;
    assert.equal(client.available,true);
});

async function uiHarness(t, { conflict = false } = {}) {
    const dom = new JSDOM('<section id="library"><input id="media-library-input" type="file"><select id="media-library-filter"><option value="">ALL</option></select><ul id="media-library-list"></ul><p id="media-library-status"></p><button id="media-library-toggle"></button></section>', {url:'http://studio.example'});
    const prior = { document: globalThis.document, window: globalThis.window };
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    const base={kind:'image',mimeType:'image/png',size:8,url:'/image.png'};
    let assets=['unused','used','unknown'].map(id=>({...base,id,originalName:id+'.png'}));
    const audits={unused:{complete:true,eligible:true,referenceCount:0,references:[],unavailable:[]},
        used:{complete:true,eligible:false,referenceCount:1,references:[{type:'SCHEDULE EVENT',name:'Sponsor Estate'}],unavailable:[]},
        unknown:{complete:false,eligible:false,referenceCount:0,references:[],unavailable:['Preview ownership']}};
    let removes=0, notifications=0;
    const manager=new MediaLibraryManager({list:async()=>({assets,audits}),references:async id=>({audit:audits[id]}),
        remove:async id=>{removes++;if(conflict)throw Object.assign(Error('Conflict'),{code:'ASSET_REFERENCED',details:audits.used});
            const asset=assets.find(a=>a.id===id);assets=assets.filter(a=>a.id!==id);return {asset};}});
    const ui=new MediaLibraryUI(dom.window.document.querySelector('#library'),manager,{storage:null});ui.start();
    await manager.initialize();
    while(ui.authorityRefreshing)await new Promise(resolve=>setImmediate(resolve));
    ui.channel={postMessage:()=>notifications++,close:()=>{}};
    t.after(()=>{ui.destroy();dom.window.close();Object.assign(globalThis,prior);});
    return {ui,manager,audits,get removes(){return removes;},get notifications(){return notifications;}};
}
for(const badge of ['USED','UNUSED','UNKNOWN'])test(`shared library displays ${badge} from server completeness`,async t=>{
    const h=await uiHarness(t);assert.ok([...h.ui.list.querySelectorAll('.media-library-usage')].some(node=>node.textContent===badge));
});
test('UNUSED filter excludes USED and UNKNOWN assets',async t=>{
    const h=await uiHarness(t);h.ui.usageFilter.value='UNUSED';h.ui.handleFilter();
    assert.equal(h.ui.list.children.length,1);assert.match(h.ui.list.textContent,/unused.png/);
});
for(const id of ['used','unknown'])test(`${id} asset cannot reach enabled confirmation`,async t=>{
    const h=await uiHarness(t);await h.ui.reviewDelete(h.manager.getAsset(id));
    assert.equal([...h.ui.deleteDialog.querySelectorAll('button')].find(b=>b.textContent==='ELIMINA DEFINITIVAMENTE').disabled,true);
    assert.match(h.ui.deleteDialog.textContent,id==='used'?/Sponsor Estate/:/Preview ownership/);assert.equal(h.removes,0);
});
test('successful confirmation removes only after server success and broadcasts shared refresh',async t=>{
    const h=await uiHarness(t);await h.ui.reviewDelete(h.manager.getAsset('unused'));
    const confirm=[...h.ui.deleteDialog.querySelectorAll('button')].find(b=>b.textContent==='ELIMINA DEFINITIVAMENTE');assert.equal(confirm.disabled,false);
    confirm.click();assert.ok(h.manager.getAsset('unused'));await new Promise(r=>setImmediate(r));
    assert.equal(h.manager.getAsset('unused'),null);assert.equal(h.notifications,1);assert.equal(h.removes,1);
});
test('server conflict after confirmation retains asset and displays the new reference',async t=>{
    const h=await uiHarness(t,{conflict:true});await h.ui.reviewDelete(h.manager.getAsset('unused'));
    [...h.ui.deleteDialog.querySelectorAll('button')].find(b=>b.textContent==='ELIMINA DEFINITIVAMENTE').click();
    await new Promise(r=>setImmediate(r));assert.ok(h.manager.getAsset('unused'));assert.equal(h.notifications,0);
    assert.match(h.ui.deleteDialog.textContent,/ASSET_REFERENCED/);assert.match(h.ui.deleteDialog.textContent,/Sponsor Estate/);
});
for(const direction of ['Scheduler to Control','Control to Scheduler'])test(`shared delete notification refreshes ${direction}`,async t=>{
    const h=await uiHarness(t),peers=new Set();
    class Channel {
        constructor(){peers.add(this);}
        postMessage(data){for(const peer of peers)if(peer!==this)peer.onmessage?.({data});}
        close(){peers.delete(this);}
    }
    window.BroadcastChannel=Channel;
    h.ui.channel=new Channel();h.ui.channel.onmessage=h.ui.refresh;
    const root=h.ui.root.cloneNode(true);document.body.append(root);
    const otherManager=new MediaLibraryManager(h.manager.client),otherUI=new MediaLibraryUI(root,otherManager,{storage:null});
    otherUI.start();await otherManager.initialize();t.after(()=>otherUI.destroy());
    const origin=direction.startsWith('Scheduler')?h.ui:otherUI;
    await origin.reviewDelete(origin.manager.getAsset('unused'));
    [...origin.deleteDialog.querySelectorAll('button')].find(b=>b.textContent==='ELIMINA DEFINITIVAMENTE').click();
    await new Promise(r=>setImmediate(r));
    assert.equal(h.manager.getAsset('unused'),null);assert.equal(otherManager.getAsset('unused'),null);
    assert.ok(!h.ui.list.textContent.includes('unused.png'));assert.ok(!otherUI.list.textContent.includes('unused.png'));
});

async function httpHarness(t) {
    const h=await harness(t);
    const auth=new OperatorAuth({username:'operator',password:'test-reference-password',secureCookie:false});
    const session=auth.authenticate('operator','test-reference-password');
    const owner=createProgramOutputServer({publisherToken:'reference-test-publisher',operatorAuth:auth,
        mediaAssetRepository:h.repo,studioStatePath:join(h.root,'http-studio.json'),schedulePath:join(h.root,'http-schedule.json')});
    await new Promise(resolve=>owner.server.listen(0,'127.0.0.1',resolve));await Promise.all([owner.scheduler.ready,owner.executionOwnership.ready]);
    t.after(()=>new Promise(resolve=>owner.server.close(resolve)));
    const base='http://127.0.0.1:'+owner.server.address().port;
    const headers={Cookie:auth.createCookie(session).split(';')[0],Origin:base,'Content-Type':'application/json',
        'X-Livezone-Operator-Request':'1','X-Livezone-CSRF':session.csrfToken};
    const request=async(method,path,body,extra={})=>{
        const response=await fetch(base+path,{method,headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
        return {status:response.status,payload:await response.json()};
    };
    return {...h,owner,base,request,headers};
}
test('catalog PUT and Preview lease routes require existing operator mutation authorization',async t=>{
    const h=await httpHarness(t);
    for(const [method,path] of [['PUT','/api/studio/state/catalog'],['POST','/api/media-library/preview-ownership']]) {
        assert.equal((await fetch(h.base+path,{method})).status,401);
        assert.equal((await h.request(method,path,{}, {'X-Livezone-CSRF':'wrong'})).status,403);
    }
});
test('authenticated catalog PUT commits canonical references and rejects stale revision',async t=>{
    const h=await httpHarness(t),a=await h.upload();
    const result=await h.request('PUT','/api/studio/state/catalog',{sources:[imageSource(a.id)],scenes:[scene],revision:0});
    assert.equal(result.status,200);assert.equal(result.payload.state.revision,1);
    assert.equal((await h.request('PUT','/api/studio/state/catalog',{sources:[],scenes:[],revision:0})).status,409);
    const audit=(await h.request('GET','/api/media-library/assets/'+a.id+'/references')).payload.audit;
    assert.equal(audit.status,'UNKNOWN');assert.ok(audit.references.some(ref=>ref.ownerId==='source'));
    assert.equal((await h.request('DELETE','/api/media-library/assets/'+a.id)).status,409);assert.ok(h.repo.get(a.id));
});
test('authenticated Preview lease reports, rejects stale update, and releases',async t=>{
    const h=await httpHarness(t),a=await h.upload(),opened=await h.request('POST','/api/media-library/preview-ownership');
    assert.equal(opened.status,201);const path='/api/media-library/preview-ownership/'+opened.payload.ownership.sessionId;
    assert.equal((await h.request('PUT',path,{sequence:1,assets:[a.id]})).status,200);
    assert.equal((await h.request('PUT',path,{sequence:1,assets:[]})).status,409);
    assert.equal(h.owner.previewOwnership.snapshot().references[0].assetId,a.id);
    assert.equal((await h.request('DELETE',path)).status,200);assert.equal(h.owner.previewOwnership.snapshot().references.length,0);
});
test('production Sponsor stale draft API fails without committing an event',async t=>{
    const h=await httpHarness(t),missing='asset-00000000-0000-4000-8000-000000000099';
    const result=await h.request('POST','/api/studio/schedule/events',sponsor(missing),{'If-Match':'"schedule-0"'});
    assert.equal(result.status,422);assert.equal(result.payload.error.code,'ASSET_UNAVAILABLE');
    assert.equal(h.owner.scheduler.store.getSnapshot().revision,0);assert.equal(h.owner.scheduler.store.listEvents().length,0);
});
test('production unused asset remains UNKNOWN behind the explicit D1 adoption gate',async t=>{
    const h=await httpHarness(t),a=await h.upload();
    await h.request('PUT','/api/studio/state/catalog',{sources:[],scenes:[],revision:0});
    const audit=(await h.request('GET','/api/media-library/assets/'+a.id+'/references')).payload.audit;
    assert.equal(audit.referenceCount,0);assert.equal(audit.complete,false);assert.equal(audit.eligible,false);
    assert.ok(audit.unavailable.includes('CLIENT_CENSUS_RECONNECT_REQUIRED'));
    assert.equal((await h.request('DELETE','/api/media-library/assets/'+a.id)).payload.error.code,'REFERENCE_AUDIT_UNAVAILABLE');
});

test('D2 HTTP handshake reconciles catalog but cannot self-certify adoption or production census',async t=>{
    const h=await httpHarness(t);
    const registered=await h.request('POST','/api/media-library/reference-clients',{role:'CONTROL',version:3,capabilities:['canonical-catalog','preview-ownership-v2','asset-validation','channel-logo-authority-v1']});
    assert.equal(registered.status,201);const c=registered.payload.client;
    const headers={'X-Livezone-Reference-Client':c.clientId,'X-Livezone-Reference-Generation':String(c.generation)};
    const path='/api/media-library/reference-clients/'+c.clientId;
    assert.equal((await h.request('PUT',path,{generation:c.generation,catalog:'RECONCILED'})).status,422);
    assert.equal((await h.request('POST','/api/studio/state/catalog/reconcile',{version:1,revision:0,sources:[],scenes:[]},headers)).status,200);
    const response=await h.request('GET','/api/media-library/reference-inventory',undefined,headers);
    assert.equal(response.payload.inventory.state,'INCOMPLETE');
    assert.ok(response.payload.inventory.reasons.includes('LEGACY_ALIASES_UNCONFIRMED'));
    assert.ok(response.payload.inventory.reasons.includes('Channel Logo confirmation pending'));
    assert.ok(!JSON.stringify(response.payload).includes(c.resumeToken));
});

test('D2 HTTP Control identity isolates Preview close even with a shared authentication cookie',async t=>{
    const h=await httpHarness(t),a=await h.upload();
    const register=async()=>{const c=(await h.request('POST','/api/media-library/reference-clients',{role:'CONTROL',version:3,capabilities:['canonical-catalog','preview-ownership-v2','asset-validation','channel-logo-authority-v1']})).payload.client;
        return {'X-Livezone-Reference-Client':c.clientId,'X-Livezone-Reference-Generation':String(c.generation)};};
    const first=await register(),second=await register();
    const own=(await h.request('POST','/api/media-library/preview-ownership',{},first)).payload.ownership;
    const path='/api/media-library/preview-ownership/'+own.sessionId;
    assert.equal((await h.request('PUT',path,{sequence:1,generation:own.generation,assets:[a.id]},first)).status,200);
    await h.request('DELETE',path,undefined,second);assert.equal(h.owner.previewOwnership.snapshot().references.length,1);
    await h.request('DELETE',path,undefined,first);assert.equal(h.owner.previewOwnership.snapshot().references.length,0);
});

test('DP1 historical durable Program protects managed asset after catalog and runtime references disappear',async t=>{
 const h=await harness(t),asset=await h.upload();await h.catalog([imageSource(asset.id)],[scene]);
 const [{default:Repository},{default:Coordinator},{default:Store},{createProgramOutputEnvelope}]=await Promise.all([
  import('../server/program-output/DurableProgramRepository.js'),import('../server/program-output/ProgramCommitCoordinator.js'),
  import('../server/program-output/ProgramOutputStore.js'),import('../public/js/program-output/ProgramOutputEnvelope.js')]);
 const path=join(h.root,'durable.json'),repository=new Repository({path}),store=new Store(),c=new Coordinator({repository,store});await c.initialize();
 const at=new Date().toISOString(),envelope=createProgramOutputEnvelope({version:1,publisherSessionId:'p',revision:1,publishedAt:at,committedAt:at,scene:{id:'scene',name:'Program',type:'IMAGE'},source:{id:'source',kind:'image',url:'http://localhost'+asset.url},playback:{initialTime:0,duration:null,playing:false,ended:false,state:'ready',startedAt:at},graphics:{items:[]},transition:{type:'cut',durationMs:0}});
 assert.equal((await h.mutations.run(()=>c.accept(envelope,{check:()=>true}))).accepted,true);
 await h.catalog([],[]);const restored=new Repository({path});await restored.load();
 const prior=h.inventory.inventories;h.inventory.inventories=async()=>[...await prior(),{name:'Durable PROGRAM',classification:'RUNTIME',complete:true,data:restored.record.envelope.snapshot}];
 await assert.rejects(h.remove(asset.id),error=>error.code==='ASSET_REFERENCED');assert.ok(h.repo.get(asset.id));
});
