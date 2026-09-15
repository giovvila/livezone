import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import MediaAssetRepository from '../server/media-library/MediaAssetRepository.js';
import AssetMutationCoordinator from '../server/media-library/AssetMutationCoordinator.js';
import AssetReferenceInventory from '../server/media-library/AssetReferenceInventory.js';
import PreviewOwnership from '../server/media-library/PreviewOwnership.js';
import ReferenceClientRegistry from '../server/media-library/ReferenceClientRegistry.js';
import AssetAuthorityDiagnostics from '../server/media-library/AssetAuthorityDiagnostics.js';
import AuthoritativeStateRepository from '../server/studio/AuthoritativeStateRepository.js';
import StudioStateCoordinator from '../server/studio/StudioStateCoordinator.js';
import StudioReferenceAuthority from '../public/js/studio/StudioReferenceAuthority.js';
import StudioCatalogManager from '../public/js/studio/StudioCatalogManager.js';
import PreviewOwnershipClient from '../public/js/studio/PreviewOwnershipClient.js';
import MediaLibraryUI from '../public/js/ui/MediaLibraryUI.js';
import MediaLibraryManager from '../public/js/media-library/MediaLibraryManager.js';

const caps=['canonical-catalog','preview-ownership-v2','asset-validation'];

test('reconnect preserves pending legacy references until confirmed local application',async t=>{
    const h=await harness(t),a=await h.upload(),c=await h.client();
    const pending=await h.registry.updateLegacy(c.clientId,c.generation,{assets:[{assetId:a.id,kind:'image'}],complete:true},'operator');
    const resumed=await h.registry.register({role:'CONTROL',version:2,capabilities:caps,resumeId:c.clientId,resumeGeneration:c.generation,resumeToken:c.resumeToken},'new-session');
    assert.equal(h.registry.legacyReferences()[0].assetId,a.id);
    await assert.rejects(h.remove(a.id),{code:'ASSET_REFERENCED'});
    await h.registry.confirmLegacy(resumed.clientId,resumed.generation,pending.revision,'new-session');
    assert.equal(h.registry.legacyReferences()[0].assetId,a.id);
});

for(const target of ['clients','preview'])test('corrupt persisted '+target+' ownership fails closed',async t=>{
    const h=await harness(t),a=await h.upload();
    if(target==='clients'){
        await h.client();const data=JSON.parse(await readFile(h.registry.path,'utf8'));data.clients[0].legacyAssets=[null];await writeFile(h.registry.path,JSON.stringify(data));
        const registry=new ReferenceClientRegistry({coordinator:h.mutations,path:h.registry.path,coverageProven:true});await registry.ready;assert.equal(registry.snapshot().state,'INCOMPLETE');
    }else{
        const opened=await h.preview.open('operator');await h.preview.update(opened.sessionId,'operator',{sequence:1,assets:[a.id]});
        const data=JSON.parse(await readFile(h.preview.path,'utf8'));data.sessions[0][1].references=[null];await writeFile(h.preview.path,JSON.stringify(data));
        const preview=new PreviewOwnership({coordinator:h.mutations,path:h.preview.path,validate:()=>{}});await preview.ready;assert.equal(preview.snapshot().complete,false);
    }
});
const source=(assetId,id='source')=>({id,name:'Image',kind:'image',assetId});
const formats={image:['png','image/png',Buffer.from([137,80,78,71,13,10,26,10])],
    video:['mp4','video/mp4',Buffer.from([0,0,0,0,102,116,121,112,105,115,111,109])],audio:['mp3','audio/mpeg',Buffer.from('ID3audio')]};
