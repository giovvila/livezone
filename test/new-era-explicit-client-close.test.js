import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {previewReadFixture,observer} from '../test-support/PreviewReadFixture.js';
import {capabilities} from '../test-support/ReferenceReadFixture.js';
const {default:Registry}=await import('../server/media-library/ReferenceClientRegistry.js');
const {default:Preview}=await import('../server/media-library/PreviewOwnership.js');
const row=h=>h.registry.clients.get(h.client.clientId);
const put=(h,fields={},id=h.client.clientId)=>h.request('PUT','/api/media-library/reference-clients/'+id,{body:{generation:h.client.generation,...fields}});
async function fixture(t,assets=[]){const h=await previewReadFixture(t);await h.open();await h.confirm(assets);return h;}
const closed=h=>{assert.equal(row(h).active,false);assert.equal(row(h).termination,'EXPLICIT_CLOSE');assert.equal(h.preview.sessions.size,0);assert.equal(h.registry.snapshot().clients[0].state,'DISCONNECTED');};
const drain=async h=>{await h.coordinator.run(()=>{});await Promise.resolve();await new Promise(r=>setImmediate(r));await h.coordinator.run(()=>{});};

test('exact R14 RED to GREEN actual combined close persists canonical close before Preview release',async t=>{
 const h=await fixture(t),text=await readFile(new URL('../test-support/fixtures/reference-registry-r14.txt',import.meta.url),'utf8');
 const oldUpdate=new Function('referenceError','return ({'+text.slice(text.indexOf('    update(id,'),text.indexOf('    pendingCatalog')).trim()+'}).update;')(code=>Object.assign(Error(code),{code}));
 const current=h.registry.update;h.registry.update=oldUpdate;assert.equal((await put(h,{closed:true,confirmed:false})).status,200);assert.equal(row(h).active,true);assert.equal(row(h).termination,undefined);assert.equal(h.preview.sessions.size,0);
 h.registry.update=current;await put(h);await h.open();await h.confirm();assert.equal((await put(h,{closed:true,confirmed:false})).status,200);closed(h);assert.equal(row(h).confirmed,false);
 const disk=JSON.parse(await readFile(h.path));assert.equal(disk.clients[0].active,false);assert.equal(disk.clients[0].termination,'EXPLICIT_CLOSE');assert.equal(JSON.parse(await readFile(h.preview.path)).sessions.length,0);
});

for(const [close,confirm]of [[true,false],[true,true],[false,false],[false,true]])test('closed='+close+' confirmed='+confirm+' retains explicit API contract',async t=>{
 const h=await fixture(t),before=structuredClone(row(h)),preview=structuredClone([...h.preview.sessions]);const response=await put(h,{closed:close,confirmed:confirm});
 if(confirm){assert.equal(response.status,409);assert.deepEqual(row(h),before);assert.deepEqual([...h.preview.sessions],preview);}
 else{assert.equal(response.status,200);assert.equal(row(h).confirmed,false);assert.equal(row(h).active,!close);if(close)closed(h);else{assert.equal(row(h).termination,undefined);assert.deepEqual([...h.preview.sessions],preview);}}
});

for(const fields of [{},{closed:false},{confirmed:false},{closed:true},{closed:true,confirmed:false}])test('field presence '+JSON.stringify(fields)+' is preserved',async t=>{
 const h=await fixture(t),generation=row(h).generation;assert.equal((await put(h,fields)).status,200);assert.equal(row(h).generation,generation);
 if(fields.closed)closed(h);else{assert.equal(row(h).active,true);assert.equal(h.preview.sessions.size,1);}
 assert.equal(row(h).confirmed,fields.confirmed!==false);
});

test('invalid booleans reject before client and Preview mutations',async t=>{
 const h=await fixture(t),before=structuredClone(row(h)),preview=structuredClone([...h.preview.sessions]),bytes=await h.bytes();
 for(const fields of [{closed:'true'},{closed:1},{closed:null},{confirmed:'false'},{confirmed:null},{closed:true,confirmed:true}]){assert.equal((await put(h,fields)).status,409);assert.deepEqual(row(h),before);assert.deepEqual([...h.preview.sessions],preview);assert.deepEqual(await h.bytes(),bytes);}
});

