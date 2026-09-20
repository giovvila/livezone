import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {evaluateWindowsAuthorityCensus} from '../server/autolive/WindowsAuthorityProcessProof.js';
import Authority from '../server/autolive/BrowserExecutionOwnership.js';
import {acquireMaintenanceGate} from '../server/autolive/AuthorityMaintenanceGate.js';
import {reconcileAuthorityLock} from '../server/autolive/ReconcileAuthorityLock.js';
import {installGracefulShutdown} from '../server/GracefulShutdown.js';
import {createProgramOutputServer} from '../server/program-output-server.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';

async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'lz-owner-lifecycle-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,path:join(dir,'state.execution')};}
const absent=async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],nodes:[]});
const reserve=async()=>async()=>{};
async function abandoned(t){const h=await fixture(t),first=new Authority({path:h.path});await first.ready;
 const grant=(await first.operate({operation:'acquire',ownerInstanceId:'old-tab',publisherSessionId:'old-publisher'},'operator')).grant;
 const owner={pid:999999,authorityProcessSession:first.authorityProcessSession};await first.close();
 await writeFile(h.path+'.lock',JSON.stringify(owner));
 return {...h,grant,options:{path:h.path,expectedEpoch:1,expectedPid:owner.pid,expectedSession:owner.authorityProcessSession,
  proveOffline:absent,reserve,isAlive:()=>false}};
}

for(const signal of ['SIGINT','SIGTERM','SIGBREAK'])test(signal+' graceful CLI lifecycle drains authority and preserves restart epoch',async t=>{
 const h=await fixture(t),create=()=>createProgramOutputServer({publisherToken:'shutdown-test-token',operatorAuth:new OperatorAuth({disabled:true}),
  studioStatePath:join(h.dir,'studio.json'),schedulePath:join(h.dir,'schedule.json'),mediaLibraryRoot:join(h.dir,'media')});
 const owner=create();await owner.executionOwnership.ready;await new Promise(r=>owner.server.listen(0,'127.0.0.1',r));
 const signals=new EventEmitter(),exits=[];const lifecycle=installGracefulShutdown(owner,{signals,exit:code=>exits.push(code)});
 signals.emit(signal);await lifecycle.shutdown();assert.deepEqual(exits,[0]);
 await assert.rejects(access(owner.executionOwnership.path+'.lock'),{code:'ENOENT'});
 assert.equal(JSON.parse(await readFile(owner.executionOwnership.path,'utf8')).epoch,1);
 assert.equal(signals.listenerCount(signal),0);
 const next=new Authority({path:owner.executionOwnership.path});await next.ready;
 try{assert.equal(next.authorityEpoch,2);assert.equal(next.reason,'RESTART_RECONCILIATION_REQUIRED');}finally{await next.close();}
});