async function harness(t){
    const root=await mkdtemp(join(tmpdir(),'lz-d2-'));t.after(()=>rm(root,{recursive:true,force:true}));
    const mutations=new AssetMutationCoordinator(),repo=new MediaAssetRepository({root:join(root,'media')});await repo.initialize();repo.mutationCoordinator=mutations;
    const diagnostics=new AssetAuthorityDiagnostics(),runtime={now:0,program:{scene:null,source:null},schedule:[],graphics:[]};
    const registry=new ReferenceClientRegistry({coordinator:mutations,path:join(root,'clients.json'),coverageProven:true,diagnostics});await registry.ready;
    const preview=new PreviewOwnership({coordinator:mutations,path:join(root,'preview.json'),clock:()=>runtime.now,
        validate:values=>inventory.validate(values),diagnostics});await preview.ready;
    const studio=new StudioStateCoordinator({repository:new AuthoritativeStateRepository({path:join(root,'studio.json')})});await studio.initialize();studio.mutationCoordinator=mutations;studio.diagnostics=diagnostics;
    const inventory=new AssetReferenceInventory({repository:repo,preview,diagnostics,completeness:()=>registry.snapshot(),inventories:()=>[
        {name:'Studio',complete:true,data:studio.getSnapshot()},
        {name:'Legacy aliases',complete:true,data:registry.legacyReferences()},
        {name:'PROGRAM',classification:'RUNTIME',complete:true,data:runtime.program},
        {name:'Scheduler',complete:true,data:runtime.schedule},{name:'CHANNEL LOGO',complete:true,data:runtime.graphics}
    ]});
    studio.referenceValidator=value=>inventory.validate(value);registry.currentCatalogRevision=()=>studio.getSnapshot().revision;
    registry.validateLegacy=values=>inventory.validate(values.map(value=>({...value,kind:value.kind==='video'?'media':value.kind})));
    const upload=async(kind='image')=>{const [ext,mimeType,bytes]=formats[kind],tempPath=join(repo.tempRoot,'upload');await writeFile(tempPath,bytes);return repo.importTempFile({tempPath,originalName:'test.'+ext,mimeType,size:bytes.length});};
    const reconcile=(sources,options={})=>studio.reconcileCatalog({version:1,revision:studio.getSnapshot().revision,sources,scenes:[],...options});
    const remove=id=>repo.delete(id,{isReferenced:async asset=>!(await inventory.inspect(asset)).eligible});
    const client=async(role='CONTROL')=>{const value=await registry.register({role,version:2,capabilities:caps},'operator');
        await registry.update(value.clientId,value.generation,{catalog:'RECONCILED'},'operator');
        const legacy=await registry.updateLegacy(value.clientId,value.generation,{assets:[],complete:true},'operator');await registry.confirmLegacy(value.clientId,value.generation,legacy.revision,'operator');return value;};
    return {root,repo,mutations,runtime,registry,preview,studio,inventory,diagnostics,upload,reconcile,remove,client};
}

test('empty server safely imports valid legacy canonical references',async t=>{
    const h=await harness(t),a=await h.upload(),result=await h.reconcile([source(a.id)]);
    assert.equal(result.status,'IMPORTED');assert.equal(result.state.sources[0].assetId,a.id);await assert.rejects(h.remove(a.id),{code:'ASSET_REFERENCED'});
});
test('legacy import is idempotent without advancing revision twice',async t=>{
    const h=await harness(t),a=await h.upload();await h.reconcile([source(a.id)]);const before=await readFile(h.studio.repository.path,'utf8');
    const result=await h.reconcile([source(a.id)]);assert.equal(result.status,'SAME');assert.equal(result.state.revision,1);assert.equal(await readFile(h.studio.repository.path,'utf8'),before);
});
test('missing nonconflicting browser records are added while server-only records survive',async t=>{
    const h=await harness(t),a=await h.upload(),b=await h.upload();await h.reconcile([source(a.id,'server')]);
    const result=await h.reconcile([source(b.id,'browser')]);assert.equal(result.status,'IMPORTED');assert.deepEqual(result.state.sources.map(s=>s.id),['browser','server']);
});
test('server superset is retained without destructive boot rewrite',async t=>{
    const h=await harness(t),a=await h.upload(),b=await h.upload();await h.reconcile([source(a.id,'one'),source(b.id,'two')]);
    const result=await h.reconcile([source(a.id,'one')]);assert.equal(result.status,'SERVER_SUPERSET');assert.equal(result.state.sources.length,2);assert.equal(result.state.revision,1);
});
for(const [label,revision] of [['server newer',0],['browser claims newer',999]])test(label+' cannot overwrite authoritative revision',async t=>{
    const h=await harness(t),a=await h.upload();await h.reconcile([source(a.id)]);
    await assert.rejects(h.reconcile([],{revision}),{code:'REVISION_CONFLICT'});assert.equal(h.studio.getSnapshot().sources[0].assetId,a.id);
});
test('conflicting same source preserves server bytes and returns explicit conflict',async t=>{
    const h=await harness(t),a=await h.upload(),b=await h.upload();await h.reconcile([source(a.id)]);const before=await readFile(h.studio.repository.path,'utf8');
    const result=await h.reconcile([source(b.id)]);assert.equal(result.status,'CONFLICT');assert.equal(result.conflicts[0].ownerId,'source');assert.equal(await readFile(h.studio.repository.path,'utf8'),before);
});
test('malformed legacy source does not become an empty successful import',async t=>{
    const h=await harness(t);await assert.rejects(h.reconcile([{id:'bad'}]),{code:'INVALID_STATE'});assert.equal(h.studio.getSnapshot().initialized,false);
});
test('legacy references to deleted assets are rejected',async t=>{
    const h=await harness(t),a=await h.upload();await h.remove(a.id);await assert.rejects(h.reconcile([source(a.id)]),{code:'ASSET_UNAVAILABLE'});
});
test('legacy schema version mismatch is explicit',async t=>{
    const h=await harness(t);await assert.rejects(h.reconcile([],{version:99}),{code:'CATALOG_VERSION_UNSUPPORTED'});
});

