import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readOnlyFilesystemObserver} from '../test-support/ReadOnlyFilesystemObserver.js';
const observer=readOnlyFilesystemObserver();
const {default:Store}=await import('../server/auth/OperatorSessionStore.js');
const {default:Auth}=await import('../server/auth/OperatorAuth.js');
const {default:Guard}=await import('../server/auth/OperatorRequestGuard.js');
test.after(()=>observer.restore());
const source=await readFile(new URL('../server/program-output-server.js',import.meta.url),'utf8');
const handlerSource=source.slice(source.indexOf('function handleOperatorSession('),source.indexOf('async function handleOperatorLogin('));
const handler=new Function('sendJson',handlerSource+'return handleOperatorSession;')((res,status,body)=>{res.status=status;res.body=body;});
function fixture(){
 let now=1000,serial=0,clockCalls=0;
 const store=new Store({ttlSeconds:300,maxSessions:8,clock:()=>{clockCalls++;return now;},random:()=>`fixture-${++serial}`});
 const auth=new Auth({username:'operator',password:'fixture-session-password',secureCookie:false,sessions:store});
 const guard=new Guard({auth});
 const create=()=>auth.authenticate('operator','fixture-session-password');
 const cookie=s=>auth.createCookie(s).split(';')[0];
 const request=s=>({method:'GET',headers:{cookie:s?cookie(s):'',host:'localhost'}});
 const get=s=>{const response={};handler(request(s),response,guard);return response;};
 const observe=async fn=>{
  const before=structuredClone([...store.sessions]);let protocol=0;const originals=[];
  for(const method of ['set','delete','clear']){const original=store.sessions[method];store.sessions[method]=function(...args){protocol++;return original.apply(this,args);};originals.push(()=>store.sessions[method]=original);}
  for(const method of ['create','sweep','delete','clear']){const original=store[method];store[method]=function(...args){protocol++;return original.apply(this,args);};originals.push(()=>store[method]=original);}
  for(const k of Object.keys(observer.counts))observer.counts[k]=0;
  observer.enable();let result;try{result=await fn();}finally{observer.disable();originals.reverse().forEach(restore=>restore());}
  assert.equal(protocol,0);assert.deepEqual([...store.sessions],before);assert.ok(Object.values(observer.counts).every(n=>n===0));return result;
 };
 return {store,auth,guard,create,get,request,observe,setTime:v=>now=v,get clockCalls(){return clockCalls;}};
}
test('exact R11 RED to GREEN: valid session lookup cannot sweep unrelated expired session',async()=>{
 const h=fixture(),expired=h.create();h.setTime(2000);const active=h.create();h.setTime(301000);
 const old=await readFile(new URL('../test-support/fixtures/operator-session-store-r11.txt',import.meta.url),'utf8');
 const Legacy=new Function(old.replace(/^import[^\n]+\n/,'').replace('export default class','class').replace(/export \{ DEFAULT_MAX_SESSIONS \};/,'')+'return OperatorSessionStore;')();
 const legacy=new Legacy({ttlSeconds:300,clock:()=>301000});legacy.sessions=new Map(h.store.sessions);
 assert.equal(legacy.get(active.id),active);assert.equal(legacy.sessions.has(expired.id),false);
 const r=await h.observe(()=>h.get(active));assert.equal(r.body.authenticated,true);assert.equal(h.store.sessions.size,2);assert.equal(h.store.sessions.get(expired.id),expired);
});
test('expired requested session returns authenticated false and remains stored',async()=>{const h=fixture(),s=h.create();h.setTime(301000);await h.observe(()=>{for(let i=0;i<15;i++)assert.equal(h.get(s).body.authenticated,false);});assert.equal(h.store.sessions.get(s.id),s);});
test('missing invalid and malformed session reads never sweep unrelated records',async()=>{const h=fixture();h.create();h.setTime(301000);await h.observe(()=>{for(const id of [undefined,null,'',42,'missing'])assert.equal(h.store.get(id),null);assert.equal(h.get(null).body.authenticated,false);assert.equal(h.auth.sessionFromRequest({headers:{cookie:'livezone-operator-dev=%zz'}}),null);});});
test('multiple expired and active sessions retain identical canonical table under polling',async()=>{const h=fixture(),expired=Array.from({length:4},h.create);h.setTime(2000);const active=Array.from({length:3},h.create);h.setTime(301000);await h.observe(()=>{for(let i=0;i<20;i++){expired.forEach(s=>assert.equal(h.get(s).body.authenticated,false));active.forEach(s=>assert.equal(h.get(s).body.authenticated,true));}});assert.equal(h.store.sessions.size,7);});
test('explicit sweep removes only expired records and retry is idempotent',()=>{const h=fixture(),expired=h.create();h.setTime(2000);const active=h.create();h.setTime(301000);h.store.sweep();assert.deepEqual([...h.store.sessions],[[active.id,active]]);h.store.sweep();assert.equal(h.store.sessions.get(active.id),active);assert.equal(h.store.sessions.has(expired.id),false);});
test('before at and after expiry use effective <= boundary without refresh or deletion',async()=>{const h=fixture(),s=h.create();for(const [now,valid]of [[300999,true],[301000,false],[301001,false]]){h.setTime(now);const calls=h.clockCalls;const r=await h.observe(()=>h.get(s));assert.equal(r.body.authenticated,valid);assert.equal(h.clockCalls,calls+1);assert.equal(s.expiresAt,301000);}});
test('reads do not refresh expiry csrf or identity and no sliding refresh exists',async()=>{const h=fixture(),s=h.create();h.setTime(200000);await h.observe(()=>{for(let i=0;i<30;i++)assert.equal(h.auth.sessionFromRequest(h.request(s)),s);});assert.equal(s.expiresAt,301000);assert.ok(Object.isFrozen(s));assert.equal(typeof h.store.refresh,'undefined');});
test('shared guard session authorize and mutation authorization enforce expiry without cleanup',async()=>{const h=fixture(),s=h.create();h.setTime(301000);await h.observe(()=>{assert.equal(h.guard.session(h.request(s)),null);const response={writeHead(status){this.status=status;},end(){}};assert.equal(h.guard.authorize(h.request(s),response),null);assert.equal(response.status,401);assert.equal(h.guard.authorizeMutation(h.request(s),response),null);assert.equal(response.status,401);});});
test('valid authenticated middleware preserves unrelated expired records',async()=>{const h=fixture();h.create();h.setTime(2000);const s=h.create();h.setTime(301000);await h.observe(()=>{assert.equal(h.guard.authorize(h.request(s),{}),s);});assert.equal(h.store.sessions.size,2);});
test('forty concurrent valid expired and missing GETs have zero protocol effects',async()=>{const h=fixture(),expired=h.create();h.setTime(2000);const active=h.create();h.setTime(301000);await h.observe(()=>Promise.all(Array.from({length:40},(_,i)=>Promise.resolve().then(()=>h.get([active,expired,null][i%3])))));});
test('GET concurrent with sweep attributes cleanup only to explicit owner',async()=>{const h=fixture(),expired=h.create();h.setTime(2000);const active=h.create();h.setTime(301000);await Promise.all([Promise.resolve().then(()=>h.get(active)),Promise.resolve().then(()=>h.store.sweep()),Promise.resolve().then(()=>h.get(expired))]);assert.deepEqual([...h.store.sessions],[[active.id,active]]);});
test('GET concurrent with create revoke and retry preserves lifecycle semantics',async()=>{const h=fixture(),old=h.create();h.setTime(301000);let fresh;await Promise.all([Promise.resolve().then(()=>h.get(old)),Promise.resolve().then(()=>fresh=h.create()),Promise.resolve().then(()=>h.get(null))]);assert.equal(h.store.sessions.size,1);assert.equal(h.store.get(fresh.id),fresh);h.store.delete(fresh.id);assert.equal(h.get(fresh).body.authenticated,false);assert.equal(h.store.delete(fresh.id),false);});
test('creation retains bounded capacity and reclaims expiry without evicting active sessions',()=>{const h=fixture();const all=Array.from({length:8},h.create);assert.equal(h.create(),null);all.forEach(s=>assert.equal(h.store.get(s.id),s));h.setTime(301000);assert.ok(h.create());assert.equal(h.store.sessions.size,1);});
test('restart loses memory sessions; reattached expired evidence still cannot authenticate',async()=>{const h=fixture(),s=h.create();h.setTime(301000);const next=fixture();assert.equal(next.get(s).body.authenticated,false);next.store.sessions=new Map(h.store.sessions);next.setTime(301000);await next.observe(()=>assert.equal(next.get(s).body.authenticated,false));assert.equal(next.store.sessions.size,1);});
test('expired operator session cannot pass transition-related HTTP authorization',async()=>{const h=fixture(),s=h.create();h.setTime(301000);const req=h.request(s);req.method='POST';req.headers.origin='http://localhost';req.headers['x-livezone-operator-request']='1';req.headers['x-livezone-csrf']=s.csrfToken;await h.observe(()=>{const response={writeHead(status){this.status=status;},end(){}};assert.equal(h.guard.authorizeMutation(req,response),null);assert.equal(response.status,401);});const cli=await readFile(new URL('../tools/new-execution-era.mjs',import.meta.url),'utf8');assert.ok(!cli.includes('OperatorSession'));assert.ok(cli.includes('NEW_ERA_EXPLICIT_AUTHORIZATION_REQUIRED'));});
test('complete route registration caller and documentation contract remain separated',async()=>{assert.ok(source.includes('url.pathname === "/api/operator/session" && request.method === "GET"'));const auth=await readFile(new URL('../server/auth/OperatorAuth.js',import.meta.url),'utf8');assert.ok(auth.includes('this.sessions.get('));const doc=await readFile(new URL('../docs/PROGRAM_OUTPUT_NETWORK.md',import.meta.url),'utf8');assert.ok(doc.includes('never by observational access'));});
