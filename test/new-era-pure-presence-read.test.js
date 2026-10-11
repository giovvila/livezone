import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {referenceReadFixture,observer} from '../test-support/ReferenceReadFixture.js';
import {previewReadFixture} from '../test-support/PreviewReadFixture.js';
const {default:Registry}=await import('../server/media-library/ReferenceClientRegistry.js');
const drain=async h=>{await h.coordinator.run(()=>{});await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));await h.coordinator.run(()=>{});};
const get=(h,c)=>h.request('GET','/api/media-library/reference-presence',{headers:h.headers(c)});
const finish=async(h,r,event='close')=>{r.res.emit(event);r.res.emit('finish');r.res.emit('close');await drain(h);};
const record=(h,c)=>h.registry.clients.get(c.clientId);
const reconcile=(h,c,body={})=>h.request('PUT','/api/media-library/reference-clients/'+c.clientId,{body:{generation:c.generation,...body}});

test('exact R13 RED to GREEN across actual GET close and deferred finalizer',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();
 const old=await readFile(new URL('../test-support/fixtures/reference-registry-r13.txt',import.meta.url),'utf8');
 const begin=old.indexOf('    presence(id,'),end=old.indexOf('    revokePrincipal',begin);
 const oldPresence=new Function('referenceError','return ({'+old.slice(begin,end).trim()+'}).presence;')((code)=>Object.assign(Error(code),{code}));
 const current=h.registry.presence;h.registry.presence=oldPresence;
 const r=await get(h,c);await finish(h,r);assert.equal(record(h,c).confirmed,false);
 h.registry.presence=current;await reconcile(h,c);h.registry.presenceEvidence.clear();
 await h.observe(async()=>{const green=await get(h,c);assert.match(green.chunks.join(''),/CURRENT_CAPABLE/);await finish(h,green);});
 assert.equal(record(h,c).confirmed,true);assert.equal(h.registry.effectiveConfirmation(record(h,c)),false);
});

test('active presence view and full lifecycle preserve canonical client and Preview leases',async t=>{
 const h=await previewReadFixture(t);await h.open();await h.confirm();
 await h.observe(async()=>{const r=await get(h,h.client);assert.match(r.chunks.join(''),/CURRENT_CAPABLE/);assert.equal(h.registry.effectiveConfirmation(record(h,h.client)),true);await finish(h,r);});
 assert.equal([...h.preview.sessions.values()][0].confirmed,true);
});

test('repeated absent polling reports UNKNOWN without confirming or accumulating canonical effects',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();await finish(h,await get(h,c));
 await h.observe(async()=>{for(let n=0;n<15;n++){const r=await get(h,c);assert.match(r.chunks.join(''),/UNKNOWN/);await finish(h,r);}});
 assert.equal(record(h,c).confirmed,true);assert.equal(h.mediaRoutes.presenceConnections.size,0);
});

test('known unconfirmed GET never confirms and unknown GET never registers',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();await reconcile(h,c,{confirmed:false});
 await h.observe(async()=>{const r=await get(h,c);assert.match(r.chunks.join(''),/UNKNOWN/);await finish(h,r);const unknown=await h.request('GET','/api/media-library/reference-presence');assert.equal(unknown.status,409);await finish(h,unknown);});
 assert.equal(h.registry.clients.size,1);assert.equal(record(h,c).confirmed,false);
});

for(const event of ['finish','close','error','aborted'])test('full-lifecycle sentinel '+event+' cleanup is idempotent',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();
 await h.observe(async()=>{const r=await get(h,c);if(event==='aborted')r.req.emit('aborted');else r.res.emit(event);await finish(h,r);});
 assert.equal(h.mediaRoutes.presenceConnections.size,0);assert.equal(record(h,c).confirmed,true);
});

test('explicit authenticated reconciliation persists loss idempotently and isolates sibling clients',async t=>{
 const h=await referenceReadFixture(t),c=await h.register(),other=await h.register();let now=1000;h.registry.clock=()=>now++;
 const sibling=structuredClone(record(h,other));await finish(h,await get(h,c));
 assert.equal((await reconcile(h,c,{confirmed:false})).status,200);const once=structuredClone(record(h,c));
 assert.equal((await reconcile(h,c,{confirmed:false})).status,200);assert.deepEqual(record(h,c),once);assert.deepEqual(record(h,other),sibling);
 assert.equal(JSON.parse(await readFile(h.path)).clients.find(x=>x.id===c.clientId).confirmed,false);
 assert.equal((await reconcile(h,c)).status,200);assert.equal(record(h,c).confirmed,true);
});

