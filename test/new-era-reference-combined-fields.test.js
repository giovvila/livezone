import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {previewReadFixture,observer} from '../test-support/PreviewReadFixture.js';
import {capabilities} from '../test-support/ReferenceReadFixture.js';
const {default:Registry}=await import('../server/media-library/ReferenceClientRegistry.js');
const {default:Preview}=await import('../server/media-library/PreviewOwnership.js');
const row=h=>h.registry.clients.get(h.client.clientId);
const put=(h,fields={})=>h.request('PUT','/api/media-library/reference-clients/'+h.client.clientId,{body:{generation:h.client.generation,...fields}});
const state=h=>({clients:structuredClone([...h.registry.clients]),preview:structuredClone([...h.preview.sessions])});
async function fixture(t){const h=await previewReadFixture(t);await h.open();await h.confirm(['fixture-reference']);return h;}
async function reject(h,fields){const before=state(h),bytes=await h.bytes();const r=await put(h,fields);assert.ok(r.status>=400);assert.deepEqual(state(h),before);assert.deepEqual(await h.bytes(),bytes);}

test('exact R16 RED to GREEN deconfirmation and INVALID catalog are one canonical mutation',async t=>{
 const h=await fixture(t),old=await readFile(new URL('../test-support/fixtures/reference-registry-r16.txt',import.meta.url),'utf8');const originalUpdate=new Function('referenceError','return ({'+old.slice(old.indexOf('    update(id,'),old.indexOf('    pendingCatalog')).trim()+'}).update;')(code=>Object.assign(Error(code),{code}));
 const current=h.registry.update;h.registry.update=originalUpdate;assert.equal((await put(h,{confirmed:false,catalog:'INVALID'})).status,200);assert.equal(row(h).confirmed,false);assert.equal(row(h).catalog,'PENDING');h.registry.update=current;await put(h);
 assert.equal((await put(h,{confirmed:false,catalog:'INVALID'})).status,200);assert.equal(row(h).confirmed,false);assert.equal(row(h).catalog,'INVALID');assert.equal(h.preview.sessions.size,1);const stored=JSON.parse(await readFile(h.path)).clients[0];assert.equal(stored.confirmed,false);assert.equal(stored.catalog,'INVALID');
});

for(const catalog of ['INVALID','CONFLICT'])for(const closed of [undefined,false,true])for(const confirmed of [undefined,false,true])test('combined catalog='+catalog+' closed='+closed+' confirmed='+confirmed,async t=>{
 const h=await fixture(t),fields={catalog,...(closed===undefined?{}:{closed}),...(confirmed===undefined?{}:{confirmed})};
 if(confirmed===true){await reject(h,fields);return;}assert.equal((await put(h,fields)).status,200);assert.equal(row(h).catalog,catalog);assert.equal(row(h).confirmed,confirmed!==false);assert.equal(row(h).active,closed!==true);assert.equal(h.preview.sessions.size,closed===true?0:1);if(closed===true)assert.equal(row(h).termination,'EXPLICIT_CLOSE');
});

for(const catalog of ['PENDING','RECONCILED','VALID','UNKNOWN','',null,false,true,0])test('public unsupported or server-owned catalog '+JSON.stringify(catalog)+' rejects by presence',async t=>{const h=await fixture(t);await reject(h,{catalog,confirmed:false});});

test('internal canonical PENDING RECONCILED INVALID CONFLICT values remain available to explicit server owners',async t=>{
 const h=await fixture(t);for(const catalog of ['PENDING','RECONCILED','INVALID','CONFLICT']){await h.registry.update(row(h).id,row(h).generation,{catalog},row(h).principal);assert.equal(row(h).catalog,catalog);assert.equal(h.preview.sessions.size,1);}
});

test('deconfirmation-only neither requires catalog nor changes Preview or lifecycle timestamp',async t=>{
 const h=await fixture(t),before=structuredClone(row(h)),preview=structuredClone([...h.preview.sessions]);await put(h,{confirmed:false});assert.deepEqual(row(h),{...before,confirmed:false});assert.deepEqual([...h.preview.sessions],preview);
});

for(const fields of [{catalog:'INVALID'},{catalog:'INVALID',confirmed:false},{closed:true,catalog:'INVALID'},{closed:true,catalog:'INVALID',confirmed:false}])test('acknowledgment does not swallow combined fields '+JSON.stringify(fields),async t=>{
 const h=await fixture(t);h.registry.currentCatalogRevision=()=>7;await h.registry.pendingCatalog(row(h).id,row(h).generation,7,row(h).principal);await reject(h,{appliedRevision:7,...fields});
});

for(const field of ['active','supported','principal','role','version','lastSeen','termination','legacyStatus','assets','complete','unknown'])test('main PUT rejects unsupported or read-only field '+field+' before dispatch',async t=>{const h=await fixture(t);await reject(h,{catalog:'INVALID',confirmed:false,[field]:false});});

test('legacy endpoint rejects lifecycle fields instead of swallowing them in higher dispatch branch',async t=>{
 const h=await fixture(t),before=state(h),bytes=await h.bytes();const response=await h.request('PUT','/api/media-library/reference-clients/'+h.client.clientId+'/legacy-assets',{body:{generation:h.client.generation,assets:[],complete:true,closed:true}});assert.equal(response.status,422);assert.deepEqual(state(h),before);assert.deepEqual(await h.bytes(),bytes);
 const valid=await h.request('PUT','/api/media-library/reference-clients/'+h.client.clientId+'/legacy-assets',{body:{generation:h.client.generation,assets:[],complete:true}});assert.equal(valid.status,200);assert.equal(row(h).legacyStatus,'PENDING');
});

