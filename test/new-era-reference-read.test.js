import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {referenceReadFixture,observer,capabilities} from '../test-support/ReferenceReadFixture.js';
import {pureScheduleFixture} from '../test-support/PureScheduleReadFixture.js';
const {default:ReferenceClient}=await import('../public/js/studio/ReferenceClient.js');

for(const method of ['GET','HEAD'])test('exact ERA26 '+method+' RED to GREEN: no implicit registry registration',async t=>{
 const h=await referenceReadFixture(t);const green=await h.observe(()=>h.request(method));
 assert.equal(green.status,method==='GET'?200:405);assert.equal(h.registry.clients.size,0);
 assert.equal(green.req.referenceClient,null);assert.equal(green.req.referenceClientStatus,'REGISTRATION_REQUIRED');
 assert.ok(h.registry.snapshot().reasons.includes('CLIENT_CAPABILITY_UNKNOWN'));
 const legacy=await readFile(new URL('../test-support/fixtures/reference-request-era26.txt',import.meta.url),'utf8');
 const prior=new Function('referenceClients','createHash',legacy+'return identifyReferenceRequest;')(h.registry,createHash);
 observer.enable();try{await prior({method,url:'/api/studio/schedule',headers:{}},h.session);}finally{observer.disable();}
 assert.equal(h.registry.clients.size,1);assert.ok(observer.counts.write>0);assert.ok(observer.counts.rename>0);
 assert.equal(JSON.parse(await readFile(h.path,'utf8')).clients[0].observationOnly,true);
});

for(const method of ['GET','HEAD'])test('known client '+method+' identifies stored record without timestamp or content update',async t=>{
 const h=await referenceReadFixture(t),c=await h.register(),headers=h.headers(c);
 const r=await h.observe(()=>h.request(method,'/api/studio/schedule',{headers}));
 assert.equal(r.req.referenceClient.id,c.clientId);assert.equal(r.req.referenceClientStatus,'CURRENT_CAPABLE');assert.equal(h.registry.unregisteredPrincipals.size,0);
});

for(const kind of ['generation','id','principal','inactive','unsupported'])test('changed '+kind+' metadata cannot update registry through GET',async t=>{
 const h=await referenceReadFixture(t),c=await h.register(),headers=h.headers(c);
 if(kind==='generation')headers['x-livezone-reference-generation']='999';
 if(kind==='id')headers['x-livezone-reference-client']='00000000-0000-4000-8000-000000000000';
 if(kind==='principal')h.registry.clients.get(c.clientId).principal='foreign';
 if(kind==='inactive')await h.registry.update(c.clientId,c.generation,{closed:true},h.principal);
 if(kind==='unsupported')h.registry.clients.get(c.clientId).supported=false;
 const r=await h.observe(()=>h.request('GET','/api/studio/schedule',{headers}));assert.equal(r.status,200);assert.equal(r.req.referenceClient,null);
});

test('query identity used by SSE remains an observation and mismatched generation requires registration',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();
 const r=await h.observe(()=>h.request('GET','/api/studio/schedule?referenceClient='+c.clientId+'&referenceGeneration='+c.generation));assert.equal(r.req.referenceClient.id,c.clientId);
 await h.observe(()=>h.request('GET','/api/studio/schedule?referenceClient='+c.clientId+'&referenceGeneration=999'));
});

test('all three shared HTTP route branches read without persistence, including rejected HEAD',async t=>{
 const h=await referenceReadFixture(t);
 await h.observe(async()=>{
  for(const url of ['/api/studio/schedule','/api/studio/state','/api/media-library/assets','/api/media-library/reference-inventory']){
   assert.equal((await h.request('GET',url)).status,200);
   const head=await h.request('HEAD',url);assert.ok([404,405].includes(head.status));
  }
  assert.equal((await h.request('GET','/api/media-library/reference-presence')).status,409);
 });
});

test('operator authorization and CSRF precede identity classification and explicit lifecycle mutation',async t=>{
 const h=await referenceReadFixture(t);
 await h.observe(async()=>{
  const denied=await h.request('GET','/api/studio/schedule',{authenticated:false});assert.equal(denied.status,401);assert.equal(denied.req.operatorReferencePrincipal,undefined);
  const rejected=await h.request('POST','/api/media-library/reference-clients',{mutationAuthorized:false,body:{role:'CONTROL',version:3,capabilities}});assert.equal(rejected.status,403);assert.equal(h.registry.unregisteredPrincipals.size,0);
 });
});

test('authorized POST registration and PUT updates retain persistence and stale-update protection',async t=>{
 const h=await referenceReadFixture(t);observer.enable();let c;try{c=await h.register();}finally{observer.disable();}assert.ok(observer.counts.write>0);assert.ok(observer.counts.rename>0);
 const before=await readFile(h.path);
 const updated=await h.request('PUT','/api/media-library/reference-clients/'+c.clientId,{body:{generation:c.generation,catalog:'CONFLICT'}});assert.equal(updated.status,200);assert.notDeepEqual(await readFile(h.path),before);
 const bytes=await readFile(h.path);const rejected=await h.request('PUT','/api/media-library/reference-clients/'+c.clientId,{body:{generation:999,catalog:'INVALID'}});assert.equal(rejected.status,409);assert.deepEqual(await readFile(h.path),bytes);
});

