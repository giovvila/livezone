import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JSDOM} from 'jsdom';
import MediaAssetRepository from '../server/media-library/MediaAssetRepository.js';
import MediaReferenceAudit from '../server/media-library/MediaReferenceAudit.js';
import {createProgramOutputServer} from '../test-support/ReferenceAuthorityTestServer.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
import MediaLibraryUI from '../public/js/ui/MediaLibraryUI.js';
const id='asset-00000000-0000-4000-8000-000000000001',asset={id,url:'/media-library/files/image/00000000-0000-4000-8000-000000000001.png'};
const fixtures=[['png','image/png',Buffer.from([137,80,78,71,13,10,26,10,0])],['jpg','image/jpeg',Buffer.from([255,216,255,224,0,0])],['mp4','video/mp4',Buffer.from([0,0,0,0,102,116,121,112,105,115,111,109])],['mp3','audio/mpeg',Buffer.from('ID3audio')]];
async function repository(t,options={}){const root=await mkdtemp(join(tmpdir(),'lz-delete-'));t.after(()=>rm(root,{recursive:true,force:true}));const repo=new MediaAssetRepository({root,...options});await repo.initialize();return {root,repo,async upload(fixture=fixtures[0]){const path=join(repo.tempRoot,'test-upload');await writeFile(path,fixture[2]);return repo.importTempFile({tempPath:path,originalName:'test.'+fixture[0],mimeType:fixture[1],size:fixture[2].length});}};}
for(const fixture of fixtures)test('complete unused audit permits '+fixture[0]+' removal of only owned file and metadata',async t=>{
 const h=await repository(t),a=await h.upload(fixture);await writeFile(join(h.root,'unrelated.txt'),'retain');const audit=new MediaReferenceAudit({inventories:()=>[{name:'Complete isolated fixture',complete:true,data:[]} ]});assert.equal((await audit.inspect(a)).eligible,true);
 await h.repo.delete(a.id,{isReferenced:async value=>!(await audit.inspect(value)).eligible});assert.equal(h.repo.get(a.id),null);assert.deepEqual(JSON.parse(await readFile(h.repo.manifestPath)).assets,[]);await assert.rejects(stat(h.repo.safeFilePath(a.kind,a.storedName)),{code:'ENOENT'});assert.equal(await readFile(join(h.root,'unrelated.txt'),'utf8'),'retain');assert.deepEqual(await readdir(h.repo.tempRoot),[]);
 await assert.rejects(h.repo.delete(a.id,{isReferenced:()=>false}),{code:'ASSET_NOT_FOUND'});
});
for(const [name,value] of [
 ['VIDEO source',{name:'Video',kind:'media',assetId:id}],['IMAGE source',{name:'Image',kind:'image',assetId:id}],
 ['AUDIO media',{name:'Audio',audioAssetId:id}],['AUDIO still artwork',{name:'Artwork',stillAssetId:id}],['AUDIO motion artwork',{name:'Motion',motionAssetId:id}],
 ['future Sponsor',{name:'Tomorrow',type:'overlay.sponsor',startAt:'2099-01-01T00:00:00Z',payload:{assetId:id}}],
 ['active Sponsor',{name:'Active sponsor',type:'overlay.sponsor',payload:{assetId:id}}],
 ['expired Sponsor',{name:'History',type:'overlay.sponsor',endAt:'2000-01-01T00:00:00Z',payload:{assetId:id}}],
 ['disabled Sponsor',{name:'Disabled',enabled:false,payload:{assetId:id}}],
 ['Channel Logo',{name:'Channel Logo',asset:asset.url}],['slate logo',{name:'BREAK',renderer:{logo:'https://studio.test'+asset.url}}],
 ['lower third asset',{name:'Lower Third',payload:{assetId:id}}],['Program runtime',{name:'Program',source:{url:'https://studio.test'+asset.url}}],
 ['Preview runtime',{name:'Preview',assetId:id}]
])test(name+' reference blocks delete and preserves useful owner name',async()=>{
 const audit=await new MediaReferenceAudit({inventories:()=>[{name,complete:true,data:value}]}).inspect(asset);
 assert.equal(audit.eligible,false);assert.ok(audit.referenceCount>0);assert.ok(audit.references.some(ref=>ref.name===value.name));
});
test('scene/source/Program/Preview graph reports multiple indirect owners using IDs',async()=>{
 const data={sources:[{id:'source',name:'Audio source',audioAssetId:id,stillAssetId:id}],scenes:[{id:'scene',name:'Audio scene',renderer:{sourceId:'source'}}],program:{name:'Program',sceneId:'scene'},preview:{name:'Preview',sceneId:'scene'},events:[{name:'Tomorrow programme',target:{id:'source'}}]};
 const audit=await new MediaReferenceAudit({inventories:()=>[{name:'Catalog',complete:true,data}]}).inspect(asset);assert.ok(audit.referenceCount>=5);for(const name of ['Audio source','Audio scene','Program','Preview'])assert.ok(audit.references.some(ref=>ref.name===name));
});
test('unknown owners, failed inventory and empty inventory never count as unused',async()=>{
 for(const inventories of [()=>[],()=>[{name:'Preview missing',complete:false,data:[]}],()=>{throw Error('unavailable');}]){const audit=await new MediaReferenceAudit({inventories}).inspect(asset);assert.equal(audit.eligible,false);assert.equal(audit.complete,false);}
});
test('file basename alone is not an asset reference',async()=>{const audit=await new MediaReferenceAudit({inventories:()=>[{name:'Other',complete:true,data:{title:'00000000-0000-4000-8000-000000000001.png'}}]}).inspect(asset);assert.equal(audit.referenceCount,0);});
test('reference detail list is bounded while count remains complete',async()=>{const audit=await new MediaReferenceAudit({inventories:()=>[{name:'Many',complete:true,data:Array.from({length:150},(_,n)=>({name:'Owner '+n,assetId:id}))}]}).inspect(asset);assert.equal(audit.referenceCount,150);assert.equal(audit.references.length,100);});
test('delete refuses traversal, unknown ID and missing audit',async t=>{const h=await repository(t),a=await h.upload();await assert.rejects(h.repo.delete('../asset'),{code:'ASSET_ID_INVALID'});await assert.rejects(h.repo.delete(id),{code:'ASSET_NOT_FOUND'});await assert.rejects(h.repo.delete(a.id),{code:'REFERENCE_GUARD_REQUIRED'});assert.ok(h.repo.get(a.id));});
test('missing physical file does not remove metadata',async t=>{const h=await repository(t),a=await h.upload();await rm(h.repo.safeFilePath(a.kind,a.storedName));await assert.rejects(h.repo.delete(a.id,{isReferenced:()=>false}),{code:'ENOENT'});assert.equal(JSON.parse(await readFile(h.repo.manifestPath)).assets[0].id,a.id);});
for(const failure of ['rename','metadata','unlink'])test(failure+' failure preserves file and metadata rather than returning success',async t=>{
 const h=await repository(t),a=await h.upload();
 if(failure==='metadata'){const original=h.repo.writeManifest.bind(h.repo);let count=0;h.repo.writeManifest=()=>++count===1?Promise.reject(Error('metadata failure')):original();}
 else h.repo.deleteFs[failure]=async()=>{throw Object.assign(Error('filesystem failure'),{code:'EACCES'});};
 await assert.rejects(h.repo.delete(a.id,{isReferenced:()=>false}));assert.ok(h.repo.get(a.id));assert.equal((await stat(h.repo.safeFilePath(a.kind,a.storedName))).size,a.size);assert.equal(JSON.parse(await readFile(h.repo.manifestPath)).assets[0].id,a.id);
});
test('link/junction in managed delete path is rejected',async t=>{const h=await repository(t),a=await h.upload();h.repo.deleteFs.lstat=async()=>({isSymbolicLink:()=>true});await assert.rejects(h.repo.delete(a.id,{isReferenced:()=>false}),{code:'PATH_INVALID'});assert.ok(h.repo.get(a.id));});
async function serverHarness(t,{protectedApi=false}={}){
 const h=await repository(t);const owner=createProgramOutputServer({publisherToken:'test-safe-media-delete',mediaAssetRepository:h.repo,schedulePath:join(h.root,'schedule.json'),studioStatePath:join(h.root,'state.json'),operatorAuth:new OperatorAuth(protectedApi?{username:'operator',password:'test-only-password'}:{disabled:true})});await new Promise(r=>owner.server.listen(0,'127.0.0.1',r));await owner.scheduler.ready;t.after(()=>new Promise(r=>owner.server.close(r)));const origin='http://127.0.0.1:'+owner.server.address().port;return {...h,owner,origin};
}
test('production backend rejects deletion when browser catalog/Preview inventory is incomplete',async t=>{
 const h=await serverHarness(t),a=await h.upload();const response=await fetch(h.origin+'/api/media-library/assets/'+a.id+'/references');assert.equal(response.status,200);const {audit}=await response.json();assert.equal(audit.eligible,false);assert.ok(audit.unavailable.includes('CLIENT_CENSUS_RECONNECT_REQUIRED'));
 const before=h.owner.store.getCurrent();const deleted=await fetch(h.origin+'/api/media-library/assets/'+a.id,{method:'DELETE'});assert.equal(deleted.status,409);assert.equal((await deleted.json()).error.code,'REFERENCE_AUDIT_UNAVAILABLE');assert.ok(h.repo.get(a.id));assert.deepEqual(h.owner.store.getCurrent(),before);
});
for(const period of ['future','expired','disabled'])test('production API reports '+period+' Sponsor reference and refuses deletion',async t=>{
 const h=await serverHarness(t),a=await h.upload();await h.owner.scheduler.store.insert({id:'sponsor',version:1,type:'overlay.sponsor',name:'Sponsor '+period,enabled:period!=='disabled',startAt:period==='expired'?'2000-01-01T00:00:00.000Z':'2099-01-01T00:00:00.000Z',endAt:period==='expired'?'2000-01-01T00:10:00.000Z':'2099-01-01T00:10:00.000Z',priority:0,payload:{assetId:a.id,position:'top-right',sizePercent:12,opacity:1}},0);
 const r=await fetch(h.origin+'/api/media-library/assets/'+a.id,{method:'DELETE'});assert.equal(r.status,409);const body=await r.json();assert.equal(body.error.code,'ASSET_REFERENCED');assert.ok(body.error.details.references.some(ref=>ref.name==='Sponsor '+period));assert.ok(h.repo.get(a.id));
});
for(const origin of ['public','obs'])test(origin+' anonymous caller cannot audit or delete',async t=>{
 const h=await serverHarness(t,{protectedApi:true}),a=await h.upload();for(const [method,suffix] of [['DELETE',''],['GET','/references']])assert.equal((await fetch(h.origin+'/api/media-library/assets/'+a.id+suffix,{method})).status,401);assert.ok(h.repo.get(a.id));
});
const html=await readFile(new URL('../public/control/schedule/index.html',import.meta.url),'utf8');
for(const eligible of [false,true])test('production shared UI '+(eligible?'requires explicit confirmation':'blocks incomplete audit without delete') ,async t=>{
 const dom=new JSDOM(html);const old=globalThis.document;globalThis.document=dom.window.document;t.after(()=>{dom.window.close();if(old===undefined)delete globalThis.document;else globalThis.document=old;});let deleted=0;
 const a={...asset,kind:'image',originalName:'Sponsor PNG',size:100};const ui=new MediaLibraryUI(document.querySelector('#media-library'),{auditDelete:async()=>({eligible,references:eligible?[]:[{type:'Evento palinsesto',name:'Sponsor domani'}],unavailable:eligible?[]:['Preview']}),deleteAsset:async()=>{deleted++;}},{storage:null});
 let broadcasts=0;ui.channel={postMessage:()=>broadcasts++};await ui.reviewDelete(a);assert.equal(deleted,0);const dialog=document.querySelector('[role=dialog]');assert.ok(dialog.textContent.includes('Eliminare definitivamente questo media?'));assert.ok(dialog.querySelector('img'));const button=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='ELIMINA DEFINITIVAMENTE');assert.equal(button.disabled,!eligible);button.click();await new Promise(r=>setTimeout(r,0));assert.equal(deleted,eligible?1:0);assert.equal(broadcasts,eligible?1:0);
});
