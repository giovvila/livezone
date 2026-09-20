import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProgramOutputServer} from '../server/program-output-server.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
const token='ownership-test-publisher-token';
function envelope(session='publisher-a',revision=1){const at=new Date().toISOString();const snapshot={version:1,revision,publisherSessionId:session,publishedAt:at,committedAt:at,scene:null,source:null,playback:{initialTime:0,duration:null,playing:false,ended:false,state:'ready',startedAt:at},graphics:{items:[]},transition:{type:'cut',durationMs:0}};return {protocolVersion:1,publisherSessionId:session,revision,publishedAt:at,snapshot};}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'lz-owner-'));let now=1000;
 const auth=new OperatorAuth({username:'operator',password:'ownership-test-password',secureCookie:false});
 const session=auth.authenticate('operator','ownership-test-password'),cookie=auth.createCookie(session).split(';')[0];
 const make=()=>createProgramOutputServer({publisherToken:token,operatorAuth:auth,studioStatePath:join(dir,'studio.json'),schedulePath:join(dir,'schedule.json'),mediaLibraryRoot:join(dir,'media'),executionClock:()=>now,executionLeaseMs:1000});
 let owner=make();const start=async()=>{await new Promise(r=>owner.server.listen(0,'127.0.0.1',r));};await start();
 const close=async()=>{owner.server.closeAllConnections();await new Promise(r=>owner.server.close(r));};
 t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 const request=async(path,body,extra={},authenticated=true,method='POST')=>{const origin='http://127.0.0.1:'+owner.server.address().port;const res=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...(authenticated?{Cookie:cookie,Origin:origin,'X-Livezone-Operator-Request':'1','X-Livezone-CSRF':session.csrfToken}:{}),...extra},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 const acquire=async(id='tab-a',publisherSessionId='publisher-a')=>{const r=await request('/api/studio/execution-ownership',{operation:'acquire',ownerInstanceId:id,publisherSessionId});assert.equal(r.status,200,'authenticated browser must obtain an ownership response');return r.body;};
 return {get owner(){return owner;},make,request,acquire,advance:ms=>now+=ms,restart:async()=>{await close();owner=make();await start();},publish:(grant,payload=envelope())=>request('/api/program-output',payload,{'Authorization':'Bearer '+token,...(grant?{'X-Livezone-Execution-Grant':JSON.stringify(grant)}:{})})};
}
test('first browser obtains BROWSER ownership, never server execution',async t=>{const h=await fixture(t),r=await h.acquire();assert.equal(r.state.ownerKind,'BROWSER');assert.ok(r.grant.leaseId);assert.equal(r.state.serverTake,false);});
test('second browser cannot execute',async t=>{const h=await fixture(t);await h.acquire();const r=await h.acquire('tab-b','publisher-b');assert.equal(r.grant,null);assert.equal((await h.publish(null,envelope('publisher-b'))).status,409);});
test('expired browser grant cannot publish',async t=>{const h=await fixture(t),r=await h.acquire();h.advance(1001);assert.equal((await h.publish(r.grant)).status,409);});
test('clean release permits new owner',async t=>{const h=await fixture(t),r=await h.acquire();await h.request('/api/studio/execution-ownership',{operation:'release',grant:r.grant});assert.ok((await h.acquire('tab-b','publisher-b')).grant);});
test('replayed grant rejected after release and reacquisition',async t=>{const h=await fixture(t),r=await h.acquire();await h.request('/api/studio/execution-ownership',{operation:'release',grant:r.grant});await h.acquire();assert.equal((await h.publish(r.grant)).status,409);});
test('server restart invalidates previous grant',async t=>{const h=await fixture(t),r=await h.acquire();await h.restart();assert.equal((await h.publish(r.grant)).status,409);assert.equal((await h.acquire()).grant,null);
 const manual=await h.request('/api/program-output',envelope('manual-reconcile'),{Authorization:'Bearer '+token,'X-Livezone-Program-Manual':'1'});assert.equal(manual.status,202);
 assert.equal((await h.acquire()).grant,null);
 assert.notEqual(h.owner.executionOwnership.snapshot().authorityProcessSession,r.grant.authorityProcessSession);});
