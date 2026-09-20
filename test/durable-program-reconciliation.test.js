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
for(const kind of ['media','audio','image','break','hls',null])test('DP1 HTTP '+(kind||'empty')+' restart/reconcile/F5 preserves durable Program without publication',async t=>{
 const h=await fixture(t,kind),first=await h.acquire('first');assert.equal((await h.publish(first.body.grant)).status,202);
 const before=h.owner.store.getCurrent(),disk=await readFile(h.path+'.program-output.json','utf8');await h.restart();
 assert.deepEqual(h.owner.store.getCurrent(),before);assert.equal(h.owner.durableProgram.status,kind?'PRESENT':'EXPLICIT_EMPTY');
 for(const role of ['public','obs'])assert.deepEqual(await h.retained(role),before);
 assert.equal((await h.acquire('reload')).body.state.reason,'RESTART_RECONCILIATION_REQUIRED');assert.equal((await h.publish(first.body.grant)).status,409);
 const identity={ownerInstanceId:'reload',publisherSessionId:'reload'};
 const prepared=await h.request('/api/studio/execution-ownership',{operation:'prepare-reconciliation',...identity});assert.equal(prepared.status,200);assert.equal(prepared.body.expected.durableGeneration,1);
 const result=await h.request('/api/studio/execution-ownership',{operation:'reconcile',...identity,reconciliationId:prepared.body.reconciliationId,expected:prepared.body.expected});assert.equal(result.status,200);assert.ok(result.body.grant);assert.equal(result.body.durableBinding.generation,1);
 assert.deepEqual(h.owner.store.getCurrent(),before);assert.equal(await readFile(h.path+'.program-output.json','utf8'),disk);
 await h.request('/api/studio/execution-ownership',{operation:'release',grant:result.body.grant});assert.ok((await h.acquire('f5')).body.grant);
 await h.restart();assert.equal((await h.acquire('again')).body.state.reason,'RESTART_RECONCILIATION_REQUIRED');assert.deepEqual(h.owner.store.getCurrent(),before);
});
test('DP1 changed catalog preserves historical record, blocks reconciliation, protects asset inventory completeness',async t=>{
 const h=await fixture(t);const g=await h.acquire('first');await h.publish(g.body.grant);
 h.state.sources[0].url='https://example.test/replacement';await writeFile(h.path,JSON.stringify(h.state));await h.restart();
 assert.equal(h.owner.durableProgram.status,'UNRESOLVED');assert.equal(h.owner.store.getCurrent(),null);assert.ok(h.owner.durableProgram.record);
 assert.equal((await h.request('/api/studio/execution-ownership',{operation:'prepare-reconciliation',ownerInstanceId:'tab',publisherSessionId:'pub'})).status,409);
 const inventories=await h.owner.assetReferences.inventories();assert.equal(inventories.find(x=>x.name==='Durable PROGRAM').complete,false);
});
test('DP1 graceful shutdown drains staged commit before releasing exclusive lock',async t=>{
 const h=await fixture(t),g=await h.acquire('first');let entered,release;const staged=new Promise(r=>entered=r),resume=new Promise(r=>release=r);
 const stage=h.owner.durableProgram.stage.bind(h.owner.durableProgram);h.owner.durableProgram.stage=async record=>{const result=await stage(record);entered();await resume;return result;};
 const publication=h.publish(g.body.grant).catch(()=>null);await staged;
 const restart=h.restart();await new Promise(setImmediate);assert.equal(h.owner.executionOwnership.available,true);release();await publication;await restart;
 assert.equal(h.owner.store.getCurrent().snapshot.playback.initialTime,29);
});

test('DP1 durable path cannot alias another authority state file',()=>{
 const path=join(tmpdir(),'dp1-collision-studio.json');assert.throws(()=>createProgramOutputServer({publisherToken:'dp1-test-publisher-token',studioStatePath:path,autoLivePath:path+'.program-output.json'}),/distinct/);
});
