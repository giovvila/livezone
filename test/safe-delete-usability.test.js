import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import OperatorAuth from '../server/auth/OperatorAuth.js';
import MediaAssetRepository from '../server/media-library/MediaAssetRepository.js';
import MediaReferenceAudit from '../server/media-library/MediaReferenceAudit.js';
import ReferenceClientRegistry from '../server/media-library/ReferenceClientRegistry.js';
import {createProgramOutputServer} from '../test-support/ReferenceAuthorityTestServer.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';

const capabilities=['canonical-catalog','preview-ownership-v2','asset-validation','channel-logo-authority-v1'];
async function fixture(t){
    const root=await mkdtemp(join(tmpdir(),'lz-delete-usability-'));
    const repo=new MediaAssetRepository({root:join(root,'media')});await repo.initialize();
    const auth=new OperatorAuth({username:'operator',password:'fixture-password',secureCookie:false});
    const owner=createProgramOutputServer({operatorAuth:auth,publisherToken:'fixture-publisher',mediaAssetRepository:repo,studioStatePath:join(root,'studio.json'),schedulePath:join(root,'schedule.json')});
    await new Promise(r=>owner.server.listen(0,'127.0.0.1',r));await owner.scheduler.ready;
    t.after(async()=>{owner.server.closeAllConnections();await new Promise(r=>owner.server.close(r));await rm(root,{recursive:true,force:true});});
    const base='http://127.0.0.1:'+owner.server.address().port;await fetch(base+'/readyz');
    const date='2026-09-14T10:00:00.000Z';
    owner.store.accept(createProgramOutputEnvelope({version:1,revision:1,publisherSessionId:'fixture',publishedAt:date,committedAt:date,scene:null,source:null,playback:{initialTime:0,duration:null,playing:false,ended:false,state:'ready',startedAt:date},graphics:{items:[]},transition:{type:'cut',durationMs:0}}));
    const temp=join(repo.tempRoot,'fixture');await writeFile(temp,Buffer.from([137,80,78,71,13,10,26,10]));
    const asset=await repo.importTempFile({tempPath:temp,originalName:'unused.png',mimeType:'image/png',size:8});
    const request=async(c,path,method='GET',body)=>{
        const headers={'Content-Type':'application/json',Origin:base};
        if(c){headers.Cookie=auth.createCookie(c.session).split(';')[0];headers['x-livezone-csrf']=c.session.csrfToken;headers['x-livezone-operator-request']='1';if(c.identity){headers['X-Livezone-Reference-Client']=c.identity.clientId;headers['X-Livezone-Reference-Generation']=String(c.identity.generation);}}
        const r=await fetch(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};
    };
    const client=async(role='SCHEDULER',version=3)=>{
        const session=auth.authenticate('operator','fixture-password'),c={session,principal:createHash('sha256').update(session.id).digest('hex')};
        const r=await request(c,'/api/media-library/reference-clients','POST',{role,version,capabilities});assert.equal(r.status,201);c.identity=r.body.client;return c;
    };
    const complete=async c=>{
        const path='/api/media-library/reference-clients/'+c.identity.clientId;
        const legacy=await request(c,path+'/legacy-assets','PUT',{generation:c.identity.generation,assets:[],complete:true});assert.equal(legacy.status,200);
        assert.equal((await request(c,path,'PUT',{generation:c.identity.generation,legacyAppliedRevision:legacy.body.legacy.revision})).status,200);
        const state=await request(c,'/api/studio/state');
        assert.equal((await request(c,'/api/studio/state/catalog/reconcile','POST',{version:1,revision:state.body.state.revision,sources:[],scenes:[]})).status,200);
        if(roleOf(c)==='CONTROL'){
            for(const consumer of ['preview','program']){const p='/api/media-library/channel-logo/'+consumer;assert.equal((await request(c,p,'PUT',{revision:0,asset:null})).status,200);assert.equal((await request(c,p,'POST',{revision:1})).status,200);}
            const p=await request(c,'/api/media-library/preview-ownership','POST',{});c.preview=p.body.ownership;
            assert.equal((await request(c,'/api/media-library/preview-ownership/'+c.preview.sessionId,'PUT',{sequence:1,assets:[],complete:true})).status,200);
        }
    };
    const roleOf=c=>owner.referenceClients.clients.get(c.identity.clientId).role;
    const control=await client('CONTROL');await complete(control);const scheduler=await client();await complete(scheduler);
    const audit=()=>request(scheduler,'/api/media-library/assets/'+asset.id+'/references');
    const remove=()=>request(scheduler,'/api/media-library/assets/'+asset.id,'DELETE');
    return {owner,repo,auth,asset,client,complete,request,control,scheduler,audit,remove};
}