test('controlled reconciliation archives abandoned lock, preserves epoch and fences old grant',async t=>{
 const h=await abandoned(t),before=await readFile(h.path,'utf8');const result=await reconcileAuthorityLock(h.options);
 assert.equal(await readFile(h.path,'utf8'),before);assert.equal(JSON.parse(await readFile(result.audit+'.completed','utf8')).state,'COMPLETED');
 assert.equal(JSON.parse(await readFile(result.archive,'utf8')).pid,999999);
 const next=new Authority({path:h.path});await next.ready;
 try{assert.equal(next.authorityEpoch,2);assert.equal(Boolean(next.matches(h.grant,'operator')),false);
  next.revokeForManual('manual');next.configurationChanged();
  assert.ok((await next.operate({operation:'acquire',ownerInstanceId:'fresh',publisherSessionId:'fresh'},'operator')).grant);
  assert.equal(Boolean(next.matches(h.grant,'operator')),false);
 }finally{await next.close();}
});
test('live authority lock cannot be reconciled even with supplied offline proof',async t=>{
 const h=await fixture(t),live=new Authority({path:h.path});await live.ready;
 try{await assert.rejects(reconcileAuthorityLock({path:h.path,expectedEpoch:1,expectedPid:process.pid,expectedSession:live.authorityProcessSession,
  proveOffline:absent,reserve}),/still alive/);assert.equal(live.available,true);assert.ok(await readFile(h.path+'.lock'));}finally{await live.close();}
});
for(const reason of ['service running','service not disabled','unknown process census'])test('reconciliation refuses '+reason,async t=>{
 const h=await abandoned(t),before=await readFile(h.path+'.lock','utf8');
 await assert.rejects(reconcileAuthorityLock({...h.options,proveOffline:async()=>({absent:false,reason})}),/RECONCILIATION_REFUSED/);
 assert.equal(await readFile(h.path+'.lock','utf8'),before);assert.equal(JSON.parse(await readFile(h.path,'utf8')).epoch,1);
});
test('reconciliation refuses occupied HTTP port and changed reviewed identity',async t=>{
 const h=await abandoned(t);
 await assert.rejects(reconcileAuthorityLock({...h.options,reserve:async()=>{throw Error('EADDRINUSE');}}),/EADDRINUSE/);
 await assert.rejects(reconcileAuthorityLock({...h.options,expectedEpoch:0}),/identity\/epoch mismatch/);
 assert.ok(await readFile(h.path+'.lock'));
});
test('maintenance gate prevents concurrent authority initialization without altering lock or epoch',async t=>{
 const h=await abandoned(t),release=await acquireMaintenanceGate(h.path),other=new Authority({path:h.path});await other.ready;
 try{assert.equal(other.available,false);assert.equal(other.authorityEpoch,0);assert.equal(JSON.parse(await readFile(h.path,'utf8')).epoch,1);}
 finally{await other.close();await release();}
});

test('reviewed reconciliation permits an unrelated Codex worker while preserving epoch bytes',async t=>{
 const h=await abandoned(t),before=await readFile(h.path,'utf8');
 const proof=()=>evaluateWindowsAuthorityCensus({services:[{State:'Stopped',StartMode:'Disabled'}],nodes:[{
  ProcessId:700,Name:'node.exe',ExecutablePath:'C:\\Users\\u\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\v\\bin\\node.exe',
  CommandLine:'C:\\Users\\u\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\v\\bin\\node.exe --experimental-vm-modules C:\\Users\\u\\AppData\\Local\\Temp\\worker\\kernel.js --working-dir C:\\Projects\\livezone-broadcast-engine-x'
 }]});
 const hash=value=>createHash('sha256').update(value).digest('hex');
 const result=await reconcileAuthorityLock({...h.options,proveOffline:async()=>proof(),expectedEpochHash:hash(before),expectedLockHash:hash(await readFile(h.path+'.lock','utf8'))});
 assert.equal(await readFile(h.path,'utf8'),before);assert.ok(await readFile(result.archive));
});
test('real occupied listening port refuses reconciliation without touching lock',async t=>{
 const h=await abandoned(t),listener=createServer();await new Promise(r=>listener.listen(0,'0.0.0.0',r));
 try{await assert.rejects(reconcileAuthorityLock({...h.options,port:listener.address().port,reserve:undefined}),{code:'EADDRINUSE'});
  assert.ok(await readFile(h.path+'.lock'));}finally{await new Promise(r=>listener.close(r));}
});
for(const field of ['expectedEpochHash','expectedLockHash'])test('reviewed '+field+' mismatch refuses unchanged identity',async t=>{
 const h=await abandoned(t),before=await readFile(h.path+'.lock','utf8');
 await assert.rejects(reconcileAuthorityLock({...h.options,[field]:'0'.repeat(64)}),/file hash mismatch/);
 assert.equal(await readFile(h.path+'.lock','utf8'),before);
});
test('reviewed PID becoming alive refuses independently of unrelated process classification',async t=>{
 const h=await abandoned(t);await assert.rejects(reconcileAuthorityLock({...h.options,isAlive:()=>true}),/still alive/);
 assert.ok(await readFile(h.path+'.lock'));
});