function browserCatalog(h){
    const records=new Map([['unrelated','preserve']]);const storage={getItem:key=>records.get(key)||null,setItem:(key,value)=>records.set(key,value)};
    const state={registerScene:()=>true,unregisterScene:()=>true,replaceScene:()=>true,getPreviewSceneId:()=>null,getProgramSceneId:()=>null};
    const sources={registerSource:()=>true,unregisterSource:()=>true,replaceSource:()=>true,getActiveInstances:()=>[],getSource:()=>null};
    const resolver={resolve:id=>{const asset=h.repo.get(id);return asset?{ok:true,asset:{...asset,url:'http://studio.test'+asset.url}}:{ok:false};}};
    let serial=1;
    const catalog=new StudioCatalogManager({storage,studioStateManager:state,studioSourceManager:sources,assetResolver:resolver,eventTarget:null,baseUrl:'http://studio.test/',uuidFactory:()=>`00000000-0000-4000-8000-${String(serial++).padStart(12,'0')}`});catalog.initialize();
    const calls=[];
    const authority=new StudioReferenceAuthority({catalog,request:async(url,options)=>{
        calls.push(url);if(!options)return {state:h.studio.getSnapshot()};const body=JSON.parse(options.body);
        if(url.endsWith('/reconcile')){const result=await h.studio.reconcileCatalog(body);if(result.status==='CONFLICT')throw Object.assign(Error(),{code:'CATALOG_AUTHORITY_CONFLICT'});return result;}
        return {state:await h.studio.updateCatalog(body)};
    }});
    return {catalog,authority,records,calls};
}
test('legacy reconciliation leaves unrelated localStorage and existing local catalog bytes untouched',async t=>{
    const h=await harness(t),a=await h.upload(),b=browserCatalog(h);b.catalog.addSource({kind:'image',name:'Image',assetId:a.id});const before=[...b.records];
    assert.equal(await b.authority.initialize(),true);assert.deepEqual([...b.records],before);assert.equal(b.records.get('unrelated'),'preserve');
});
test('malformed localStorage is reported rather than silently adopting only the surviving subset',async t=>{
    const h=await harness(t),b=browserCatalog(h);b.records.set('livezone.studio.mediaCatalog.overlay.v1','invalid');let reports=0;
    b.authority.client={reportInvalid:async()=>reports++};assert.equal(await b.authority.initialize(),false);assert.equal(reports,1);assert.equal(h.studio.getSnapshot().sources.length,0);
});
for(const role of ['CONTROL','SCHEDULER'])test(role+' catalog mutations commit through server coordinator',async t=>{
    const h=await harness(t),a=await h.upload(),b=browserCatalog(h);assert.equal(await b.authority.initialize(),true);b.catalog.referenceAuthority=b.authority;
    assert.equal((await b.catalog.addSource({kind:'image',name:role,assetId:a.id})).ok,true);
    assert.ok(b.calls.includes('/api/studio/state/catalog'));assert.equal(h.studio.getSnapshot().sources[0].assetId,a.id);
});
for(const [field,kind] of [['stillAssetId','image'],['motionAssetId','video']])test('Audio '+field+' edit uses authoritative mutation',async t=>{
    const h=await harness(t),audio=await h.upload('audio'),art=await h.upload(kind),b=browserCatalog(h);
    const added=b.catalog.addSource({kind:'audio',name:'Radio',audioAssetId:audio.id});assert.equal(added.ok,true);
    await b.authority.initialize();b.catalog.referenceAuthority=b.authority;
    assert.equal((await b.catalog.updateSource(added.source.id,{name:'Radio',audioAssetId:audio.id,[field]:art.id})).ok,true);
    assert.equal(h.studio.getSnapshot().sources[0][field],art.id);
});
test('later browser edit preserves reconciled server-only records',async t=>{
    const h=await harness(t),a=await h.upload(),b=browserCatalog(h);await h.reconcile([source(a.id,'serverOnly')]);
    await b.authority.initialize();b.catalog.referenceAuthority=b.authority;await b.catalog.addSource({kind:'image',name:'Added',assetId:a.id});
    assert.equal(h.studio.getSnapshot().sources.length,2);assert.ok(h.studio.getSnapshot().sources.some(value=>value.id==='serverOnly'));
});

