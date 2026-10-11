import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {previewReadFixture,observer} from '../test-support/PreviewReadFixture.js';
import {capabilities} from '../test-support/ReferenceReadFixture.js';
const {default:Registry}=await import('../server/media-library/ReferenceClientRegistry.js');
const {default:Preview}=await import('../server/media-library/PreviewOwnership.js');
const row=h=>h.registry.clients.get(h.client.clientId);
const put=(h,fields={})=>h.request('PUT','/api/media-library/reference-clients/'+h.client.clientId,{body:{generation:h.client.generation,...fields}});
async function fixture(t){const h=await previewReadFixture(t);await h.open();await h.confirm(['fixture-reference']);h.registry.currentCatalogRevision=()=>7;await h.registry.pendingCatalog(row(h).id,row(h).generation,7,row(h).principal);return h;}
const state=h=>({clients:structuredClone([...h.registry.clients]),preview:structuredClone([...h.preview.sessions]),presence:structuredClone([...h.registry.presenceEvidence])});
async function rejected(h,fields){const before=state(h),bytes=await h.bytes();const r=await put(h,fields);assert.ok(r.status>=400);assert.deepEqual(state(h),before);assert.deepEqual(await h.bytes(),bytes);return r;}
const close=async h=>{assert.equal((await put(h,{closed:true,confirmed:false})).status,200);};
const closed=h=>{assert.equal(row(h).active,false);assert.equal(row(h).termination,'EXPLICIT_CLOSE');assert.equal(row(h).confirmed,false);assert.equal(h.preview.sessions.size,0);};

test('exact R15 RED to GREEN: valid catalog acknowledgment cannot silently ignore requested close',async t=>{
 const h=await fixture(t),old=await readFile(new URL('../test-support/fixtures/reference-routes-r15.txt',import.meta.url),'utf8');
 const line=old.split(/\r?\n/).find(l=>l.includes('if(body.appliedRevision!==undefined)'));
 const shortcut=new Function('request','response','match','body','return (async()=>{'+line+'})();');
 const handle=h.mediaRoutes.handle;h.mediaRoutes.handle=async function(req,res,url){if(req.method==='PUT'&&url.pathname.includes('/reference-clients/'))return shortcut.call(this,req,res,[null,h.client.clientId],await this.readJson(req));return handle.call(this,req,res,url);};
 assert.equal((await put(h,{appliedRevision:7,closed:true,confirmed:false})).status,200);assert.equal(row(h).active,true);assert.equal(row(h).confirmed,true);assert.equal(h.preview.sessions.size,1);
 h.mediaRoutes.handle=handle;await h.registry.pendingCatalog(row(h).id,row(h).generation,7,row(h).principal);
 await rejected(h,{appliedRevision:7,closed:true,confirmed:false});assert.equal(row(h).active,true);assert.equal(h.preview.sessions.size,1);
});

test('true close replay with valid acknowledgment is coherent idempotent and releases nothing twice',async t=>{
 const h=await fixture(t);let releases=0;h.preview.diagnostics={record:code=>{if(code==='PREVIEW_OWNERSHIP_RELEASED')releases++;}};await close(h);closed(h);
 assert.equal((await put(h,{appliedRevision:7,closed:true,confirmed:false})).status,200);const before=state(h),bytes=await h.bytes();
 for(let n=0;n<4;n++){assert.equal((await put(h,{appliedRevision:7,closed:true,confirmed:false})).status,200);assert.deepEqual(state(h),before);assert.deepEqual(await h.bytes(),bytes);}assert.equal(releases,1);
});

for(const context of ['no revision','valid acknowledgment','true replay','wrong state'])for(const [closedFlag,confirmed]of [[true,false],[true,true],[false,false],[false,true]])test(context+' closed='+closedFlag+' confirmed='+confirmed,async t=>{
 const h=await fixture(t);if(context==='true replay'){if(closedFlag)await close(h);else await put(h,{confirmed:false});}
 const fields={closed:closedFlag,confirmed,...(context!=='no revision'?{appliedRevision:7}:{})};
 const success=confirmed===false&&(context==='no revision'||context==='true replay');
 if(success){assert.equal((await put(h,fields)).status,200);assert.equal(row(h).confirmed,false);if(closedFlag)closed(h);else assert.equal(row(h).active,true);}else await rejected(h,fields);
});

for(const fields of [{},{closed:false},{confirmed:false},{closed:true},{closed:null},{confirmed:null},{catalog:'INVALID'}])test('acknowledgment field-presence '+JSON.stringify(fields),async t=>{
 const h=await fixture(t);if(!Object.keys(fields).length||fields.closed===false){assert.equal((await put(h,{appliedRevision:7,...fields})).status,200);assert.equal(row(h).active,true);assert.equal(row(h).confirmed,true);}else await rejected(h,{appliedRevision:7,...fields});
});

for(const revision of [6,8,'7',null,-1,1.5])test('stale future malformed catalog revision '+JSON.stringify(revision)+' rejects without mutation',async t=>{const h=await fixture(t);await rejected(h,{appliedRevision:revision});});

