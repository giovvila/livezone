import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProgramOutputServer} from '../server/program-output-server.js';
import {createInitializedState} from '../server/studio/AuthoritativeStateContract.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
async function fixture(t,kind='media'){
 const dir=await mkdtemp(join(tmpdir(),'lz-dp1-http-')),path=join(dir,'studio.json');
 const live={id:'primecast',name:'primecast',kind:'hls',enabled:true,url:'https://example.test/live.m3u8'};
 const source=kind==='hls'?live:kind&&kind!=='break'?{id:'source',name:'Program',kind,...(kind==='audio'?{audioUrl:'https://example.test/a.mp3',stillUrl:'https://example.test/a.png'}:{url:'https://example.test/media'})}:null;
 const scene={id:'scene',name:'Program',type:kind==='break'?'SLATE':kind==='hls'?'LIVE':'MEDIA',renderer:kind==='break'?{kind:'slate',title:'Slate',message:'Message',logo:'https://example.test/logo.png'}:{kind:'source',sourceId:source?.id||live.id}};
 const state=createInitializedState({sources:source&&source!==live?[source,live]:[live],scenes:kind?[scene]:[],scheduler:{version:1,timezone:'Europe/Rome',items:[],enabled:false},globalOverlays:{textCrawl:null},dominantLive:{armed:true,authorizedSourceId:live.id}},{stateId:'dp1',updatedAt:new Date().toISOString()});assert.ok(state);
 await writeFile(path,JSON.stringify(state));await writeFile(path+'.autolive.json',JSON.stringify({version:1,revision:1,enabled:true,armed:true,sourceId:live.id,updatedAt:new Date().toISOString(),migration:null}));
 const auth=new OperatorAuth({username:'operator',password:'dp1-test-password',secureCookie:false}),session=auth.authenticate('operator','dp1-test-password');
 const make=()=>createProgramOutputServer({publisherToken:'dp1-test-publisher-token',operatorAuth:auth,studioStatePath:path,schedulePath:join(dir,'schedule.json'),mediaLibraryRoot:join(dir,'media')});
 let owner=make();const start=async()=>{await owner.programReady;await new Promise(r=>owner.server.listen(0,'127.0.0.1',r));};await start();
 const close=async()=>{owner.server.closeAllConnections();await new Promise(r=>owner.server.close(r));};
 t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 const request=async(route,body,headers={})=>{const origin='http://127.0.0.1:'+owner.server.address().port;const response=await fetch(origin+route,{method:'POST',headers:{Cookie:auth.createCookie(session).split(';')[0],Origin:origin,'X-Livezone-Operator-Request':'1','X-Livezone-CSRF':session.csrfToken,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 const acquire=async(id)=>request('/api/studio/execution-ownership',{operation:'acquire',ownerInstanceId:id,publisherSessionId:id});
 const at=new Date().toISOString(),snapshot={version:1,publisherSessionId:'first',revision:1,publishedAt:at,committedAt:at,scene:kind?{id:scene.id,name:scene.name,type:scene.type}:null,
  source:kind==='break'?{id:scene.id,kind,title:'Slate',message:'Message',logoUrl:scene.renderer.logo}:source?{id:source.id,kind,...(kind==='audio'?{audioUrl:source.audioUrl,stillUrl:source.stillUrl}:{url:source.url})}:null,
  playback:{initialTime:29,duration:120,playing:true,ended:false,state:'playing',startedAt:at},graphics:{items:[]},transition:{type:'cut',durationMs:0}};
 const envelope={protocolVersion:1,publisherSessionId:'first',revision:1,publishedAt:at,snapshot};
 return {dir,path,state:structuredClone(state),envelope,request,acquire,
  retained:async role=>{const abort=new AbortController();const response=await fetch('http://127.0.0.1:'+owner.server.address().port+'/api/program-output/events?role='+role,{signal:abort.signal});const reader=response.body.getReader();let text='';try{while(!text.includes('data: ')){const chunk=await reader.read();if(chunk.done)throw Error('No retained SSE');text+=new TextDecoder().decode(chunk.value);}return JSON.parse(text.split('data: ')[1].split('\n')[0]);}finally{abort.abort();}},get owner(){return owner;},restart:async()=>{await close();owner=make();await start();},publish:grant=>request('/api/program-output',envelope,{Authorization:'Bearer dp1-test-publisher-token','X-Livezone-Execution-Grant':JSON.stringify(grant)})};
}

// Diagnostic-only production HTTP/client regression; no live authority state.
import BrowserClient from '../public/js/studio/BrowserExecutionOwnershipClient.js';
import Reconciliation from '../server/autolive/RestartReconciliation.js';
import {expectedPlaybackTime} from '../public/js/program-output/ProgramOutputContract.js';

test('DP1 playing durable Program: real-clock prepare/confirm through browser client',async t=>{
 const h=await fixture(t),first=await h.acquire('first');assert.equal((await h.publish(first.body.grant)).status,202);await h.restart();
 const base=structuredClone(h.owner.store.getCurrent()),disk=await readFile(h.path+'.program-output.json','utf8');
 const execute=Reconciliation.prototype.execute;let diagnostic;
 Reconciliation.prototype.execute=function(value,principal){
  if(value.operation==='reconcile'){
   const record=this.records.get(value.reconciliationId),current=this.current();
   diagnostic={reconciliationId:value.reconciliationId,expiresAt:record?.expiresAt,now:Date.now(),restorationStatus:h.owner.durableProgram.status,
    retainedPublisherSessionId:this.store.getCurrent().publisherSessionId,retainedRevision:this.store.getCurrent().revision,
    ownerInstanceId:value.ownerInstanceId,publisherSessionId:value.publisherSessionId,
    fields:Object.fromEntries(Object.keys(current).map(k=>[k,{prepared:record.expected[k],current:current[k],result:record.expected[k]===current[k]?'MATCH':'MISMATCH'}]))};
  }
  return execute.call(this,value,principal);
 };
 t.after(()=>{Reconciliation.prototype.execute=execute;});
 let serial=0;const http=[];
 const client=new BrowserClient({uuid:()=> 'diagnostic-'+(++serial),setTimer:()=>0,clearTimer:()=>{},request:async(route,options)=>{
  const value=JSON.parse(options.body),result=await h.request(route,value);http.push({operation:value.operation,status:result.status,error:result.body.error??null});
  return {ok:result.status===200,status:result.status,json:async()=>result.body};
 }});t.after(()=>client.close());
 await client.start();assert.equal(client.state.reason,'RESTART_RECONCILIATION_REQUIRED');
 const prepared=await client.reconcileRequest('prepare-reconciliation');assert.ok(prepared.reconciliationId);
 const cueBefore=expectedPlaybackTime(base.snapshot,Date.now());await new Promise(r=>setTimeout(r,3500));
 // A denied acquisition while fenced must not mutate CAS revisions either.
 assert.equal((await h.acquire('other-waiting-tab')).body.grant,null);
 const cueAfter=expectedPlaybackTime(base.snapshot,Date.now());assert.ok(cueAfter-cueBefore>=3);
 const confirmed=await client.reconcileRequest('reconcile',prepared);
 t.diagnostic(JSON.stringify({http,cueBefore,cueAfter,...diagnostic}));
 assert.equal(confirmed.error,undefined);assert.ok(confirmed.grant);assert.ok(client.valid());
 assert.deepEqual(h.owner.store.getCurrent(),base);assert.equal(await readFile(h.path+'.program-output.json','utf8'),disk);
});

for(const change of ['program','config','source','manual','ownership'])test('DP1 genuine '+change+' mutation rejects a prepared challenge',async t=>{
 const h=await fixture(t),first=await h.acquire('first');await h.publish(first.body.grant);await h.restart();
 const execute=Reconciliation.prototype.execute;let coordinator;
 Reconciliation.prototype.execute=function(...args){coordinator=this;return execute.apply(this,args);};
 t.after(()=>{Reconciliation.prototype.execute=execute;});
 const identity={ownerInstanceId:'confirm-tab',publisherSessionId:'confirm-publisher'};
 const prepared=await h.request('/api/studio/execution-ownership',{operation:'prepare-reconciliation',...identity});assert.equal(prepared.status,200);
 if(change==='program'){
  // Isolate accepted-envelope CAS from the additional manual-intent fence.
  const next=structuredClone(h.owner.store.getCurrent());next.revision++;next.snapshot.revision++;
  assert.equal((await h.owner.assetMutations.run(()=>h.owner.programCommits.accept(next,{check:()=>true}))).accepted,true);
 }
 if(change==='config')await h.owner.autoLive.store.patch({armed:false},1);
 if(change==='source')await h.owner.autoLive.store.patch({sourceId:null},1);
 if(change==='manual')coordinator.manualIntent();
 if(change==='ownership')h.owner.executionOwnership.revokeForManual('different-publisher');
 const before=structuredClone(h.owner.store.getCurrent());
 const result=await h.request('/api/studio/execution-ownership',{operation:'reconcile',...identity,reconciliationId:prepared.body.reconciliationId,expected:prepared.body.expected});
 const expectedError={program:'PROGRAM_CHANGED',config:'RECONCILIATION_STALE',source:'SOURCE_UNRESOLVED',manual:'MANUAL_INTENT_CHANGED',ownership:'RECONCILIATION_STALE'}[change];
 assert.equal(result.status,409);assert.equal(result.body.error,expectedError);assert.equal(h.owner.executionOwnership.grant,null);
 assert.deepEqual(h.owner.store.getCurrent(),before);
 t.diagnostic(JSON.stringify({change,status:result.status,error:result.body.error,fields:Object.fromEntries(Object.entries(result.body.current??{}).map(([k,v])=>[k,{prepared:prepared.body.expected[k],current:v,result:prepared.body.expected[k]===v?'MATCH':'MISMATCH'}]))}));
});
