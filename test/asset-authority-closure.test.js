import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import AssetMutationCoordinator from '../server/media-library/AssetMutationCoordinator.js';
import AssetReferenceInventory from '../server/media-library/AssetReferenceInventory.js';
import MediaAssetRepository from '../server/media-library/MediaAssetRepository.js';
import ReferenceClientRegistry from '../server/media-library/ReferenceClientRegistry.js';
import PreviewOwnership from '../server/media-library/PreviewOwnership.js';
import ChannelLogoAuthority from '../server/media-library/ChannelLogoAuthority.js';
import ChannelLogoReferenceClient from '../public/js/studio/ChannelLogoReferenceClient.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
import {createProgramOutputServer} from '../test-support/ReferenceAuthorityTestServer.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
import StudioGraphicsUI from '../public/js/ui/StudioGraphicsUI.js';

const capabilities=['canonical-catalog','preview-ownership-v2','asset-validation','channel-logo-authority-v1'];
async function fixture(t){
    const root=await mkdtemp(join(tmpdir(),'lz-d3-'));t.after(()=>rm(root,{recursive:true,force:true}));
    const coordinator=new AssetMutationCoordinator(),repo=new MediaAssetRepository({root:join(root,'media')});await repo.initialize();repo.mutationCoordinator=coordinator;
    const options={coordinator,path:join(root,'clients.json'),coverageProven:true,minimumVersion:3,requireEpoch:true};
    const clients=new ReferenceClientRegistry(options);await clients.ready;
    let now=0;const preview=new PreviewOwnership({coordinator,path:join(root,'preview.json'),clock:()=>now,validate:v=>inventory.validate(v)});await preview.ready;
    const inventory=new AssetReferenceInventory({repository:repo,preview,completeness:()=>clients.snapshot(),inventories:()=>[
        {name:'PROGRAM',classification:'RUNTIME',complete:true,data:{source:null,scene:null}},
        {name:'Channel Logo',complete:logos.snapshot().complete,data:logos.snapshot().references},
        {name:'Catalogs',complete:true,data:clients.legacyReferences()}
    ]});
    const logos=new ChannelLogoAuthority({path:join(root,'logos.json'),coordinator,inventory,clients});await logos.ready;
    const upload=async(kind='image')=>{const bytes=kind==='image'?Buffer.from([137,80,78,71,13,10,26,10]):Buffer.from('ID3audio');const path=join(repo.tempRoot,'file');await writeFile(path,bytes);
        return repo.importTempFile({tempPath:path,originalName:kind==='image'?'logo.png':'audio.mp3',mimeType:kind==='image'?'image/png':'audio/mpeg',size:bytes.length});};
    const register=async(role='CONTROL',resume={})=>{
        const identity=await clients.register({role,version:3,capabilities,...resume},'operator');
        await clients.update(identity.clientId,identity.generation,{catalog:'RECONCILED'},'operator');
        const revision=await clients.updateLegacy(identity.clientId,identity.generation,{assets:[],complete:true},'operator');await clients.confirmLegacy(identity.clientId,identity.generation,revision.revision,'operator');
        const client=clients.clients.get(identity.clientId);
        if(role==='CONTROL')for(const consumer of ['preview','program']){const value=await logos.assign(client,consumer,{revision:logos.get(client,consumer).revision,asset:null});await logos.acknowledge(client,consumer,value.revision);}
        return {...identity,record:client};
    };
    const remove=id=>repo.delete(id,{isReferenced:async asset=>{const value=await inventory.inspect(asset);return !value.eligible;}});
    const open=async(c,assets=[])=>{const principal='operator|'+c.clientId;const value=await preview.open(principal);await preview.update(value.sessionId,principal,{sequence:1,assets});return {...value,principal};};
    return {root,coordinator,repo,clients,options,preview,inventory,logos,upload,register,remove,open,setNow:value=>now=value};
}