test('close retry preserves identity counters timestamp and releases each Preview only once',async t=>{
 const h=await fixture(t);let now=1000,release=0;h.registry.clock=()=>now++;h.preview.diagnostics={record:code=>{if(code==='PREVIEW_OWNERSHIP_RELEASED')release++;}};
 await put(h,{closed:true,confirmed:false});const before=structuredClone(row(h)),bytes=await h.bytes();
 for(let n=0;n<5;n++){assert.equal((await put(h,{closed:true,confirmed:false})).status,200);closed(h);assert.deepEqual(row(h),before);assert.deepEqual(await h.bytes(),bytes);}assert.equal(release,1);
 await put(h,{closed:true});assert.equal(row(h).confirmed,false);assert.deepEqual(row(h),before);
});

test('successful response follows persisted client close and Preview release in original order',async t=>{
 const h=await fixture(t),events=[];const persist=h.registry.persist.bind(h.registry),revoke=h.preview.revokePrincipal.bind(h.preview);
 h.registry.persist=async()=>{events.push('client persist');await persist();};h.preview.revokePrincipal=async p=>{assert.equal(row(h).termination,'EXPLICIT_CLOSE');assert.equal(JSON.parse(await readFile(h.path)).clients[0].active,false);events.push('Preview release');await revoke(p);events.push('Preview persisted');};
 assert.equal((await put(h,{closed:true,confirmed:false})).status,200);assert.deepEqual(events,['client persist','Preview release','Preview persisted']);closed(h);
});

test('interruption before Preview release returns error and deterministic retry completes close',async t=>{
 const h=await fixture(t),revoke=h.preview.revokePrincipal;h.preview.revokePrincipal=async()=>{throw Object.assign(Error('fixture interruption'),{code:'REFERENCE_AUDIT_UNAVAILABLE'});};
 assert.equal((await put(h,{closed:true,confirmed:false})).status,409);assert.equal(row(h).active,false);assert.equal(row(h).termination,'EXPLICIT_CLOSE');assert.equal(h.preview.sessions.size,1);
 h.preview.revokePrincipal=revoke;assert.equal((await put(h,{closed:true,confirmed:false})).status,200);closed(h);
});

test('Preview persistence fault fails closed retains references and restart retry recovers',async t=>{
 const h=await fixture(t,['fixture-asset']),persist=h.preview.persist;h.preview.persist=async()=>{throw Object.assign(Error('fixture disk failure'),{code:'EIO'});};
 assert.equal((await put(h,{closed:true,confirmed:false})).status,409);assert.equal(row(h).active,false);assert.equal(h.preview.available,false);assert.equal(h.preview.snapshot().complete,false);assert.equal(h.preview.sessions.size,1);assert.equal(h.preview.snapshot().references[0].assetId,'fixture-asset');
 h.preview.persist=persist;const adopted=new Preview({coordinator:h.coordinator,path:h.preview.path,validate:()=>{}});await adopted.ready;h.mediaRoutes.previewOwnership=adopted;h.preview=adopted;
 assert.equal((await put(h,{closed:true,confirmed:false})).status,200);closed(h);
});

test('Registry persistence fault cannot release Preview and does not return success',async t=>{
 const h=await fixture(t),before=structuredClone(row(h)),preview=structuredClone([...h.preview.sessions]);h.registry.persist=async()=>{throw Object.assign(Error('fixture client persist failure'),{code:'EIO'});};
 assert.equal((await put(h,{closed:true,confirmed:false})).status,409);assert.deepEqual(row(h),before);assert.deepEqual([...h.preview.sessions],preview);assert.equal(h.registry.available,false);
});