test('arbitrary new publisher session cannot bypass grant binding',async t=>{const h=await fixture(t),r=await h.acquire();assert.equal((await h.publish(r.grant,envelope('arbitrary'))).status,409);});
test('stale callback cannot mutate retained Program after owner moves',async t=>{const h=await fixture(t),r=await h.acquire();assert.equal((await h.publish(r.grant)).status,202);const retained=h.owner.store.getCurrent();h.advance(1001);await h.acquire('tab-b','publisher-b');assert.equal((await h.publish(r.grant,envelope('publisher-a',2))).status,409);assert.equal(h.owner.store.getCurrent(),retained);});
test('renew/reconnect and F5 release/reacquire leave retained identity untouched',async t=>{const h=await fixture(t),r=await h.acquire();await h.publish(r.grant);const retained=h.owner.store.getCurrent();const renewed=await h.request('/api/studio/execution-ownership',{operation:'renew',grant:r.grant});assert.equal(renewed.status,200);await h.request('/api/studio/execution-ownership',{operation:'release',grant:renewed.body.grant});await h.acquire('reload','publisher-a');assert.equal(h.owner.store.getCurrent(),retained);});
test('NO_OWNER does not clear retained Program',async t=>{const h=await fixture(t),r=await h.acquire();await h.publish(r.grant);const retained=h.owner.store.getCurrent();h.advance(1001);await h.request('/api/studio/execution-ownership',{operation:'inspect'});assert.equal(h.owner.store.getCurrent(),retained);});
test('duplicate authority fails closed for same persistence scope',async t=>{const h=await fixture(t);await h.acquire();const duplicate=h.make();await duplicate.executionOwnership.ready;assert.equal(duplicate.executionOwnership.snapshot().available,false);await duplicate.executionOwnership.close();await duplicate.autoLive.close();await duplicate.scheduler.close();});
test('legacy publisher token alone cannot publish or acquire ownership',async t=>{const h=await fixture(t);assert.equal((await h.request('/api/program-output',envelope(),{Authorization:'Bearer '+token},false)).status,409);assert.equal((await h.request('/api/studio/execution-ownership',{operation:'acquire',ownerInstanceId:'legacy',publisherSessionId:'legacy'},{Authorization:'Bearer '+token},false)).status,401);});

test('ingress rechecks expiry after asynchronous asset validation waits',async t=>{
 const h=await fixture(t),r=await h.acquire();await h.publish(r.grant);const retained=h.owner.store.getCurrent();
 let unblock,reached;const entered=new Promise(resolve=>reached=resolve);
 const hold=h.owner.assetMutations.run(()=>new Promise(resolve=>unblock=resolve));await new Promise(setImmediate);
 const run=h.owner.assetMutations.run.bind(h.owner.assetMutations);h.owner.assetMutations.run=fn=>{reached();return run(fn);};
 const publication=h.publish(r.grant,envelope('publisher-a',2));await entered;h.advance(1001);unblock();await hold;
 assert.equal((await publication).status,409);assert.equal(h.owner.store.getCurrent(),retained);
});
test('manual authenticated TAKE remains possible and fences the previous browser',async t=>{
 const h=await fixture(t),r=await h.acquire();await h.publish(r.grant);
 const headers={Authorization:'Bearer '+token,'X-Livezone-Program-Manual':'1'};
 assert.equal((await h.request('/api/program-output',envelope('manual'),headers,false)).status,401);
 assert.equal((await h.request('/api/program-output',envelope('manual'),headers)).status,202);
 const retained=h.owner.store.getCurrent();assert.equal((await h.publish(r.grant,envelope('publisher-a',2))).status,409);assert.equal(h.owner.store.getCurrent(),retained);
});
test('private inspection and duplicate instance IDs never disclose the lease secret',async t=>{
 const h=await fixture(t),r=await h.acquire();const inspected=await h.request('/api/studio/execution-ownership',{operation:'inspect'});
 assert.equal(JSON.stringify(inspected.body).includes(r.grant.leaseId),false);assert.equal((await h.acquire()).grant,null);
});
test('separate OS process cannot acquire the same authority lock',async t=>{
 const h=await fixture(t);await h.acquire();
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const moduleUrl=new URL('../server/autolive/BrowserExecutionOwnership.js',import.meta.url).href;
 const code=`import Authority from ${JSON.stringify(moduleUrl)};const a=new Authority({path:${JSON.stringify(h.owner.executionOwnership.path)}});await a.ready;console.log(JSON.stringify(a.snapshot()));await a.close();`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code]);
 assert.equal(JSON.parse(stdout).available,false);assert.equal(h.owner.executionOwnership.snapshot().available,true);
});

test('manual override suppresses automatic claim until explicit consent configuration changes',async t=>{
 const h=await fixture(t),r=await h.acquire();await h.publish(r.grant);
 await h.request('/api/program-output',envelope('operator-take'),{Authorization:'Bearer '+token,'X-Livezone-Program-Manual':'1'});
 assert.equal((await h.acquire('waiting-tab','waiting-publisher')).grant,null);
 const change=await h.request('/api/studio/autolive',{enabled:true},{'If-Match':'"autolive-0"'},true,'PATCH');assert.equal(change.status,200);
 assert.ok((await h.acquire('waiting-tab','waiting-publisher')).grant);
});

test('retired document identity cannot obtain another grant even when no owner remains',async t=>{
 const h=await fixture(t),r=await h.acquire();await h.request('/api/studio/execution-ownership',{operation:'release',grant:r.grant});
 assert.equal((await h.acquire()).grant,null);assert.ok((await h.acquire('fresh-document','fresh-publisher')).grant);
});