for(const role of ['CONTROL','SCHEDULER'])test('D3 capable '+role+' completes bounded connected census',async t=>{
    const h=await fixture(t);await h.register(role);assert.equal((await h.inventory.globalCompleteness()).state,'COMPLETE');assert.equal(h.clients.snapshot().clients[0].state,'CURRENT_CAPABLE');
});
test('unknown old Control blocks the census',async t=>{const h=await fixture(t);await h.register();await h.clients.observeObsolete('old');assert.equal(h.clients.snapshot().state,'INCOMPLETE');assert.equal(h.clients.snapshot().clients[1].state,'LEGACY/UNKNOWN');});
test('known old client reload with resume identity reconciles without discarding another client',async t=>{
    const h=await fixture(t),old=await h.clients.register({role:'CONTROL',version:2,capabilities},'operator');
    assert.equal(old.supported,false);await h.register('CONTROL',{resumeId:old.clientId,resumeGeneration:old.generation,resumeToken:old.resumeToken});assert.equal(h.clients.snapshot().state,'COMPLETE');assert.equal(h.clients.clients.size,1);
});
test('restart invalidates previously complete census',async t=>{
    const h=await fixture(t);await h.register();const next=new ReferenceClientRegistry(h.options);await next.ready;assert.equal(next.snapshot().state,'INCOMPLETE');assert.ok(next.snapshot().reasons.includes('CLIENT_CENSUS_RECONNECT_REQUIRED'));
});
test('reconnect rebuilds restarted census with token and newer generation',async t=>{
    const h=await fixture(t),c=await h.register('SCHEDULER'),next=new ReferenceClientRegistry(h.options);await next.ready;
    const resumed=await next.register({role:'SCHEDULER',version:3,capabilities,resumeId:c.clientId,resumeGeneration:c.generation,resumeToken:c.resumeToken},'operator');assert.equal(next.snapshot().state,'INCOMPLETE');
    await next.update(resumed.clientId,resumed.generation,{catalog:'RECONCILED'},'operator');
    const legacy=await next.updateLegacy(resumed.clientId,resumed.generation,{assets:[],complete:true},'operator');await next.confirmLegacy(resumed.clientId,resumed.generation,legacy.revision,'operator');assert.equal(next.snapshot().state,'COMPLETE');
});
test('disconnected legacy client never loses unresolved catalog evidence',async t=>{
    const h=await fixture(t),c=await h.clients.register({role:'CONTROL',version:1},'operator');await h.clients.update(c.clientId,c.generation,{closed:true},'operator');
    assert.equal(h.clients.snapshot().clients[0].state,'DISCONNECTED');assert.equal(h.clients.snapshot().state,'INCOMPLETE');
});
test('anonymous legacy marker cannot be cleared by sibling capable handshake',async t=>{const h=await fixture(t);await h.clients.observeObsolete('operator');await h.register();assert.equal(h.clients.snapshot().state,'INCOMPLETE');});
test('presence socket disconnect is uncertainty rather than absence',async t=>{
    const h=await fixture(t),c=await h.register();await h.clients.presence(c.clientId,c.generation,'operator',false);assert.equal(h.clients.snapshot().clients[0].state,'LEGACY/UNKNOWN');await h.clients.presence(c.clientId,c.generation,'operator',true);assert.equal(h.clients.snapshot().state,'COMPLETE');
});