test('wrong principal generation stale and foreign identity reject before either mutation',async t=>{
 const h=await fixture(t),before=structuredClone(row(h)),preview=structuredClone([...h.preview.sessions]);
 await assert.rejects(h.registry.update(h.client.clientId,h.client.generation,{closed:true,confirmed:false},'foreign'),{code:'CLIENT_GENERATION_CONFLICT'});
 for(const fields of [{generation:999},{generation:0}])assert.equal((await put(h,{closed:true,confirmed:false,...fields})).status,409);
 const foreign=await h.registry.register({role:'CONTROL',version:3,capabilities},'other-principal');assert.equal((await put(h,{closed:true,confirmed:false,generation:foreign.generation},foreign.clientId)).status,409);
 assert.deepEqual(row(h),before);assert.deepEqual([...h.preview.sessions],preview);
});

test('unknown close rejects without creating placeholder or releasing Preview',async t=>{
 const h=await fixture(t),before=structuredClone([...h.registry.clients]),preview=structuredClone([...h.preview.sessions]);assert.equal((await put(h,{closed:true,confirmed:false},'00000000-0000-4000-8000-000000000000')).status,409);assert.deepEqual([...h.registry.clients],before);assert.deepEqual([...h.preview.sessions],preview);
});

for(const assets of [[],['one'],['one','two','three'],['stale-retained-id']])test('explicit close releases only matching Preview references '+JSON.stringify(assets),async t=>{
 const h=await fixture(t,assets),other=await h.preview.open('unrelated-principal');await h.preview.update(other.sessionId,'unrelated-principal',{generation:other.generation,sequence:1,assets:['sibling'],complete:true});const unrelated=structuredClone(h.preview.sessions.get(other.sessionId));
 await put(h,{closed:true,confirmed:false});assert.equal(row(h).active,false);assert.equal(h.preview.sessions.size,1);assert.deepEqual(h.preview.sessions.get(other.sessionId),unrelated);assert.deepEqual(h.preview.snapshot().references.map(x=>x.assetId),['sibling']);
});

test('restart keeps canonical explicit close and Preview empty without adoption resurrection',async t=>{
 const h=await fixture(t);await put(h,{closed:true,confirmed:false});const bytes=await h.bytes();const next=new Registry({coordinator:h.coordinator,path:h.path,coverageProven:true,minimumVersion:3,requireEpoch:true});await next.ready;const preview=new Preview({coordinator:h.coordinator,path:h.preview.path,validate:()=>{}});await preview.ready;
 const client=next.clients.get(h.client.clientId);assert.equal(client.active,false);assert.equal(client.termination,'EXPLICIT_CLOSE');assert.equal(client.confirmed,false);assert.equal(next.snapshot().clients[0].state,'DISCONNECTED');assert.equal(preview.sessions.size,0);assert.deepEqual(await h.bytes(),bytes);
});

test('closed client UI census presence inventory and Preview reads remain observational',async t=>{
 const h=await fixture(t);await put(h,{closed:true,confirmed:false});await h.observe(async()=>{
 assert.equal(h.registry.snapshot().clients[0].state,'DISCONNECTED');assert.equal(h.preview.snapshot().references.length,0);
 const inventory=await h.getInventory();assert.equal(inventory.status,200);
 for(const method of ['GET','HEAD']){const response=await h.request(method,'/api/media-library/reference-presence',{headers:h.headers(h.client)});assert.equal(response.status,method==='GET'?409:404);response.res.emit('finish');response.res.emit('close');await drain(h);}
 });closed(h);
});

test('explicit authenticated resume remains the new-generation owner after close',async t=>{
 const h=await fixture(t);await put(h,{closed:true,confirmed:false});const response=await h.request('POST','/api/media-library/reference-clients',{body:{role:'CONTROL',version:3,capabilities,resumeId:h.client.clientId,resumeGeneration:h.client.generation,resumeToken:h.client.resumeToken}});assert.equal(response.status,201);assert.equal(response.body.client.generation,h.client.generation+1);assert.equal(h.registry.clients.size,1);assert.equal(row(h).active,true);assert.equal(row(h).confirmed,true);
});

test.after(()=>observer.restore());
