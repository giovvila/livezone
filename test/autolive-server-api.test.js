import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProgramOutputServer} from '../server/program-output-server.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
import {createInitializedState} from '../server/studio/AuthoritativeStateContract.js';

const at='2026-09-15T12:00:00.000Z',ROOT='/api/studio/autolive';
const assetId='asset-00000000-0000-4000-8000-000000000001';
async function fixture(t,{corrupt=false}={}){
    const dir=await mkdtemp(join(tmpdir(),'lz-autolive-api-'));
    const state=createInitializedState({sources:[{id:'live-a',name:'LIVE',kind:'hls',enabled:true,url:'https://live.example/index.m3u8'},
        {id:'video-a',name:'Video',kind:'media',assetId}],scenes:[{id:'scene-a',name:'A',type:'MEDIA',renderer:{kind:'source',sourceId:'video-a'}}],
        scheduler:{version:1,timezone:'Europe/Rome',items:[],enabled:false},globalOverlays:{textCrawl:null},dominantLive:{armed:false,authorizedSourceId:null}},
        {stateId:'studio',updatedAt:at});assert.ok(state);await writeFile(join(dir,'studio.json'),JSON.stringify(state));
    if(corrupt)await writeFile(join(dir,'studio.json.autolive.json'),'bad');
    const auth=new OperatorAuth({username:'operator',password:'test-autolive-only-password',secureCookie:false});
    const session=auth.authenticate('operator','test-autolive-only-password'),cookie=auth.createCookie(session).split(';')[0];
    const asset={id:assetId,kind:'video',url:'/media-library/files/video/a.mp4'};
    let probes=0;
    const make=()=>createProgramOutputServer({publisherToken:'separate-publisher-test-token',operatorAuth:auth,
        studioStatePath:join(dir,'studio.json'),schedulePath:join(dir,'schedule.json'),mediaLibraryRoot:join(dir,'media'),
        mediaAssetRepository:{initialize:async()=>{},list:()=>[asset],get:id=>id===assetId?asset:null},
        mediaIngestStatusClient:{getStatus:async()=>{probes++;throw Error('A1 must not probe');}}});
    let owner=make();await owner.autoLive.ready;await new Promise(r=>owner.server.listen(0,'127.0.0.1',r));
    let origin='http://127.0.0.1:'+owner.server.address().port;const readers=[];
    const headers=()=>({Cookie:cookie,Origin:origin,'X-Livezone-Operator-Request':'1','X-Livezone-CSRF':session.csrfToken,'Content-Type':'application/json'});
    const request=async(method='GET',value,revision,suffix='',extra={})=>{
        const response=await fetch(origin+ROOT+suffix,{method,headers:{...headers(),...(revision===undefined?{}:{'If-Match':`"autolive-${revision}"`}),...extra},
            ...(value===undefined?{}:{body:JSON.stringify(value)})});return {status:response.status,body:await response.json(),etag:response.headers.get('etag')};};
    const close=async()=>{for(const reader of readers)await reader.cancel().catch(()=>{});owner.server.closeAllConnections();await new Promise(r=>owner.server.close(r));};
    t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
    async function stream(path){const response=await fetch(origin+path,{headers:headers()});assert.equal(response.status,200);
        const reader=response.body.getReader();readers.push(reader);let buffer='';
        return {reader,async next(type){for(;;){let index;while((index=buffer.indexOf('\n\n'))>=0){const packet=buffer.slice(0,index);buffer=buffer.slice(index+2);
            if(packet.includes('event: '+type+'\n'))return JSON.parse(packet.split('\n').find(l=>l.startsWith('data: ')).slice(6));}
            const result=await reader.read();if(result.done)throw Error('stream ended');buffer+=new TextDecoder().decode(result.value);}}};}
    return {get owner(){return owner;},get origin(){return origin;},get probes(){return probes;},dir,asset,session,cookie,headers,request,stream,
        async restart(){await close();owner=make();await owner.autoLive.ready;await new Promise(r=>owner.server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+owner.server.address().port;}};
}

test('A1 API safe GET, separate consent mutations and source, no Program/health execution',async t=>{
    const h=await fixture(t);const first=await h.request();assert.equal(first.status,200);assert.equal(first.etag,'"autolive-0"');
    assert.equal(first.body.config.enabled,false);assert.equal(first.body.runtime.executionAuthority,'browser-legacy');
    assert.equal((await h.request('PATCH',{enabled:true},0)).body.config.armed,false);
    assert.equal((await h.request('PATCH',{armed:true},1)).body.runtime.phase,'UNCERTAIN');
    const selected=await h.request('PATCH',{sourceId:'live-a'},2);assert.equal(selected.body.config.revision,3);assert.equal(selected.body.runtime.phase,'ARMED');
    assert.equal(h.owner.store.getCurrent(),null);assert.equal(h.owner.scheduler.current().programPlan.execution,'SUSPENDED');assert.equal(h.probes,0);
    assert.equal((await h.request('POST',{},3,'/take')).status,404);
});
for(const [name,extra,status] of [['anonymous',{Cookie:''},401],['bearer alone',{Cookie:'',Authorization:'Bearer separate-publisher-test-token'},401],
    ['bad csrf',{'X-Livezone-CSRF':'bad'},403],['bad origin',{Origin:'https://evil.example'},403],['missing marker',{'X-Livezone-Operator-Request':''},403]])
    test('A1 API security '+name,async t=>{const h=await fixture(t);assert.equal((await h.request('PATCH',{armed:true},0,'',extra)).status,status);assert.equal(h.owner.autoLive.store.getSnapshot().revision,0);});
test('A1 anonymous GET protected and no secret values in state',async t=>{
    const h=await fixture(t);assert.equal((await h.request('GET',undefined,undefined,'',{Cookie:''})).status,401);
    const body=JSON.stringify((await h.request()).body);for(const secret of [h.session.id,h.session.csrfToken,'separate-publisher-test-token','https://live.example'])assert.equal(body.includes(secret),false);
});
test('A1 API revision, source and payload rejection are deterministic',async t=>{
    const h=await fixture(t);assert.equal((await h.request('PATCH',{armed:true})).status,428);
    assert.equal((await h.request('PATCH',{sourceId:'../evil'},0)).status,422);
    assert.equal((await h.request('PATCH',{sourceId:'video-a'},0)).status,422);
    assert.equal((await h.request('PATCH',{sourceId:'missing'},0)).status,422);
    assert.equal((await h.request('PATCH',{url:'https://evil'},0)).status,422);
    assert.equal((await h.request('PATCH',{sourceId:'x'.repeat(9000)},0)).status,413);
    assert.equal((await h.request('PATCH',{enabled:true},0)).status,200);
    assert.equal((await h.request('PATCH',{armed:true},0)).status,412);
});
test('A1 API explicit migration once, restart persistence and fresh inert runtime',async t=>{
    const h=await fixture(t),legacy={version:1,enabled:false,armed:true,sourceId:'live-a'};
    assert.equal((await h.request('POST',legacy,0,'/migrate')).status,200);
    assert.equal((await h.request('POST',legacy,1,'/migrate')).status,409);
    const before=(await h.request()).body;await h.restart();const after=(await h.request()).body;
    assert.deepEqual(after.config,before.config);assert.notEqual(after.runtime.sessionId,before.runtime.sessionId);
    assert.equal(after.runtime.entryHealthyMs,0);assert.equal(after.runtime.deadline,null);assert.equal(h.probes,0);assert.equal(h.owner.store.getCurrent(),null);
});
test('A1 API corrupted store remains unavailable and unchanged',async t=>{
    const h=await fixture(t,{corrupt:true});assert.equal((await h.request()).status,503);
    assert.equal((await h.request('PATCH',{armed:true},0)).status,503);
    assert.equal(await readFile(join(h.dir,'studio.json.autolive.json'),'utf8'),'bad');
});
test('A1 private shared SSE retained state, mutation and reconnect never publish AutoLive publicly', {timeout:10000},async t=>{
    const h=await fixture(t);
    const registration=await fetch(h.origin+'/api/media-library/reference-clients',{method:'POST',headers:h.headers(),body:JSON.stringify({role:'CONTROL',version:3,
        capabilities:['canonical-catalog','preview-ownership-v2','asset-validation','channel-logo-authority-v1']})});
    assert.equal(registration.status,201);const {client}=await registration.json();
    const path='/api/media-library/reference-presence?controlEvents=1&referenceClient='+client.clientId+'&referenceGeneration='+client.generation;
    const feed=await h.stream(path);const initial=await feed.next('autolive-state');assert.equal(initial.config.revision,0);
    const pub=await h.stream('/api/program-output/events');let publicText='';const read=pub.reader.read().then(r=>{publicText+=new TextDecoder().decode(r.value);});await read;
    await h.request('PATCH',{enabled:true},0);assert.equal((await feed.next('autolive-state')).config.revision,1);
    const next=await h.stream(path);assert.equal((await next.next('autolive-state')).config.revision,1);
    assert.equal(h.owner.autoLive.store.getSnapshot().revision,1);assert.equal(h.owner.store.getCurrent(),null);assert.equal(h.probes,0);
    assert.doesNotMatch(publicText,/autolive-state|browser-legacy/);
    // Assert the actual public transport has received no write on the mutation.
    let writes=0;for(const res of h.owner.clients){const write=res.write.bind(res);res.write=(...args)=>{writes++;return write(...args);};}
    await h.request('PATCH',{armed:true},1);assert.equal(writes,0);
});
test('A1 recovery requires canonical assets and projects held references until clear',async t=>{
    const h=await fixture(t);const record={version:1,sessionId:'session',stage:'CAPTURED',capturedActivation:{publisherSessionId:'pub',committedAt:at,sceneId:'scene-a',sourceId:'video-a'},
        programRevision:1,sceneId:'scene-a',sourceId:'video-a',sourceKind:'media',sourceVersion:'catalog-1',cueAtInterruption:20,playbackState:'paused',
        assets:[],createdAt:at,updatedAt:at,expectedCurrentActivation:null,actionKey:'action'};
    await assert.rejects(h.owner.autoLive.recovery.save(record,0),{code:'RECOVERY_ASSETS_REQUIRED'});
    await h.owner.autoLive.recovery.save({...record,assets:[{assetId,kind:'video'}]},0);
    const refs=h.owner.assetReferences.extract(h.owner.autoLive.references());assert.ok(refs.references.some(r=>r.assetId===assetId));
    await h.owner.autoLive.recovery.clear(1,'action');assert.equal(h.owner.autoLive.references().length,0);
});

for(const header of ['autolive-0','"autolive--1"','"autolive-9007199254740992"','*'])test('review API malformed revision '+header,async t=>{
    const h=await fixture(t);const result=await h.request('PATCH',{armed:true},undefined,'',{'If-Match':header});assert.equal(result.status,428);assert.equal(h.owner.autoLive.store.getSnapshot().revision,0);
});
test('review API lost migration response and concurrent offers preserve single commit',async t=>{
    const h=await fixture(t),value={version:1,enabled:true,armed:false,sourceId:'live-a'};
    const offers=await Promise.all([h.request('POST',value,0,'/migrate'),h.request('POST',{...value,armed:true},0,'/migrate')]);
    assert.deepEqual(offers.map(r=>r.status).sort(),[200,412]);assert.equal((await h.request('POST',value,0,'/migrate')).status,412);
    assert.equal((await h.request('POST',value,1,'/migrate')).status,409);assert.equal((await h.request()).body.config.revision,1);
});