test('valid Channel Logo is persisted and immediately inventoried before application',async t=>{
    const h=await fixture(t),c=await h.register(),a=await h.upload();const value=await h.logos.assign(c.record,'preview',{revision:1,asset:a.url});
    const audit=await h.inventory.inspect(a);assert.equal(audit.status,'UNKNOWN');assert.ok(audit.references.some(r=>r.assetId===a.id));await assert.rejects(h.remove(a.id));
    await h.logos.acknowledge(c.record,'preview',value.revision);assert.equal((await h.inventory.inspect(a)).status,'USED');
});
test('local logo applies only after successful server persistence and before acknowledgement',async()=>{
    const order=[];const client=new ChannelLogoReferenceClient({request:async(path,options)=>{order.push(options.method);return {ok:true,json:async()=>({ok:true,logo:{revision:2}})};}});client.ready=true;client.revisions.preview=1;
    await client.execute('preview','https://test/logo.png',()=>order.push('apply'));assert.deepEqual(order,['PUT','apply','POST']);
});
test('failed server logo assignment cannot invoke local assignment',async()=>{
    let applied=false;const client=new ChannelLogoReferenceClient({request:async()=>({ok:false,json:async()=>({ok:false,error:{code:'ASSET_UNAVAILABLE'}})})});client.ready=true;client.revisions.preview=1;
    await assert.rejects(client.execute('preview','/missing',()=>{applied=true;}));assert.equal(applied,false);
});
test('clear retains previous logo until local clear acknowledgement',async t=>{
    const h=await fixture(t),c=await h.register(),a=await h.upload();await h.logos.assign(c.record,'preview',{revision:1,asset:a.url});await h.logos.acknowledge(c.record,'preview',2);
    await h.logos.assign(c.record,'preview',{revision:2,asset:null});await assert.rejects(h.remove(a.id));await h.logos.acknowledge(c.record,'preview',3);assert.equal((await h.inventory.inspect(a)).status,'UNUSED');
});
test('change A to B protects both until acknowledgement',async t=>{
    const h=await fixture(t),c=await h.register(),a=await h.upload(),b=await h.upload();await h.logos.assign(c.record,'preview',{revision:1,asset:a.url});await h.logos.acknowledge(c.record,'preview',2);
    await h.logos.assign(c.record,'preview',{revision:2,asset:b.url});await assert.rejects(h.remove(a.id));await assert.rejects(h.remove(b.id));
    await h.logos.acknowledge(c.record,'preview',3);assert.equal((await h.inventory.inspect(a)).status,'UNUSED');assert.equal((await h.inventory.inspect(b)).status,'USED');
});
for(const first of ['assign','delete'])test('logo assignment/delete race: '+first+' wins consistently',async t=>{
    const h=await fixture(t),c=await h.register(),a=await h.upload();const assign=()=>h.logos.assign(c.record,'preview',{revision:1,asset:a.url}),remove=()=>h.remove(a.id);
    let pending;if(first==='assign')pending=[assign(),remove()];else{const deleting=remove();await Promise.resolve();pending=[deleting,assign()];}
    const results=await Promise.allSettled(pending);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
    if(first==='delete')assert.equal(results[1].reason.code,'ASSET_UNAVAILABLE');
});
test('clear/delete race never deletes before local application acknowledgement',async t=>{
    const h=await fixture(t),c=await h.register(),a=await h.upload();await h.logos.assign(c.record,'preview',{revision:1,asset:a.url});await h.logos.acknowledge(c.record,'preview',2);
    const results=await Promise.allSettled([h.logos.assign(c.record,'preview',{revision:2,asset:null}),h.remove(a.id)]);assert.equal(results[1].status,'rejected');await h.logos.acknowledge(c.record,'preview',3);await h.remove(a.id);assert.equal(h.repo.get(a.id),null);
});
test('stale logo revision cannot overwrite assignment',async t=>{const h=await fixture(t),c=await h.register();await assert.rejects(h.logos.assign(c.record,'preview',{revision:0,asset:null}),{code:'REVISION_CONFLICT'});});
test('missing managed logo fails ASSET_UNAVAILABLE',async t=>{const h=await fixture(t),c=await h.register();await assert.rejects(h.logos.assign(c.record,'preview',{revision:1,asset:'/media-library/files/image/missing.png'}),{code:'ASSET_UNAVAILABLE'});});
test('audio cannot be assigned as Channel Logo',async t=>{const h=await fixture(t),c=await h.register(),a=await h.upload('audio');await assert.rejects(h.logos.assign(c.record,'preview',{revision:1,asset:a.url}),{code:'ASSET_TYPE_MISMATCH'});});
test('pending logo survives restart and blocks deletion',async t=>{
    const h=await fixture(t),c=await h.register(),a=await h.upload();await h.logos.assign(c.record,'preview',{revision:1,asset:a.url});
    const next=new ChannelLogoAuthority({path:h.logos.path,coordinator:h.coordinator,inventory:h.inventory,clients:h.clients});await next.ready;assert.equal(next.snapshot().complete,false);assert.equal(next.snapshot().references[0].assetId,a.id);
});