test('combined canonical operation and postcondition check complete before one Registry persistence',async t=>{
 const h=await fixture(t),persist=h.registry.persist.bind(h.registry);let writes=0;h.registry.persist=async()=>{writes++;assert.equal(row(h).confirmed,false);assert.equal(row(h).catalog,'INVALID');await persist();};assert.equal((await put(h,{confirmed:false,catalog:'INVALID'})).status,200);assert.equal(writes,1);
});

test('combined client persistence failure rolls back every requested field and leaves Preview',async t=>{
 const h=await fixture(t),before=state(h);h.registry.persist=async()=>{throw Object.assign(Error('fixture EIO'),{code:'EIO'});};assert.equal((await put(h,{confirmed:false,catalog:'INVALID',closed:true})).status,409);assert.deepEqual(state(h),before);assert.equal(h.registry.available,false);
});

test('Preview interruption after combined close returns error and identical retry completes without catalog loss',async t=>{
 const h=await fixture(t),revoke=h.preview.revokePrincipal;h.preview.revokePrincipal=async()=>{throw Object.assign(Error('fixture interrupted'),{code:'REFERENCE_AUDIT_UNAVAILABLE'});};const body={closed:true,confirmed:false,catalog:'INVALID'};assert.equal((await put(h,body)).status,409);assert.equal(row(h).active,false);assert.equal(row(h).catalog,'INVALID');assert.equal(h.preview.sessions.size,1);h.preview.revokePrincipal=revoke;assert.equal((await put(h,body)).status,200);assert.equal(h.preview.sessions.size,0);assert.equal(row(h).catalog,'INVALID');
});

test('combined retry preserves canonical identity revision timestamps and releases Preview once',async t=>{
 const h=await fixture(t);let releases=0;h.preview.diagnostics={record:code=>{if(code==='PREVIEW_OWNERSHIP_RELEASED')releases++;}};const fields={closed:true,confirmed:false,catalog:'INVALID'};await put(h,fields);const before=state(h),bytes=await h.bytes();h.registry.clock=()=>99999;for(let n=0;n<4;n++){assert.equal((await put(h,fields)).status,200);assert.deepEqual(state(h),before);assert.deepEqual(await h.bytes(),bytes);}assert.equal(releases,1);
});

test('foreign principal stale generation and unknown combined identity reject with no partial fields',async t=>{
 const h=await fixture(t),before=state(h);await assert.rejects(h.registry.update(row(h).id,row(h).generation,{confirmed:false,catalog:'INVALID'},'foreign'),{code:'CLIENT_GENERATION_CONFLICT'});await reject(h,{generation:999,confirmed:false,catalog:'INVALID'});assert.deepEqual(state(h),before);
});

test('combined reads expose catalog and confirmation without invoking explicit owner',async t=>{
 const h=await fixture(t);await put(h,{confirmed:false,catalog:'INVALID'});await h.observe(async()=>{const census=h.registry.snapshot();assert.ok(census.reasons.includes('LEGACY_CATALOG_INVALID'));assert.equal(census.clients[0].state,'LEGACY/UNKNOWN');assert.equal(h.preview.snapshot().references.length,1);await h.getInventory();for(const method of ['GET','HEAD']){const r=await h.request(method,'/api/media-library/reference-presence',{headers:h.headers(h.client)});if(method==='GET')assert.match(r.chunks.join(''),/UNKNOWN/);r.res.emit('finish');r.res.emit('close');await h.coordinator.run(()=>{});await new Promise(resolve=>setImmediate(resolve));}});
});

test('concurrent identical updates and catalog deconfirm close races retain serialized postconditions',async t=>{
 const h=await fixture(t),results=await Promise.all([put(h,{confirmed:false,catalog:'INVALID'}),put(h,{confirmed:false,catalog:'INVALID'})]);assert.deepEqual(results.map(r=>r.status),[200,200]);assert.equal(row(h).catalog,'INVALID');assert.equal(row(h).confirmed,false);
 await Promise.all([put(h,{catalog:'CONFLICT'}),put(h,{confirmed:false})]);assert.equal(row(h).catalog,'CONFLICT');assert.equal(row(h).confirmed,false);
 await Promise.all([put(h,{catalog:'INVALID'}),put(h,{closed:true,confirmed:false})]);assert.equal(row(h).catalog,'INVALID');assert.equal(row(h).active,false);assert.equal(h.preview.sessions.size,0);
});

test('combined update racing resume is fenced to its own generation',async t=>{
 const h=await fixture(t);const update=put(h,{confirmed:false,catalog:'INVALID'}),resume=h.request('POST','/api/media-library/reference-clients',{body:{role:'CONTROL',version:3,capabilities,resumeId:h.client.clientId,resumeGeneration:h.client.generation,resumeToken:h.client.resumeToken}});const [changed,registered]=await Promise.all([update,resume]);assert.ok([200,409].includes(changed.status));assert.equal(registered.status,201);assert.equal(row(h).generation,h.client.generation+1);assert.equal(row(h).active,true);assert.equal(row(h).confirmed,true);await reject(h,{confirmed:false,catalog:'INVALID'});
});

test('successful combined close persists both fields and restart cannot reconstruct false success',async t=>{
 const h=await fixture(t);await put(h,{closed:true,confirmed:false,catalog:'INVALID'});const next=new Registry({coordinator:h.coordinator,path:h.path,coverageProven:true,minimumVersion:3,requireEpoch:true});await next.ready;const preview=new Preview({coordinator:h.coordinator,path:h.preview.path,validate:()=>{}});await preview.ready;const client=next.clients.get(h.client.clientId);assert.equal(client.active,false);assert.equal(client.confirmed,false);assert.equal(client.catalog,'INVALID');assert.equal(client.termination,'EXPLICIT_CLOSE');assert.equal(preview.sessions.size,0);
});

test.after(()=>observer.restore());
