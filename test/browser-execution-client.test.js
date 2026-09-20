import test from 'node:test';
import assert from 'node:assert/strict';
import Client from '../public/js/studio/BrowserExecutionOwnershipClient.js';
function harness(t){let now=0,id=0;const timers=new Map(),requests=[];let respond,grant={leaseId:'lease-a',ownerKind:'BROWSER'};
 const client=new Client({clock:()=>now,uuid:()=>String(++id),setTimer:(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;},clearTimer:id=>timers.delete(id),
 request:async(url,options)=>{requests.push({url,options});if(respond)return respond(url,options);return {ok:true,json:async()=>({state:{state:'BROWSER_OWNER'},grant,leaseRemainingMs:9000,retainedProgram:{source:{kind:'hls'}}})};}});
 t.after(()=>client.close());return {client,requests,timers,advance:ms=>now+=ms,setResponse:fn=>respond=fn};}
test('client renewal preserves document grant and retained bootstrap evidence',async t=>{
 const h=harness(t);await h.client.start();assert.ok(h.client.valid());const first=h.client.capture();await h.client.exchange('renew');assert.ok(h.client.valid(first.grant));assert.equal(h.client.retainedProgram.source.kind,'hls');
});
test('queued publication retains old grant and cannot borrow a new owner credential',async t=>{
 const h=harness(t);await h.client.start();const context=h.client.capture();h.advance(9001);
 const result=await h.client.publish('/api/program-output',{},context);assert.equal(result.status,409);assert.equal(h.requests.length,1);
 h.client.grant={leaseId:'new-lease'};h.client.deadline=20000;assert.equal((await h.client.publish('/api/program-output',{},context)).status,409);
});
test('late renewal cannot revive a closed document',async t=>{
 const h=harness(t);await h.client.start();let resolve;h.setResponse(async(_url,options)=>JSON.parse(options.body).operation==='release'?{ok:true,json:async()=>({})}:new Promise(r=>resolve=r));
 const renewal=h.client.exchange('renew');h.client.close();resolve({ok:true,json:async()=>({grant:{leaseId:'late'},leaseRemainingMs:9000})});
 await renewal;assert.equal(h.client.valid(),false);assert.equal(h.timers.size,0);
});
test('authority rejection leaves prior owner passive instead of automatically acquiring again',async t=>{
 const h=harness(t);await h.client.start();h.setResponse(async()=>({ok:true,json:async()=>({state:{state:'NO_OWNER',reason:'STALE_GRANT'},grant:null})}));
 await h.client.exchange('renew');assert.equal(h.client.grant,null);assert.equal(h.timers.size,0);
});

test('transient reconnect revalidates the unexpired lease without extending its local deadline',async t=>{
 const h=harness(t);await h.client.start();const deadline=h.client.deadline;
 h.setResponse(async()=>{throw Error('network partition');});await h.client.exchange('renew');
 assert.ok(h.client.valid());assert.equal(h.client.deadline,deadline);
 h.advance(9001);assert.equal(h.client.valid(),false);
});
test('passive Control bridge does not report INACTIVE over another owner LIVE observation',async()=>{
 const {default:Bridge}=await import('../public/js/studio/AutoLiveLegacyBridge.js');const calls=[];
 const bridge=Object.create(Bridge.prototype);bridge.client={observeBrowserStage:stage=>calls.push(stage)};
 bridge.executionOwnership={valid:()=>false};bridge.reportBrowserStage({session:null});assert.deepEqual(calls,[]);
 bridge.executionOwnership={valid:()=>true};bridge.reportBrowserStage({session:{phase:'LIVE'}});assert.deepEqual(calls,['LIVE']);
});

test('late reconciliation response cannot revive a closed document',async t=>{
 const h=harness(t);let resolve;h.setResponse(()=>new Promise(r=>resolve=r));
 const pending=h.client.reconcileRequest('reconcile',{reconciliationId:'reviewed',expected:{authorityEpoch:14}});
 h.client.close();resolve({ok:true,json:async()=>({state:{state:'BROWSER_OWNER'},grant:{leaseId:'late'},leaseRemainingMs:9000})});
 assert.equal((await pending).error,'STALE_RESPONSE');assert.equal(h.client.valid(),false);assert.equal(h.timers.size,0);
});
test('reconciliation network time consumes lease budget',async t=>{
 const h=harness(t);h.setResponse(async()=>{h.advance(10000);return {ok:true,json:async()=>({state:{state:'BROWSER_OWNER'},grant:{leaseId:'late'},leaseRemainingMs:9000})};});
 const result=await h.client.reconcileRequest('reconcile',{reconciliationId:'reviewed',expected:{authorityEpoch:14}});
 assert.equal(result.error,'LEASE_EXPIRED');assert.equal(h.client.valid(),null);assert.equal(h.timers.size,0);
});