test('active Control retains Preview ownership',async t=>{const h=await fixture(t),c=await h.register(),a=await h.upload();await h.open(c,[a.id]);assert.equal((await h.inventory.inspect(a)).status,'USED');});
test('explicit close safely releases only its Preview ownership',async t=>{const h=await fixture(t),c=await h.register(),a=await h.upload(),s=await h.open(c,[a.id]);await h.preview.close(s.sessionId,s.principal,s.generation);assert.equal((await h.inventory.inspect(a)).status,'UNUSED');});
test('lost close plus expired heartbeat remains UNKNOWN and blocks delete',async t=>{const h=await fixture(t),c=await h.register(),a=await h.upload();await h.open(c,[a.id]);h.setNow(3600000);assert.equal((await h.inventory.inspect(a)).status,'UNKNOWN');await assert.rejects(h.remove(a.id));});
test('network disconnect retains Preview references as uncertain',async t=>{const h=await fixture(t),c=await h.register(),a=await h.upload(),s=await h.open(c,[a.id]);await h.preview.disconnect(s.principal);assert.equal(h.preview.snapshot().complete,false);assert.equal(h.preview.snapshot().references.length,1);});
test('positive authenticated session revocation releases Preview without a close message',async t=>{const h=await fixture(t),c=await h.register(),a=await h.upload();await h.open(c,[a.id]);await h.clients.revokePrincipal('operator');await h.preview.revokePrincipal('operator');assert.equal((await h.inventory.inspect(a)).status,'UNUSED');});
test('restarted Preview is UNKNOWN until resumed report',async t=>{const h=await fixture(t),c=await h.register(),a=await h.upload(),s=await h.open(c,[a.id]);
    const next=new PreviewOwnership({path:h.preview.path,coordinator:h.coordinator,validate:v=>h.inventory.validate(v)});await next.ready;assert.equal(next.snapshot().complete,false);
    const resumed=await next.open(s.principal,{resumeSessionId:s.sessionId,generation:s.generation,resumeToken:s.resumeToken});assert.equal(next.snapshot().references[0].assetId,a.id);
    await next.update(s.sessionId,s.principal,{generation:resumed.generation,sequence:1,assets:[a.id]});assert.equal(next.snapshot().complete,true);
});
test('one Control disconnect or close never clears another Control',async t=>{const h=await fixture(t),a=await h.register(),b=await h.register(),x=await h.upload(),y=await h.upload(),sa=await h.open(a,[x.id]);await h.open(b,[y.id]);await h.preview.revokePrincipal(sa.principal);assert.equal(h.preview.snapshot().references[0].assetId,y.id);});
test('superseded generation cannot close current Preview ownership',async t=>{const h=await fixture(t),c=await h.register(),a=await h.upload(),s=await h.open(c,[a.id]);const next=await h.preview.open(s.principal,{resumeSessionId:s.sessionId,generation:s.generation,resumeToken:s.resumeToken});await h.preview.close(s.sessionId,s.principal,s.generation);assert.equal(h.preview.snapshot().references.length,1);assert.equal(next.generation,s.generation+1);});
test('stale Control generation cannot clear a current logo reference',async t=>{const h=await fixture(t),c=await h.register();await h.register('CONTROL',{resumeId:c.clientId,resumeGeneration:c.generation,resumeToken:c.resumeToken});await assert.rejects(h.logos.assign(c.record,'preview',{revision:2,asset:null}),{code:'CLIENT_CAPABILITY_REQUIRED'});});