test('liveness boundary before final close at close and after close has no invented TTL',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();
 await h.observe(async()=>{const r=await get(h,c);assert.equal(h.registry.effectiveConfirmation(record(h,c)),true);await finish(h,r);assert.equal(h.registry.effectiveConfirmation(record(h,c)),false);await drain(h);assert.equal(h.registry.effectiveConfirmation(record(h,c)),false);});
});

test('multiple GETs retain presence until last close; parallel reads cannot reconfirm absence',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();
 await h.observe(async()=>{const responses=await Promise.all(Array.from({length:12},()=>get(h,c)));for(const r of responses.slice(0,-1))await finish(h,r);assert.equal(h.registry.effectiveConfirmation(record(h,c)),true);await finish(h,responses.at(-1));assert.equal(h.registry.effectiveConfirmation(record(h,c)),false);});
});

test('GET interleaved with explicit deconfirmation and update preserves mutating owner result',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();const r=await get(h,c);await reconcile(h,c,{confirmed:false});await h.observe(()=>finish(h,r));assert.equal(record(h,c).confirmed,false);
 await reconcile(h,c);const next=await get(h,c);await reconcile(h,c,{closed:true});await h.observe(()=>finish(h,next));assert.equal(record(h,c).active,false);
 const resumed=await h.request('POST','/api/media-library/reference-clients',{body:{role:'CONTROL',version:3,capabilities:['canonical-catalog','preview-ownership-v2','asset-validation','channel-logo-authority-v1'],resumeId:c.clientId,resumeGeneration:c.generation,resumeToken:c.resumeToken}});assert.equal(resumed.status,201);assert.equal(resumed.body.client.generation,c.generation+1);
});

test('restart adoption and stale or foreign identity remain fail closed without GET writes',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();const disk=await readFile(h.path);
 const next=new Registry({coordinator:h.coordinator,path:h.path,coverageProven:true,minimumVersion:3,requireEpoch:true});await next.ready;
 const client=next.clients.get(c.clientId);assert.equal(client.confirmed,false);assert.equal(next.effectiveConfirmation(client),false);assert.equal(next.snapshot().state,'INCOMPLETE');assert.deepEqual(await readFile(h.path),disk);
 await h.observe(async()=>{for(const headers of [{...h.headers(c),'x-livezone-reference-generation':'999'},{...h.headers(c),'x-livezone-reference-client':'00000000-0000-4000-8000-000000000000'}]){const r=await h.request('GET','/api/media-library/reference-presence',{headers});assert.equal(r.status,409);await finish(h,r);}});
 await assert.rejects(next.presence(c.clientId,c.generation,h.principal,true),{code:'CLIENT_CAPABILITY_REQUIRED'});
});

test('absence vetoes authority even while stored confirmation remains true',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();record(h,c).catalog='RECONCILED';record(h,c).legacyStatus='RECONCILED';assert.equal(h.registry.snapshot().state,'COMPLETE');
 await h.observe(async()=>{await finish(h,await get(h,c));assert.equal(h.registry.snapshot().state,'INCOMPLETE');assert.ok(h.registry.snapshot().reasons.includes('AUTHENTICATED_CLIENT_UNCONFIRMED'));assert.equal(h.registry.snapshot().clients[0].state,'LEGACY/UNKNOWN');});
});

test('HEAD shared middleware completes without canonical mutation or presence allocation',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();await h.observe(async()=>{const r=await h.request('HEAD','/api/media-library/reference-presence',{headers:h.headers(c)});assert.equal(r.status,404);await finish(h,r);});assert.equal(h.mediaRoutes.presenceConnections,undefined);
});

test('explicit revocation deconfirms only matching principal and invalid reconciliation is rejected',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();assert.equal((await reconcile(h,c,{confirmed:true})).status,409);await h.registry.revokePrincipal(h.principal);assert.equal(record(h,c).confirmed,false);assert.equal(record(h,c).termination,'SESSION_REVOKED');
});

test.after(()=>observer.restore());