test('current Control and Scheduler plus revoked historical v3 allow real fixture HTTP DELETE',async t=>{
    const h=await fixture(t),old=await h.client();h.auth.sessions.delete(old.session.id);
    const blockedWrite=await h.request(old,'/api/studio/state/catalog','PUT',{revision:1,sources:[],scenes:[]});assert.equal(blockedWrite.status,401);
    const census=h.owner.referenceClients.snapshot();assert.equal(census.state,'COMPLETE');assert.equal(census.clients.at(-1).state,'HISTORICAL / NON-AUTHORITATIVE');
    const audit=await h.audit();assert.equal(audit.body.audit.status,'UNUSED');assert.equal((await h.remove()).status,200);assert.equal(h.repo.get(h.asset.id),null);
});
test('valid but disconnected pending current client still vetoes',async t=>{const h=await fixture(t),old=await h.client();await h.owner.referenceClients.presence(old.identity.clientId,1,old.principal,false);assert.equal((await h.remove()).status,409);assert.equal(h.owner.referenceClients.isHistoricalNonwriter(h.owner.referenceClients.clients.get(old.identity.clientId)),false);});
test('active legacy implementation with local writes remains UNKNOWN and blocks DELETE',async t=>{const h=await fixture(t);await h.client('CONTROL',2);assert.equal((await h.audit()).body.audit.status,'UNKNOWN');assert.equal((await h.remove()).status,409);});
test('revoked legacy credentials alone do not certify old local runtime implementation',async t=>{const h=await fixture(t),old=await h.client('CONTROL',2);h.auth.sessions.delete(old.session.id);assert.equal((await h.remove()).status,409);});
test('historical classification retains submitted asset-specific aliases',async t=>{const h=await fixture(t),old=await h.client();await h.request(old,'/api/media-library/reference-clients/'+old.identity.clientId+'/legacy-assets','PUT',{generation:1,assets:[{assetId:h.asset.id,kind:'image'}],complete:true});h.auth.sessions.delete(old.session.id);assert.equal((await h.audit()).body.audit.status,'USED');assert.equal((await h.remove()).status,409);});
test('positive resume with new authentication becomes pending again',async t=>{const h=await fixture(t),old=await h.client();h.auth.sessions.delete(old.session.id);const next=await h.client();const resumed=await h.request(next,'/api/media-library/reference-clients','POST',{role:'SCHEDULER',version:3,capabilities,resumeId:old.identity.clientId,resumeGeneration:1,resumeToken:old.identity.resumeToken});assert.equal(resumed.status,201);assert.equal(h.owner.referenceClients.isHistoricalNonwriter(h.owner.referenceClients.clients.get(old.identity.clientId)),false);assert.equal((await h.remove()).status,409);});
test('Preview asset ownership stays USED with an unrelated historical catalog',async t=>{const h=await fixture(t),old=await h.client();h.auth.sessions.delete(old.session.id);await h.request(h.control,'/api/media-library/preview-ownership/'+h.control.preview.sessionId,'PUT',{sequence:2,assets:[h.asset.id],complete:true});assert.equal((await h.audit()).body.audit.status,'USED');assert.equal((await h.remove()).status,409);});
test('historical Control census never clears uncertain runtime ownership',async t=>{const h=await fixture(t);h.auth.sessions.delete(h.control.session.id);await h.owner.previewOwnership.disconnect(h.control.principal+'|'+h.control.identity.clientId+'|1');assert.equal((await h.remove()).status,409);});
test('final recheck protects a catalog reference committed after UNUSED audit',async t=>{const h=await fixture(t),old=await h.client();h.auth.sessions.delete(old.session.id);assert.equal((await h.audit()).body.audit.status,'UNUSED');const state=await h.request(h.scheduler,'/api/studio/state');const result=await h.request(h.scheduler,'/api/studio/state/catalog','PUT',{revision:state.body.state.revision,sources:[{id:'fixture-image',name:'Image',kind:'image',assetId:h.asset.id}],scenes:[]});assert.equal(result.status,200);assert.equal((await h.remove()).status,409);assert.ok(h.repo.get(h.asset.id));});
test('deleted fixture asset cannot later enter authoritative catalog',async t=>{const h=await fixture(t),old=await h.client();h.auth.sessions.delete(old.session.id);assert.equal((await h.remove()).status,200);const state=await h.request(h.scheduler,'/api/studio/state');assert.equal((await h.request(h.scheduler,'/api/studio/state/catalog','PUT',{revision:state.body.state.revision,sources:[{id:'fixture-image',name:'Image',kind:'image',assetId:h.asset.id}],scenes:[]})).status,422);});
test('anonymous Public/OBS request cannot delete even with complete inventory',async t=>{const h=await fixture(t);assert.equal((await h.request(null,'/api/media-library/assets/'+h.asset.id,'DELETE')).status,401);assert.ok(h.repo.get(h.asset.id));});
test('earliest retained scanner predicate requires complete domains and zero references',async()=>{const asset={id:'asset-00000000-0000-4000-8000-000000000001',url:'/media-library/files/image/fixture.png'};let complete=true;const audit=new MediaReferenceAudit({inventories:()=>[{name:'fixture',complete,data:{}}]});assert.equal((await audit.inspect(asset)).eligible,true);complete=false;assert.equal((await audit.inspect(asset)).eligible,false);});
test('persisted pending historical record is classified after restart without erasure',async t=>{const h=await fixture(t),old=await h.client();h.auth.sessions.delete(old.session.id);const live=h.owner.referenceClients;const restored=new ReferenceClientRegistry({coordinator:h.owner.assetMutations,path:live.path,coverageProven:true,minimumVersion:3,requireEpoch:true,isSessionRevoked:live.isSessionRevoked});await restored.ready;assert.equal(restored.isHistoricalNonwriter(restored.clients.get(old.identity.clientId)),true);assert.equal(restored.clients.get(old.identity.clientId).catalog,'PENDING');assert.ok(restored.snapshot().reasons.includes('CLIENT_CENSUS_RECONNECT_REQUIRED'));});
test('absent revocation proof keeps historical-looking record unsafe',async t=>{const h=await fixture(t),old=await h.client();h.auth.sessions.delete(old.session.id);h.owner.referenceClients.isSessionRevoked=undefined;assert.equal((await h.remove()).status,409);});
test('Channel Logo reference still blocks with historical pending catalog',async t=>{const h=await fixture(t),old=await h.client();h.auth.sessions.delete(old.session.id);const path='/api/media-library/channel-logo/program';assert.equal((await h.request(h.control,path,'PUT',{revision:1,asset:h.asset.url})).status,200);assert.equal((await h.request(h.control,path,'POST',{revision:2})).status,200);assert.equal((await h.audit()).body.audit.status,'USED');assert.equal((await h.remove()).status,409);});
test('queued catalog mutation wins before final DELETE recheck',async t=>{const h=await fixture(t),old=await h.client();h.auth.sessions.delete(old.session.id);let release,entered;const blocked=new Promise(r=>entered=r);const gate=h.owner.assetMutations.run(async()=>{entered();await new Promise(r=>release=r);});await blocked;const revision=h.owner.studioStateCoordinator.getSnapshot().revision;const write=h.owner.studioStateCoordinator.updateCatalog({revision,sources:[{id:'queued-image',name:'Queued image',kind:'image',assetId:h.asset.id}],scenes:[]});const remove=h.remove();release();await gate;await write;assert.equal((await remove).status,409);assert.ok(h.repo.get(h.asset.id));});