test('complete inventory with no references enables guarded deletion',async t=>{const h=await fixture(t);await h.register();const a=await h.upload();assert.equal((await h.inventory.inspect(a)).eligible,true);await h.remove(a.id);assert.equal(h.repo.get(a.id),null);});
test('incomplete census prevents deletion of otherwise unused asset',async t=>{const h=await fixture(t),a=await h.upload();assert.equal((await h.inventory.inspect(a)).status,'UNKNOWN');await assert.rejects(h.remove(a.id));});
test('pending logo makes unrelated unused assets UNKNOWN',async t=>{const h=await fixture(t),c=await h.register(),a=await h.upload();await h.logos.assign(c.record,'preview',{revision:1,asset:null});assert.equal((await h.inventory.inspect(a)).status,'UNKNOWN');});
test('uncertain empty Preview still blocks global completeness',async t=>{const h=await fixture(t),c=await h.register(),s=await h.open(c);await h.preview.disconnect(s.principal);assert.equal((await h.inventory.globalCompleteness()).state,'INCOMPLETE');});
test('final recheck sees reference created after an UNUSED UI audit',async t=>{const h=await fixture(t),c=await h.register(),a=await h.upload();assert.equal((await h.inventory.inspect(a)).status,'UNUSED');await h.logos.assign(c.record,'preview',{revision:1,asset:a.url});await assert.rejects(h.remove(a.id));});