for(const role of ['CONTROL','SCHEDULER'])test(role+' capability handshake can complete a controlled isolated census',async t=>{
    const h=await harness(t);await h.client(role);assert.equal(h.registry.snapshot().state,'COMPLETE');
});
test('obsolete client forces explicit global incompleteness',async t=>{
    const h=await harness(t);await h.registry.register({role:'CONTROL',version:1,capabilities:[]});
    const global=await h.inventory.globalCompleteness();assert.equal(global.state,'INCOMPLETE');assert.ok(global.reasons.includes('CLIENT_CAPABILITY_UNKNOWN'));
});
test('unproven real-world census is never inferred from absence of connected clients',async t=>{
    const h=await harness(t);h.registry.coverageProven=false;const a=await h.upload();assert.equal((await h.inventory.inspect(a)).status,'UNKNOWN');
    assert.ok((await h.inventory.globalCompleteness()).reasons.includes('LEGACY_CLIENT_CENSUS_UNPROVEN'));
});
test('closing a client cannot erase unresolved legacy catalog conflicts',async t=>{
    const h=await harness(t),c=await h.client();await h.registry.update(c.clientId,c.generation,{catalog:'CONFLICT',closed:true},'operator');
    assert.equal(h.registry.snapshot().state,'INCOMPLETE');
});
test('catalog application acknowledgement closes the server-to-client quiet interval',async t=>{
    const h=await harness(t),c=await h.client();await h.registry.pendingCatalog(c.clientId,c.generation,1,'operator');
    assert.equal(h.registry.snapshot().state,'INCOMPLETE');await h.reconcile([]);
    await h.registry.confirmCatalog(c.clientId,c.generation,1,'operator');assert.equal(h.registry.snapshot().state,'COMPLETE');
});
test('legacy asset removal retains previous references until local apply acknowledgement',async t=>{
    const h=await harness(t),a=await h.upload(),c=await h.client();
    let stage=await h.registry.updateLegacy(c.clientId,c.generation,{assets:[{assetId:a.id,kind:'image'}],complete:true},'operator');
    await h.registry.confirmLegacy(c.clientId,c.generation,stage.revision,'operator');
    stage=await h.registry.updateLegacy(c.clientId,c.generation,{assets:[],complete:true},'operator');
    assert.equal((await h.inventory.inspect(a)).status,'UNKNOWN');assert.equal((await h.inventory.inspect(a)).referenceCount,1);
    await assert.rejects(h.remove(a.id),{code:'ASSET_REFERENCED'});
    await h.registry.confirmLegacy(c.clientId,c.generation,stage.revision,'operator');assert.equal((await h.inventory.inspect(a)).status,'UNUSED');
});
test('client reconnect token permits a new authenticated session; stale generation cannot clear it',async t=>{
    const h=await harness(t),c=await h.client();
    const newer=await h.registry.register({role:'CONTROL',version:2,capabilities:caps,resumeId:c.clientId,resumeGeneration:c.generation,resumeToken:c.resumeToken},'new-login');
    assert.equal(newer.generation,2);
    await assert.rejects(h.registry.update(c.clientId,c.generation,{closed:true},'operator'),{code:'CLIENT_GENERATION_CONFLICT'});
    assert.equal(h.registry.clients.get(c.clientId).active,true);
    await assert.rejects(h.registry.register({role:'CONTROL',version:2,capabilities:caps,resumeId:c.clientId,resumeGeneration:2,resumeToken:'wrong'},'other'),{code:'CLIENT_GENERATION_CONFLICT'});
});
test('client registry restart retains unresolved conflicts and does not infer active capability',async t=>{
    const h=await harness(t),c=await h.client();await h.registry.update(c.clientId,c.generation,{catalog:'CONFLICT'},'operator');
    const loaded=new ReferenceClientRegistry({coordinator:h.mutations,path:join(h.root,'clients.json'),coverageProven:true});await loaded.ready;
    assert.equal(loaded.snapshot().state,'INCOMPLETE');assert.ok(loaded.snapshot().reasons.includes('LEGACY_CATALOG_CONFLICT'));
});

