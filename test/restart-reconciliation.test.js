import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Authority from '../server/autolive/BrowserExecutionOwnership.js';
import Reconciliation from '../server/autolive/RestartReconciliation.js';
import Store from '../server/program-output/ProgramOutputStore.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
function envelope(kind=null,revision=1){
 const at=new Date(0).toISOString();return createProgramOutputEnvelope({version:1,publisherSessionId:'retained',revision,publishedAt:at,committedAt:at,
  scene:kind?{id:'scene',name:'Program',type:kind==='break'?'SLATE':'MEDIA'}:null,
  source:kind?{id:'source',kind,...(kind==='break'?{title:'Slate',message:'Message',logoUrl:'https://example.test/logo.png'}:
   kind==='audio'?{audioUrl:'https://example.test/audio.mp3'}:{url:'https://example.test/source'})}:null,
  playback:{initialTime:12,duration:null,playing:true,ended:false,state:'playing',startedAt:at},graphics:{items:[]},transition:{type:'cut',durationMs:0}});
}
async function fixture(t,kind=null){
 const dir=await mkdtemp(join(tmpdir(),'lz-reconcile-'));await writeFile(join(dir,'epoch'),'{"epoch":13}');let now=1000;
 const authority=new Authority({path:join(dir,'epoch'),clock:()=>now});await authority.ready;
 t.after(async()=>{await authority.close();await rm(dir,{recursive:true,force:true});});
 const store=new Store();assert.equal(store.accept(envelope(kind)).accepted,true);
 const config={available:true,revision:20,sourceFingerprint:'primecast-v1'};
 const coordinator=new Reconciliation({ownership:authority,store,configuration:()=>config,clock:()=>now});
 const identity={ownerInstanceId:'tab',publisherSessionId:'publisher'};
 const prepare=(ids=identity)=>coordinator.execute({operation:'prepare-reconciliation',...ids},'operator');
 const commit=(p,ids=identity,principal='operator')=>coordinator.execute({operation:'reconcile',...ids,reconciliationId:p.reconciliationId,expected:p.expected},principal);
 return {authority,store,config,coordinator,prepare,commit,advance:ms=>now+=ms};
}
for(const kind of [null,'media','audio','break','hls'])test('reconciliation preserves authoritative '+(kind||'explicit empty')+' Program',async t=>{
 const h=await fixture(t,kind),before=h.store.getCurrent();let publications=0;h.store.subscribe(()=>publications++);
 const p=h.prepare();assert.equal(h.authority.restartBlocked,true);assert.equal(h.authority.grant,null);
 const r=h.commit(p);assert.equal(r.state.state,'BROWSER_OWNER');assert.equal(r.state.serverTake,false);assert.equal(r.state.executionAllowed,false);
 assert.equal(h.store.getCurrent(),before);assert.equal(publications,0);assert.deepEqual(r.retainedProgram,before.snapshot);
 assert.equal(h.authority.restartBlocked,false);
});
test('missing and malformed retained state remain fail closed',async t=>{
 const h=await fixture(t);h.store.current=null;assert.throws(()=>h.prepare(),/RETAINED_PROGRAM_UNAVAILABLE/);
 h.store.current={};assert.throws(()=>h.prepare(),/PROGRAM_IDENTITY_UNRESOLVED/);assert.equal(h.authority.grant,null);assert.equal(h.authority.restartBlocked,true);
});
for(const change of ['program','config','source','manual','epoch','process','conflict'])test(change+' race rejects reconciliation',async t=>{
 const h=await fixture(t),p=h.prepare();
 if(change==='program')h.store.accept(envelope(null,2));
 if(change==='config')h.config.revision++;
 if(change==='source')h.config.sourceFingerprint='changed';
 if(change==='manual')h.coordinator.manualIntent();
 if(change==='epoch')h.authority.authorityEpoch++;
 if(change==='process')h.authority.authorityProcessSession='changed';
 if(change==='conflict')h.authority.grant={ownerInstanceId:'other',expiresAt:999999};
 assert.throws(()=>h.commit(p));assert.equal(h.authority.restartBlocked,true);
});
test('two tabs and idempotent retries never disclose or renew another grant',async t=>{
 const h=await fixture(t),p=h.prepare(),ids={ownerInstanceId:'second',publisherSessionId:'second-publisher'},q=h.prepare(ids);
 const r=h.commit(p);h.advance(1000);const duplicate=h.commit(p);assert.deepEqual(duplicate.grant,r.grant);assert.equal(duplicate.leaseRemainingMs,14000);
 assert.throws(()=>h.commit(q,ids));assert.throws(()=>h.commit(p,ids),/MISMATCH/);assert.throws(()=>h.commit(p,undefined,'other-operator'),/MISMATCH/);
 h.advance(15000);assert.throws(()=>h.commit(p),/GRANT_INACTIVE/);
});
test('expired challenge does not clear restart fence',async t=>{const h=await fixture(t),p=h.prepare();h.advance(60000);assert.throws(()=>h.commit(p),/EXPIRED/);assert.equal(h.authority.restartBlocked,true);});
test('F5 release and fresh document acquisition need no second reconciliation',async t=>{
 const h=await fixture(t),r=h.commit(h.prepare());await h.authority.operate({operation:'release',grant:r.grant},'operator');
 const next=await h.authority.operate({operation:'acquire',ownerInstanceId:'reload',publisherSessionId:'reload-publisher'},'operator');assert.ok(next.grant);
 assert.equal(h.authority.matches(r.grant,'operator'),false);
});
test('new process epoch restores restart fencing',async t=>{
 const h=await fixture(t);h.commit(h.prepare());await h.authority.close();
 const next=new Authority({path:h.authority.path});await next.ready;
 try{assert.equal(next.authorityEpoch,15);assert.equal(next.snapshot().reason,'RESTART_RECONCILIATION_REQUIRED');assert.equal((await next.operate({operation:'acquire',ownerInstanceId:'new',publisherSessionId:'new'},'operator')).grant,null);}finally{await next.close();}
});
test('unavailable authority and unresolved source reject preparation',async t=>{
 const h=await fixture(t);h.config.sourceFingerprint=null;assert.throws(()=>h.prepare(),/SOURCE_UNRESOLVED/);h.authority.available=false;assert.throws(()=>h.prepare(),/AUTHORITY_UNAVAILABLE/);
});

test('pending manual intent blocks new challenges as well as existing confirmations',async t=>{
 const h=await fixture(t),p=h.prepare(),finish=h.coordinator.beginManualIntent();
 assert.throws(()=>h.prepare(),/MANUAL_INTENT_PENDING/);assert.throws(()=>h.commit(p),/MANUAL_INTENT_PENDING/);
 finish();assert.throws(()=>h.commit(p),/MANUAL_INTENT_CHANGED/);assert.ok(h.commit(h.prepare()).grant);
});