async function http(t){
    const h=await fixture(t),auth=new OperatorAuth({username:'operator',password:'d3-password-test-only',secureCookie:false}),session=auth.authenticate('operator','d3-password-test-only');
    const owner=createProgramOutputServer({publisherToken:'d3-test-publisher',operatorAuth:auth,mediaAssetRepository:h.repo,studioStatePath:join(h.root,'studio.json'),schedulePath:join(h.root,'schedule.json')});
    await new Promise(r=>owner.server.listen(0,'127.0.0.1',r));await owner.scheduler.ready;
    t.after(()=>new Promise(r=>{owner.server.closeAllConnections();owner.server.close(r);}));
    const base='http://127.0.0.1:'+owner.server.address().port;
    const headers={Cookie:auth.createCookie(session).split(';')[0],Origin:base,'Content-Type':'application/json','X-Livezone-Operator-Request':'1','X-Livezone-CSRF':session.csrfToken};
    const request=async(method,path,body,extra={})=>{const response=await fetch(base+path,{method,headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,payload:await response.json()};};
    const c=(await request('POST','/api/media-library/reference-clients',{role:'CONTROL',version:3,capabilities})).payload.client;
    headers['X-Livezone-Reference-Client']=c.clientId;headers['X-Livezone-Reference-Generation']=String(c.generation);
    return {...h,auth,owner,headers,base,request,c};
}
test('Public and OBS requests never register privileged census clients',async t=>{const h=await http(t),count=h.owner.referenceClients.clients.size;for(const path of ['/public/','/obs/']){const response=await fetch(h.base+path);await response.text();}assert.equal(h.owner.referenceClients.clients.size,count);});
test('authenticated logo endpoint commits canonical asset and rejects stale revision',async t=>{const h=await http(t),a=await h.upload();const result=await h.request('PUT','/api/media-library/channel-logo/preview',{revision:0,asset:a.url});assert.equal(result.status,200);assert.equal(result.payload.logo.references[0].assetId,a.id);assert.equal((await h.request('PUT','/api/media-library/channel-logo/preview',{revision:0,asset:null})).status,409);});
test('logout positive revocation releases Preview when close message was lost',async t=>{const h=await http(t),a=await h.upload(),opened=(await h.request('POST','/api/media-library/preview-ownership',{})).payload.ownership;
    await h.request('PUT','/api/media-library/preview-ownership/'+opened.sessionId,{sequence:1,generation:opened.generation,assets:[a.id]});assert.equal(h.owner.previewOwnership.snapshot().references.length,1);
    assert.equal((await h.request('POST','/api/operator/logout',{})).status,200);assert.equal(h.owner.previewOwnership.snapshot().references.length,0);
});
test('old protocol cannot confirm current logo assignment',async t=>{const h=await http(t);const old=(await h.request('POST','/api/media-library/reference-clients',{role:'CONTROL',version:2,capabilities})).payload.client;assert.equal(old.supported,false);assert.equal((await h.request('PUT','/api/media-library/channel-logo/preview',{revision:0,asset:null},{'X-Livezone-Reference-Client':old.clientId,'X-Livezone-Reference-Generation':String(old.generation)})).status,409);});

test('production DELETE route becomes eligible only after every authority predicate resolves',async t=>{
    const h=await http(t),a=await h.upload();
    assert.equal((await h.request('DELETE','/api/media-library/assets/'+a.id)).status,409);
    assert.equal((await h.request('POST','/api/studio/state/catalog/reconcile',{version:1,revision:0,sources:[],scenes:[]})).status,200);
    const path='/api/media-library/reference-clients/'+h.c.clientId;
    const aliases=await h.request('PUT',path+'/legacy-assets',{generation:h.c.generation,assets:[],complete:true});
    await h.request('PUT',path,{generation:h.c.generation,legacyAppliedRevision:aliases.payload.legacy.revision});
    for(const consumer of ['preview','program']){const result=await h.request('PUT','/api/media-library/channel-logo/'+consumer,{revision:0,asset:null});await h.request('POST','/api/media-library/channel-logo/'+consumer,{revision:result.payload.logo.revision});}
    const preview=(await h.request('POST','/api/media-library/preview-ownership',{})).payload.ownership;
    await h.request('PUT','/api/media-library/preview-ownership/'+preview.sessionId,{sequence:1,generation:preview.generation,assets:[]});
    const date='2026-09-14T12:00:00.000Z';
    const envelope=createProgramOutputEnvelope({version:1,revision:1,publisherSessionId:'d3-publisher',publishedAt:date,committedAt:date,scene:null,source:null,
        playback:{initialTime:0,duration:null,playing:false,ended:false,state:'ready',startedAt:date},graphics:{items:[]},transition:{type:'cut',durationMs:0}});
    assert.ok(envelope);assert.equal(h.owner.store.accept(envelope).accepted,true);
    const inventory=(await h.request('GET','/api/media-library/reference-inventory')).payload.inventory;
    assert.deepEqual(inventory,{state:'COMPLETE',reasons:[]});
    assert.equal((await h.request('DELETE','/api/media-library/assets/'+a.id)).status,200);assert.equal(h.repo.get(a.id),null);
});

test('authenticated SSE disconnect retains Preview when close notification is lost',async t=>{
    const h=await http(t),a=await h.upload(),opened=(await h.request('POST','/api/media-library/preview-ownership',{})).payload.ownership;
    await h.request('PUT','/api/media-library/preview-ownership/'+opened.sessionId,{sequence:1,generation:opened.generation,assets:[a.id]});
    const abort=new AbortController();const response=await fetch(h.base+'/api/media-library/reference-presence',{headers:h.headers,signal:abort.signal});
    assert.equal(response.status,200);const reader=response.body.getReader();await reader.read();abort.abort();
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(h.owner.previewOwnership.snapshot().references[0].assetId,a.id);assert.equal(h.owner.previewOwnership.snapshot().complete,false);
    assert.equal((await h.request('DELETE','/api/media-library/assets/'+a.id)).status,409);
});

test('an authenticated session without capable registration keeps census incomplete',async t=>{
    const h=await fixture(t);await h.register('SCHEDULER');h.clients.authenticatedPrincipals=()=>['operator','unregistered-session'];assert.ok(h.clients.snapshot().reasons.includes('AUTHENTICATED_CLIENT_UNCONFIRMED'));
});

test('registered Control without its first Preview report cannot claim authoritative emptiness',async t=>{
    const h=await http(t);assert.equal(h.owner.previewOwnership.snapshot().complete,false);
    const ownership=(await h.request('POST','/api/media-library/preview-ownership',{})).payload.ownership;
    assert.equal(h.owner.previewOwnership.snapshot().complete,false);
    await h.request('PUT','/api/media-library/preview-ownership/'+ownership.sessionId,{sequence:1,generation:ownership.generation,assets:[]});
    assert.equal(h.owner.previewOwnership.snapshot().complete,true);
});

test('accepted Control close releases its Preview even when independent Preview close is lost',async t=>{
    const h=await http(t),a=await h.upload(),ownership=(await h.request('POST','/api/media-library/preview-ownership',{})).payload.ownership;
    await h.request('PUT','/api/media-library/preview-ownership/'+ownership.sessionId,{sequence:1,generation:ownership.generation,assets:[a.id]});
    await h.request('PUT','/api/media-library/reference-clients/'+h.c.clientId,{generation:h.c.generation,closed:true});
    assert.equal(h.owner.previewOwnership.snapshot().references.length,0);assert.equal(h.owner.previewOwnership.snapshot().complete,true);
});

test('positive session revocation resolves request-only unknown marker without erasing a catalog conflict',async t=>{
    const h=await fixture(t);await h.register('SCHEDULER');await h.clients.observeObsolete('old-session');assert.equal(h.clients.snapshot().state,'INCOMPLETE');
    await h.clients.revokePrincipal('old-session');assert.equal(h.clients.snapshot().state,'COMPLETE');
    const old=await h.clients.observeObsolete('conflicting-session');await h.clients.update(old.clientId,old.generation,{catalog:'CONFLICT'},'conflicting-session');
    await h.clients.revokePrincipal('conflicting-session');assert.equal(h.clients.snapshot().state,'INCOMPLETE');
});

test('new Control generation cannot borrow the preceding generation Preview confirmation',async t=>{
    const h=await http(t),own=(await h.request('POST','/api/media-library/preview-ownership',{})).payload.ownership;
    await h.request('PUT','/api/media-library/preview-ownership/'+own.sessionId,{sequence:1,generation:own.generation,assets:[]});assert.equal(h.owner.previewOwnership.snapshot().complete,true);
    await h.request('POST','/api/media-library/reference-clients',{role:'CONTROL',version:3,capabilities,resumeId:h.c.clientId,resumeGeneration:h.c.generation,resumeToken:h.c.resumeToken});
    assert.equal(h.owner.previewOwnership.snapshot().complete,false);
});

test('logo UI applies the confirmed draft even if operator edits the input while awaiting server',async()=>{
    let release,applied;let draft={asset:'https://example.test/A.png',position:'top-left'};
    const gate=new Promise(resolve=>{release=resolve;});
    const ui={logoGraphicId:'channel-logo',getLogoDraftPayload:()=>draft,resolveLogoUrl:value=>value,renderFromState:()=>{},
        graphicsManager:{setGraphicState:(id,state)=>{applied=state.payload;}},
        logoAuthority:{execute:async(consumer,asset,apply)=>{await gate;apply();}},commitLogo:StudioGraphicsUI.prototype.commitLogo};
    const result=StudioGraphicsUI.prototype.handleLogoApplyPreview.call(ui);draft={asset:'https://example.test/B.png',position:'top-right'};
    assert.equal(applied,undefined);release();await result;assert.equal(applied.asset,'https://example.test/A.png');
});

test('restart retires only request-only D2 observations whose authentication was positively revoked',async t=>{
    const h=await fixture(t);await h.clients.observeObsolete('revoked');await h.clients.observeObsolete('still-authenticated');
    const data=JSON.parse(await readFile(h.clients.path,'utf8'));for(const c of data.clients){delete c.version;delete c.observationOnly;}await writeFile(h.clients.path,JSON.stringify(data));
    const next=new ReferenceClientRegistry({...h.options,isSessionRevoked:principal=>principal==='revoked'});await next.ready;
    const values=[...next.clients.values()];assert.equal(values[0].active,false);assert.equal(values[0].catalog,'RECONCILED');assert.equal(values[1].active,true);assert.equal(values[1].catalog,'PENDING');
    assert.equal(next.snapshot().state,'INCOMPLETE');assert.ok(next.snapshot().reasons.includes('CLIENT_CENSUS_RECONNECT_REQUIRED'));
});