for(const [label,interval] of [['normal',8000],['background tab',60000],['quiet Preview',900000],['sleep/resume',28800000]])test(label+' silence never releases an active Preview asset',async t=>{
    const h=await harness(t),a=await h.upload(),s=await h.preview.open('operator|A');await h.preview.update(s.sessionId,'operator|A',{sequence:1,assets:[a.id]});
    h.runtime.now=interval;const audit=await h.inventory.inspect(a);assert.equal(audit.eligible,false);assert.equal(audit.referenceCount,1);assert.equal(audit.status,interval>30000?'UNKNOWN':'USED');
    await assert.rejects(h.remove(a.id),{code:'ASSET_REFERENCED'});
});
test('confirmed Control close releases ownership even after a long uncertain interval',async t=>{
    const h=await harness(t),a=await h.upload(),s=await h.preview.open('operator|A');await h.preview.update(s.sessionId,'operator|A',{sequence:1,assets:[a.id]});
    h.runtime.now=999999;assert.equal((await h.inventory.inspect(a)).status,'UNKNOWN');await h.preview.close(s.sessionId,'operator|A',s.generation);
    assert.equal((await h.inventory.inspect(a)).status,'UNUSED');await h.remove(a.id);
});
test('Control A close cannot clear Control B Preview ownership',async t=>{
    const h=await harness(t),a=await h.upload(),b=await h.upload(),sa=await h.preview.open('operator|A'),sb=await h.preview.open('operator|B');
    await h.preview.update(sa.sessionId,'operator|A',{sequence:1,assets:[a.id]});await h.preview.update(sb.sessionId,'operator|B',{sequence:1,assets:[b.id]});
    await h.preview.close(sb.sessionId,'operator|A');assert.equal((await h.inventory.inspect(b)).status,'USED');
    await h.preview.close(sa.sessionId,'operator|A');assert.equal((await h.inventory.inspect(a)).status,'UNUSED');assert.equal((await h.inventory.inspect(b)).status,'USED');
});
test('Preview reconnect retains ownership before confirmation and rejects stale update/close',async t=>{
    const h=await harness(t),a=await h.upload(),b=await h.upload(),old=await h.preview.open('old-login|A');await h.preview.update(old.sessionId,'old-login|A',{sequence:1,assets:[a.id]});
    const current=await h.preview.open('new-login|A',{resumeSessionId:old.sessionId,generation:old.generation,resumeToken:old.resumeToken});
    assert.equal((await h.inventory.inspect(a)).status,'UNKNOWN');await assert.rejects(h.remove(a.id),{code:'ASSET_REFERENCED'});
    await h.preview.close(old.sessionId,'old-login|A',1);assert.equal(h.preview.snapshot().references.length,1);
    await assert.rejects(h.preview.update(old.sessionId,'new-login|A',{sequence:99,generation:1,assets:[]}),{code:'OWNERSHIP_STALE_UPDATE'});
    await h.preview.update(current.sessionId,'new-login|A',{sequence:1,generation:current.generation,assets:[b.id]});
    assert.equal((await h.inventory.inspect(a)).status,'UNUSED');assert.equal((await h.inventory.inspect(b)).status,'USED');
});
test('Preview ownership survives server reconstruction as uncertain, never absent',async t=>{
    const h=await harness(t),a=await h.upload(),s=await h.preview.open('operator');await h.preview.update(s.sessionId,'operator',{sequence:1,assets:[a.id]});
    const restored=new PreviewOwnership({coordinator:h.mutations,path:join(h.root,'preview.json'),validate:v=>h.inventory.validate(v)});await restored.ready;
    assert.equal(restored.snapshot().complete,false);assert.equal(restored.snapshot().references[0].assetId,a.id);
});
for(const [label,confirmedGone,method] of [['engine interruption',false,'PUT'],['confirmed pagehide',true,'DELETE']])test(label+' uses the correct client lifecycle signal',async()=>{
    const calls=[],client=new PreviewOwnershipClient({getOwnership:()=>({complete:true,assets:[]}),storage:null,fetcher:async(url,options)=>{calls.push(options);return {ok:true};}});
    client.sessionId='test';client.serverGeneration=4;client.stop({confirmedGone});await new Promise(r=>setImmediate(r));
    assert.equal(calls[0].method,method);if(!confirmedGone)assert.equal(JSON.parse(calls[0].body).complete,false);
});