test('current catalog revision in another context cannot acknowledge old pending revision',async t=>{const h=await fixture(t);h.registry.currentCatalogRevision=()=>8;await rejected(h,{appliedRevision:7});});

test('acknowledgment requires identity generation principal and HTTP mutation authorization',async t=>{
 const h=await fixture(t);for(const generation of [0,999])await rejected(h,{appliedRevision:7,generation});
 const before=state(h);await assert.rejects(h.registry.confirmCatalog(row(h).id,row(h).generation,7,'foreign-principal'),{code:'CLIENT_GENERATION_CONFLICT'});
 const missing=await h.request('PUT','/api/media-library/reference-clients/'+h.client.clientId,{authenticated:false,body:{generation:1,appliedRevision:7}});assert.equal(missing.status,401);
 const csrf=await h.request('PUT','/api/media-library/reference-clients/'+h.client.clientId,{mutationAuthorized:false,body:{generation:1,appliedRevision:7}});assert.equal(csrf.status,403);assert.deepEqual(state(h),before);
});

test('client closed Preview retained cannot falsely acknowledge semantic completion',async t=>{
 const h=await fixture(t),revoke=h.preview.revokePrincipal;h.preview.revokePrincipal=async()=>{throw Object.assign(Error('fixture interrupted'),{code:'REFERENCE_AUDIT_UNAVAILABLE'});};assert.equal((await put(h,{closed:true,confirmed:false})).status,409);assert.equal(row(h).active,false);assert.equal(h.preview.sessions.size,1);
 await rejected(h,{appliedRevision:7,closed:true,confirmed:false});h.preview.revokePrincipal=revoke;await close(h);assert.equal((await put(h,{appliedRevision:7,closed:true,confirmed:false})).status,200);closed(h);
});

test('Preview released client active cannot falsely replay close',async t=>{const h=await fixture(t);await h.preview.revokePrincipal(row(h).principal+'|'+row(h).id);await rejected(h,{appliedRevision:7,closed:true,confirmed:false});assert.equal(row(h).active,true);});

test('persistence failure before client mutation cannot turn matching revision into success',async t=>{
 const h=await fixture(t),persist=h.registry.persist;h.registry.persist=async()=>{throw Object.assign(Error('fixture EIO'),{code:'EIO'});};assert.equal((await put(h,{closed:true,confirmed:false})).status,409);assert.equal(row(h).active,true);assert.equal(h.preview.sessions.size,1);h.registry.persist=persist;await rejected(h,{appliedRevision:7,closed:true,confirmed:false});
});

test('failed Preview persistence keeps replay fail closed and retained references visible',async t=>{
 const h=await fixture(t);h.preview.persist=async()=>{throw Object.assign(Error('fixture EIO'),{code:'EIO'});};assert.equal((await put(h,{closed:true,confirmed:false})).status,409);await rejected(h,{appliedRevision:7,closed:true,confirmed:false});assert.equal(h.preview.snapshot().complete,false);assert.equal(h.preview.snapshot().references.length,1);
});

test('catalog acknowledgment owns no new lifecycle revision and pure exact acknowledgment retry is idempotent',async t=>{
 const h=await fixture(t),before=row(h).generation,lastSeen=row(h).lastSeen;assert.equal((await put(h,{appliedRevision:7})).status,200);const first=state(h);assert.equal(row(h).pendingRevision,7);assert.equal(row(h).catalog,'RECONCILED');assert.equal((await put(h,{appliedRevision:7})).status,200);assert.deepEqual(state(h),first);assert.equal(row(h).generation,before);assert.equal(row(h).lastSeen,lastSeen);
 await h.registry.pendingCatalog(row(h).id,row(h).generation,8,row(h).principal);await rejected(h,{appliedRevision:7});
});

test('legacy acknowledgment uses same semantic fence and exact retry preserves legacy revision',async t=>{
 const h=await fixture(t),legacy=await h.registry.updateLegacy(row(h).id,row(h).generation,{assets:[],complete:true},row(h).principal);
 await rejected(h,{legacyAppliedRevision:legacy.revision,closed:true,confirmed:false});await close(h);
 assert.equal((await put(h,{legacyAppliedRevision:legacy.revision,closed:true,confirmed:false})).status,200);const first=state(h);assert.equal((await put(h,{legacyAppliedRevision:legacy.revision,closed:true,confirmed:false})).status,200);assert.deepEqual(state(h),first);assert.equal(row(h).legacyRevision,legacy.revision);
});

test('conflicting acknowledgment contexts reject before either owner changes',async t=>{const h=await fixture(t);await rejected(h,{appliedRevision:7,legacyAppliedRevision:1});});

