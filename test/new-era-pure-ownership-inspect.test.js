import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {readOnlyFilesystemObserver} from '../test-support/ReadOnlyFilesystemObserver.js';
const observer=readOnlyFilesystemObserver();
const {default:Ownership}=await import('../server/autolive/BrowserExecutionOwnership.js');
const {runtimeStatus}=await import('../server/recovery/RecoveryContract.js');
test.after(()=>observer.restore());
async function fixture(t,{epoch=null}={}){
 const directory=await mkdtemp(join(tmpdir(),'lz-era29-owner-'));
 assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));
 const path=join(directory,'authority.json');if(epoch!==null)await writeFile(path,epoch);
 let now=1000,clockCalls=0;
 const owner=new Ownership({path,leaseMs:1000,clock:()=>{clockCalls++;return now;}});
 await owner.ready;
 t.after(async()=>{observer.disable();await owner.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
 const state=()=>({grant:structuredClone(owner.grant),principal:owner.principal,grantRevision:owner.grantRevision,retired:[...owner.retiredInstances],reason:owner.reason,epoch:owner.authorityEpoch,session:owner.authorityProcessSession,available:owner.available,restartBlocked:owner.restartBlocked});
 const acquire=(id='browser')=>owner.operate({operation:'acquire',ownerInstanceId:id,publisherSessionId:'publisher-'+id},'principal');
 const inspect=()=>owner.operate({operation:'inspect'},'principal');
 const observe=async fn=>{
  const before=state(),bytes=await readFile(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  for(const key of Object.keys(observer.counts))observer.counts[key]=0;
  let mutationCalls=0;const methods=['expire','matches','suppressForScheduled','releaseScheduled','revokeForManual','configurationChanged'],originals=new Map();
  for(const method of methods){const original=owner[method];originals.set(method,original);owner[method]=function(...args){mutationCalls++;return original.apply(this,args);};}
  observer.enable();let result;
  try{result=await fn();}finally{observer.disable();for(const [method,original]of originals)owner[method]=original;}
  assert.deepEqual(state(),before);assert.deepEqual(await readFile(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;}),bytes);
  assert.equal(mutationCalls,0);assert.ok(Object.values(observer.counts).every(n=>n===0),JSON.stringify(observer.counts));return result;
 };
 return {owner,state,acquire,inspect,observe,setTime:value=>now=value,get clockCalls(){return clockCalls;}};
}
test('exact R10 RED to GREEN: expired inspect preserves actual grant and revision',async t=>{
 const h=await fixture(t);await h.acquire();h.setTime(2001);
 const old=await readFile(new URL('../test-support/fixtures/ownership-inspect-r10.txt',import.meta.url),'utf8');
 const legacy=new Function('return new (class {'+old+'})();')();Object.assign(legacy,h.state(),{ready:Promise.resolve(),available:true,clock:()=>2001,retiredInstances:new Set(),grant:structuredClone(h.owner.grant)});
 await legacy.operate({operation:'inspect'},'principal');assert.equal(legacy.grant,null);assert.equal(legacy.grantRevision,2);
 const r=await h.observe(h.inspect);assert.equal(r.state.state,'NO_OWNER');assert.equal(r.state.reason,'LEASE_EXPIRED');assert.equal(r.state.reconciliationRequired,true);assert.equal(r.state.grantRevision,1);assert.ok(h.owner.grant);
});
test('active inspect retains owner and never discloses lease secret',async t=>{const h=await fixture(t);await h.acquire();const r=await h.observe(h.inspect);assert.equal(r.state.ownerKind,'BROWSER');assert.equal(r.state.reconciliationRequired,false);assert.equal(r.grant,null);assert.equal(r.state.grantRevision,1);});
test('expired repeated snapshot and inspect are idempotent',async t=>{const h=await fixture(t);await h.acquire();h.setTime(2001);await h.observe(async()=>{const first=await h.inspect();for(let i=0;i<20;i++){assert.deepEqual(await h.inspect(),first);assert.deepEqual(h.owner.snapshot(),first.state);}});});
test('no grant inspection creates no placeholder and consumes no revision',async t=>{const h=await fixture(t);const r=await h.observe(h.inspect);assert.equal(r.state.state,'NO_OWNER');assert.equal(r.state.grantRevision,0);assert.equal(r.state.reconciliationRequired,false);});
for(const [name,grant]of [['foreign',{authorityEpoch:999}],['stale identity',{authorityProcessSession:'old'}],['invalid revision',{grantRevision:-1}],['corrupt candidate',null]])test(name+' inspect input cannot repair or replace canonical grant',async t=>{const h=await fixture(t);await h.acquire();await h.observe(()=>h.owner.operate({operation:'inspect',grant},'foreign-principal'));});
test('corrupt persisted epoch remains unavailable without repair',async t=>{const h=await fixture(t,{epoch:'{"epoch":-1}'});assert.equal(h.owner.available,false);const r=await h.observe(h.inspect);assert.equal(r.state.available,false);assert.equal(r.state.reason,'AUTHORITY_UNAVAILABLE');});
test('ambiguous duplicate owner inspection cannot break the existing lock',async t=>{const h=await fixture(t);await h.acquire();const duplicate=new Ownership({path:h.owner.path});await duplicate.ready;assert.equal(duplicate.available,false);await h.observe(async()=>{const before=duplicate.grantRevision;const r=await duplicate.operate({operation:'inspect'},'principal');assert.equal(r.state.available,false);assert.equal(duplicate.grantRevision,before);});await duplicate.close();});
test('expiry boundary uses one clock sample and >= without mutating',async t=>{const h=await fixture(t);await h.acquire();for(const [now,expired]of [[1999,false],[2000,true],[2001,true]]){h.setTime(now);const calls=h.clockCalls;const r=await h.observe(h.inspect);assert.equal(h.clockCalls,calls+1);assert.equal(r.state.reconciliationRequired,expired);}});
test('explicit expiry owner revokes once; retry does not consume revision',async t=>{const h=await fixture(t);await h.acquire();h.setTime(2000);await h.observe(h.inspect);h.owner.expire();assert.equal(h.owner.grant,null);assert.equal(h.owner.grantRevision,2);h.owner.expire();assert.equal(h.owner.grantRevision,2);await h.observe(h.inspect);});
test('runtimeStatus polling projects expiry without revoking an owned grant',async t=>{const h=await fixture(t);await h.acquire();h.setTime(2000);await h.observe(async()=>{for(let i=0;i<12;i++){const r=runtimeStatus({executionOwnership:h.owner});assert.equal(r.authority.reconciliationRequired,true);assert.equal(r.authority.grantRevision,1);}});});
test('expired grant cannot publish or renew after a pure observation',async t=>{const h=await fixture(t);const first=await h.acquire();h.setTime(2000);await h.observe(h.inspect);assert.equal(h.owner.matches(first.grant,'principal'),null);assert.equal(h.owner.grantRevision,2);const renewal=await h.owner.operate({operation:'renew',grant:first.grant},'principal');assert.equal(renewal.grant,null);assert.equal(h.owner.grantRevision,2);});
test('authorized acquire reconciles expired lease and grants fresh owner deterministically',async t=>{const h=await fixture(t);await h.acquire();h.setTime(2001);const next=await h.acquire('fresh');assert.ok(next.grant);assert.equal(h.owner.grantRevision,3);assert.ok(h.owner.retiredInstances.has('browser'));assert.equal((await h.acquire('browser')).grant,null);});
test('renew release and stale attempts retain mutation semantics',async t=>{const h=await fixture(t);const first=await h.acquire();h.setTime(1500);const renewed=await h.owner.operate({operation:'renew',grant:first.grant},'principal');assert.equal(renewed.grant.expiresAt,2500);assert.equal(h.owner.grantRevision,1);await h.owner.operate({operation:'release',grant:renewed.grant},'principal');assert.equal(h.owner.grantRevision,2);assert.equal(h.owner.grant,null);await h.owner.operate({operation:'renew',grant:first.grant},'principal');assert.equal(h.owner.grantRevision,2);assert.equal(h.owner.reason,'STALE_GRANT');});
test('forty concurrent expired observations have zero protocol effects',async t=>{const h=await fixture(t);await h.acquire();h.setTime(2001);await h.observe(async()=>{const results=await Promise.all(Array.from({length:40},h.inspect));results.forEach(r=>assert.deepEqual(r,results[0]));});});
test('inspection concurrent with explicit expiry has one material revision',async t=>{const h=await fixture(t);await h.acquire();h.setTime(2001);await Promise.all([h.inspect(),Promise.resolve().then(()=>h.owner.expire()),h.inspect()]);assert.equal(h.owner.grantRevision,2);assert.equal(h.owner.grant,null);});
test('inspection concurrent with acquire renew release adds no revisions',async t=>{const h=await fixture(t);const [first]=await Promise.all([h.acquire(),h.inspect()]);await Promise.all([h.inspect(),h.owner.operate({operation:'renew',grant:first.grant},'principal')]);assert.equal(h.owner.grantRevision,1);await Promise.all([h.inspect(),h.owner.operate({operation:'release',grant:first.grant},'principal')]);assert.equal(h.owner.grantRevision,2);});
test('restart has no persisted grant; new owner remains behind restart fence',async t=>{const h=await fixture(t);await h.acquire();h.setTime(2001);await h.observe(h.inspect);await h.owner.close();const restarted=new Ownership({path:h.owner.path,clock:()=>3000});await restarted.ready;t.after(()=>restarted.close());assert.equal(restarted.grant,null);assert.equal(restarted.restartBlocked,true);assert.equal(restarted.grantRevision,0);const before=await readFile(restarted.path);await restarted.operate({operation:'inspect'},'principal');assert.deepEqual(await readFile(restarted.path),before);assert.equal(restarted.grantRevision,0);await restarted.close();});
test('actual HTTP ownership branch dispatches inspect purely; caller and polling audit',async t=>{
 const h=await fixture(t);await h.acquire();h.setTime(2001);
 const source=await readFile(new URL('../server/program-output-server.js',import.meta.url),'utf8');
 const begin=source.indexOf("            if (url.pathname === '/api/studio/execution-ownership')"),end=source.indexOf('            if (url.pathname === "/api/program-output"',begin);
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const dispatch=new AsyncFunction('request','response','url','operatorGuard','readBody','executionOwnership','programReady','sendJson',source.slice(begin,end));
 await h.observe(async()=>{let response;await dispatch({method:'POST'},{},{pathname:'/api/studio/execution-ownership'},{authorizeMutation:()=>({id:'principal'})},async()=>'{"operation":"inspect"}',h.owner,Promise.resolve(),(_r,status,body)=>{response={status,body};});assert.equal(response.status,200);assert.equal(response.body.state.reconciliationRequired,true);});
 const browser=await readFile(new URL('../public/js/studio/BrowserExecutionOwnershipClient.js',import.meta.url),'utf8');
 assert.ok(!/exchange\(['"]inspect/.test(browser));
});