for(const [label,kind,field] of [['VIDEO','video','url'],['IMAGE','image','url'],['AUDIO','audio','audioUrl'],['AUDIO STILL','image','stillUrl'],['AUDIO MOTION','video','motionUrl']])test('Program '+label+' retains canonical reverse-resolved ownership',async t=>{
    const h=await harness(t),a=await h.upload(kind);h.runtime.program={scene:{name:'News'},source:{kind:label.startsWith('AUDIO')?'audio':kind==='video'?'media':'image',
        ...(label.startsWith('AUDIO')?{audioUrl:'https://external.test/audio.mp3'}:{}),[field]:'http://studio.test'+a.url}};
    const audit=await h.inventory.inspect(a);assert.equal(audit.status,'USED');assert.ok(audit.references.some(ref=>ref.classification==='RUNTIME'&&ref.assetId===a.id));
});
for(const program of [null,{source:{kind:'media'}},{source:{kind:'image',url:'/media-library/files/image/missing.png'}}])test('missing Program identity fails closed: '+JSON.stringify(program),async t=>{
    const h=await harness(t),a=await h.upload();h.runtime.program=program;assert.equal((await h.inventory.inspect(a)).status,'UNKNOWN');await assert.rejects(h.remove(a.id),{code:'ASSET_REFERENCED'});
});
test('LIVE external transport has no managed media identity to delete',async t=>{
    const h=await harness(t),a=await h.upload();h.runtime.program={source:{kind:'hls',url:'https://ingest.test/live/index.m3u8'}};assert.equal((await h.inventory.inspect(a)).status,'UNUSED');
});
for(const state of ['ENTRY','LOSS','BREAK','CONTROL CLOSED'])test(state+' cannot make persisted Sponsor or Channel Logo unused',async t=>{
    const h=await harness(t),sponsor=await h.upload(),logo=await h.upload();
    h.runtime.schedule=[{id:'sponsor',type:'overlay.sponsor',name:'Sponsor',enabled:true,payload:{assetId:sponsor.id}}];
    h.runtime.graphics=[{id:'channel-logo',kind:'image',asset:'http://studio.test'+logo.url}];
    h.runtime.program={source:state==='CONTROL CLOSED'?null:{kind:'break',logoUrl:'https://external.test/slate.png'},overlays:{}};
    assert.equal((await h.inventory.inspect(sponsor)).status,'USED');assert.equal((await h.inventory.inspect(logo)).status,'USED');
});
test('effective Sponsor URL remains an additional runtime owner',async t=>{
    const h=await harness(t),a=await h.upload();h.runtime.program={source:null,overlays:{sponsor:{url:a.url,enabled:true}}};
    assert.equal((await h.inventory.inspect(a)).status,'USED');
});
test('UNKNOWN row has a clear explanation and no delete action',async t=>{
    const dom=new JSDOM('<div id="library"><input id="media-library-input"><select id="media-library-filter"><option value="">ALL</option></select><ul id="media-library-list"></ul><p id="media-library-status"></p><button id="media-library-toggle"></button></div>');
    const old=globalThis.document;globalThis.document=dom.window.document;
    const manager=new MediaLibraryManager({list:async()=>({assets:[{id:'a',kind:'image',mimeType:'image/png',originalName:'Photo',size:8}],audits:{a:{complete:false,eligible:false,referenceCount:0}}})});
    const ui=new MediaLibraryUI(document.getElementById('library'),manager,{storage:null});ui.start();await manager.initialize();
    t.after(()=>{ui.destroy();dom.window.close();globalThis.document=old;});
    assert.match(ui.list.textContent,/Impossibile verificare tutti i riferimenti del media/);assert.equal(ui.list.querySelector('.media-library-item__delete'),null);
});
test('diagnostics are bounded and never contain client tokens or asset IDs',async t=>{
    const h=await harness(t),a=await h.upload(),s=await h.preview.open('private-principal');await h.preview.update(s.sessionId,'private-principal',{sequence:1,assets:[a.id]});
    for(let i=0;i<150;i++)await h.inventory.inspect(a);
    const values=h.diagnostics.snapshot();assert.equal(values.length,100);const text=JSON.stringify(values);assert.ok(!text.includes(a.id));assert.ok(!text.includes(s.resumeToken));assert.ok(!text.includes('private-principal'));
});