test('observational inventory Preview and presence after replay remain mutation free through cleanup',async t=>{
 const h=await fixture(t);await close(h);await put(h,{appliedRevision:7,closed:true,confirmed:false});await h.observe(async()=>{assert.equal(h.preview.snapshot().references.length,0);assert.equal(h.registry.snapshot().clients[0].state,'DISCONNECTED');await h.getInventory();for(const method of ['GET','HEAD']){const response=await h.request(method,'/api/media-library/reference-presence',{headers:h.headers(h.client)});response.res.emit('finish');response.res.emit('close');await h.coordinator.run(()=>{});await new Promise(r=>setImmediate(r));}});
});

test('two identical replay requests are serialized and cannot duplicate close or revisions',async t=>{
 const h=await fixture(t);await close(h);const responses=await Promise.all([put(h,{appliedRevision:7,closed:true,confirmed:false}),put(h,{appliedRevision:7,closed:true,confirmed:false})]);assert.deepEqual(responses.map(r=>r.status),[200,200]);closed(h);assert.equal(row(h).generation,h.client.generation);
});

test('replay races with reconfirm update without obtaining mutation ownership',async t=>{
 const h=await fixture(t);await close(h);const results=await Promise.all([put(h,{appliedRevision:7,closed:true,confirmed:false}),put(h,{closed:false})]);assert.ok([200,409].includes(results[0].status));assert.equal(results[1].status,200);assert.equal(row(h).active,true);assert.equal(row(h).confirmed,true);await rejected(h,{appliedRevision:7,closed:true,confirmed:false});
});

test('resume generation fences old replay and clears prior epoch catalog acknowledgment context',async t=>{
 const h=await fixture(t);await close(h);const resume=h.request('POST','/api/media-library/reference-clients',{body:{role:'CONTROL',version:3,capabilities,resumeId:h.client.clientId,resumeGeneration:h.client.generation,resumeToken:h.client.resumeToken}});
 const replay=put(h,{appliedRevision:7,closed:true,confirmed:false});const [registered,ack]=await Promise.all([resume,replay]);assert.equal(registered.status,201);assert.ok([200,409].includes(ack.status));assert.equal(row(h).generation,h.client.generation+1);assert.equal(row(h).active,true);assert.equal(row(h).pendingRevision,undefined);
 await rejected(h,{appliedRevision:7,closed:true,confirmed:false});await rejected(h,{appliedRevision:7,generation:row(h).generation});
});

test('restart after close replay retains closed client released Preview and valid explicit acknowledgment context',async t=>{
 const h=await fixture(t);await close(h);await put(h,{appliedRevision:7,closed:true,confirmed:false});const next=new Registry({coordinator:h.coordinator,path:h.path,coverageProven:true,minimumVersion:3,requireEpoch:true});await next.ready;next.currentCatalogRevision=()=>7;const preview=new Preview({coordinator:h.coordinator,path:h.preview.path,validate:()=>{}});await preview.ready;const c=next.clients.get(h.client.clientId);assert.equal(c.active,false);assert.equal(c.termination,'EXPLICIT_CLOSE');assert.equal(preview.sessions.size,0);await next.confirmCatalog(c.id,c.generation,7,c.principal,value=>next.acknowledgmentMatches(value,{closed:true,confirmed:false},preview));assert.equal(c.active,false);
});

test('interrupted split reconstruction rejects replay until explicit canonical close retry completes',async t=>{
 const h=await fixture(t);h.preview.revokePrincipal=async()=>{throw Error('fixture interrupted');};assert.equal((await put(h,{closed:true,confirmed:false})).status,409);
 const next=new Registry({coordinator:h.coordinator,path:h.path,coverageProven:true,minimumVersion:3,requireEpoch:true});await next.ready;next.currentCatalogRevision=()=>7;const preview=new Preview({coordinator:h.coordinator,path:h.preview.path,validate:()=>{}});await preview.ready;const c=next.clients.get(h.client.clientId);
 await assert.rejects(next.confirmCatalog(c.id,c.generation,7,c.principal,value=>next.acknowledgmentMatches(value,{closed:true,confirmed:false},preview)),{code:'CLIENT_GENERATION_CONFLICT'});await next.update(c.id,c.generation,{closed:true,confirmed:false},c.principal);await preview.revokePrincipal(c.principal+'|'+c.id);await next.confirmCatalog(c.id,c.generation,7,c.principal,value=>next.acknowledgmentMatches(value,{closed:true,confirmed:false},preview));assert.equal(preview.sessions.size,0);
});

test('superseded invalid catalog status cannot be repaired by a numeric acknowledgment replay',async t=>{
 const h=await fixture(t);await put(h,{appliedRevision:7});await put(h,{catalog:'INVALID'});await rejected(h,{appliedRevision:7});
});

test('superseded invalid legacy status cannot acknowledge retained old pending assets',async t=>{
 const h=await fixture(t),legacy=await h.registry.updateLegacy(row(h).id,row(h).generation,{assets:[],complete:true},row(h).principal);await h.registry.updateLegacy(row(h).id,row(h).generation,{assets:[],complete:false},row(h).principal);await rejected(h,{legacyAppliedRevision:legacy.revision});
});

test.after(()=>observer.restore());