test('concurrent known and unknown GETs cannot race into durable registrations',async t=>{
 const h=await referenceReadFixture(t),c=await h.register();
 const responses=await h.observe(()=>Promise.all(Array.from({length:32},(_,i)=>h.request('GET','/api/studio/schedule',{headers:i%2?h.headers(c):{}}))));
 assert.ok(responses.every(r=>r.status===200));assert.equal(h.registry.clients.size,1);assert.equal(h.registry.unregisteredPrincipals.size,1);
});

test('GET while an explicit registration is queued does not own or duplicate its work',async t=>{
 const h=await referenceReadFixture(t);let release;const parked=h.coordinator.run(()=>new Promise(resolve=>{release=resolve;}));await Promise.resolve();
 const pending=h.register();await Promise.resolve();
 await h.observe(()=>Promise.all(Array.from({length:8},()=>h.request())));assert.equal(h.registry.clients.size,0);
 release();await parked;await pending;assert.equal(h.registry.clients.size,1);
});

for(const kind of ['missing','corrupt','foreign','unreadable'])test(kind+' registry GET is fail closed without repair',async t=>{
 const h=await referenceReadFixture(t,{...(kind==='corrupt'?{initial:'{broken'}:{}),...(kind==='foreign'?{initial:JSON.stringify({version:99,clients:[]})}:{}),unreadable:kind==='unreadable'});
 const r=await h.observe(()=>h.request());assert.equal(r.status,200);assert.equal(r.req.referenceClient,null);
 if(kind!=='missing')assert.equal(r.req.referenceClientStatus,'REGISTRY_UNAVAILABLE');
 assert.equal(h.registry.snapshot().state,'INCOMPLETE');
});

test('combined canonical pending Schedule GET/HEAD preserves WAL, Schedule, registry and execution ownership',async t=>{
 const s=await pureScheduleFixture(t),h=await referenceReadFixture(t,{scheduleRoutes:s.routes});
 await s.observe(()=>h.observe(async()=>{
  const r=await h.request();assert.equal(r.status,200);assert.equal(r.body.runtime.reconciliationRequired,true);assert.equal(r.req.referenceClient,null);
  assert.equal((await h.request('HEAD')).status,405);
 }));assert.equal((await s.owner.ledger.inspect(s.identity)).status,'UNCONSUMED');
});

test('UI explicit initialization registers once; polling and presence identity never register again',async t=>{
 const h=await referenceReadFixture(t);let post=0;const client=new ReferenceClient({role:'CONTROL',storage:null,eventSourceFactory:null,request:async(url,o)=>{
  if(o?.method==='POST')post++;const r=await h.request(o?.method??'GET',url,{body:o?.body?JSON.parse(o.body):undefined});return {ok:r.status<400,json:async()=>r.body};
 }});
 const identity=await client.initialize();assert.equal(post,1);
 await h.observe(()=>Promise.all(Array.from({length:16},()=>h.request('GET','/api/studio/schedule',{headers:h.headers(identity)}))));assert.equal(post,1);assert.equal(h.registry.clients.size,1);
});

test('known presence connection and disconnection retain durable bytes and lastSeen without native effects',async t=>{
 const h=await referenceReadFixture(t),c=await h.register(),before=await h.bytes(),lastSeen=h.registry.clients.get(c.clientId).lastSeen;
 for(const key of Object.keys(observer.counts))observer.counts[key]=0;
 observer.enable();try{
  const r=await h.request('GET','/api/media-library/reference-presence',{headers:h.headers(c)});assert.equal(r.status,200);
  assert.match(r.chunks.join(''),/CURRENT_CAPABLE/);r.res.emit('close');await h.coordinator.run(()=>{});await Promise.resolve();
 }finally{observer.disable();}
 assert.deepEqual(observer.counts,Object.fromEntries(Object.keys(observer.counts).map(k=>[k,0])));assert.deepEqual(await h.bytes(),before);
 assert.equal(h.registry.clients.get(c.clientId).lastSeen,lastSeen);assert.equal(h.registry.clients.get(c.clientId).confirmed,true);
 assert.equal(h.registry.effectiveConfirmation(h.registry.clients.get(c.clientId)),false);
});

test('unknown participation keeps safe deletion incomplete until positive session revocation',async t=>{
 const h=await referenceReadFixture(t);await h.observe(()=>h.request());
 assert.ok(h.registry.snapshot().reasons.includes('CLIENT_CAPABILITY_UNKNOWN'));
 const c=await h.register();h.registry.clients.get(c.clientId).catalog='RECONCILED';h.registry.clients.get(c.clientId).legacyStatus='RECONCILED';
 assert.equal(h.registry.snapshot().state,'INCOMPLETE');
 h.registry.isSessionRevoked=()=>true;h.registry.authenticatedPrincipals=()=>[];assert.equal(h.registry.snapshot().state,'COMPLETE');
});

test.after(()=>observer.restore());
