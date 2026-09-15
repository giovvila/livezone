import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig,normalizeConfig,normalizePatch,normalizeRecovery,POLICY} from '../server/autolive/AutoLiveContract.js';
import AutoLiveStore from '../server/autolive/AutoLiveStore.js';
import AutoLiveRecoveryStore from '../server/autolive/AutoLiveRecoveryStore.js';
import AutoLiveAuthority from '../server/autolive/AutoLiveAuthority.js';
import AssetReferenceInventory from '../server/media-library/AssetReferenceInventory.js';

const at='2026-09-15T12:00:00.000Z',clock=()=>Date.parse(at);
const assetId='asset-00000000-0000-4000-8000-000000000001';
const record=()=>({version:1,sessionId:'auto-session',stage:'CAPTURED',
    capturedActivation:{publisherSessionId:'publisher',committedAt:at,sceneId:'scene-a',sourceId:'video-a'},
    programRevision:4,sceneId:'scene-a',sourceId:'video-a',sourceKind:'media',sourceVersion:'catalog-4',
    cueAtInterruption:37.25,playbackState:'playing',assets:[{assetId,kind:'video'}],createdAt:at,updatedAt:at,
    expectedCurrentActivation:null,actionKey:'return-session-1'});
async function directory(t){const root=await mkdtemp(join(tmpdir(),'lz-autolive-store-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function authority(t,{catalog}={}){const root=await directory(t);const state=catalog||{initialized:true,sources:[
    {id:'live-a',kind:'hls',enabled:true,url:'https://live.example/index.m3u8'},
    {id:'video-a',kind:'media',assetId}],scenes:[]};
    const options={path:join(root,'config.json'),recoveryPath:join(root,'recovery.json'),catalog:()=>state,clock};
    const owner=new AutoLiveAuthority(options);t.after(()=>owner.close());await owner.ready;return {root,owner,state,options};}

test('A1 safe defaults and deterministic config/policy serialization',()=>{
    const config=defaultConfig();assert.deepEqual(config,{version:1,revision:0,enabled:false,armed:false,sourceId:null,updatedAt:null,migration:null});
    assert.equal(JSON.stringify(normalizeConfig(JSON.parse(JSON.stringify(config)))),JSON.stringify(config));
    assert.equal(POLICY.entryHealthyPlaybackMs,30000);assert.equal(POLICY.externalConfirmedLossMs,15000);assert.equal(POLICY.managedLegacyLossGraceMs,5000);
});
for(const patch of [{url:'https://evil/'},{sourceId:'../live'},{sourceId:'x/y'},{armed:1},{enabled:'true'},{entryDelayMs:1},{__proto__:null,constructor:'bad'},{}])
    test('A1 rejects invalid operator patch '+JSON.stringify(patch),()=>assert.throws(()=>normalizePatch(patch)));
test('A1 contract rejects persisted runtime/secret fields and invalid migration',()=>{
    assert.throws(()=>normalizeConfig({...defaultConfig(),token:'secret'}));
    assert.throws(()=>normalizeConfig({...defaultConfig(),migration:{version:2,completedAt:at}}));
    assert.throws(()=>normalizeConfig({...defaultConfig(),armed:true}));
});
test('A1 first boot is read-only; patch revisions persist; concurrent writer loses CAS',async t=>{
    const root=await directory(t),path=join(root,'config.json'),store=new AutoLiveStore({path,clock});await store.initialize();
    assert.deepEqual(await readdir(root),[]);
    const results=await Promise.allSettled([store.patch({enabled:true},0),store.patch({armed:true},0)]);
    assert.equal(results[0].status,'fulfilled');assert.equal(results[1].reason.code,'REVISION_CONFLICT');
    const next=await store.patch({armed:true},1);assert.equal(next.revision,2);assert.equal(next.enabled,true);
    const loaded=new AutoLiveStore({path,clock});await loaded.initialize();assert.deepEqual(loaded.getSnapshot(),next);
    await store.close();await loaded.close();
});
test('A1 failed atomic rename preserves accepted memory/disk and removes temp',async t=>{
    const root=await directory(t),path=join(root,'config.json'),store=new AutoLiveStore({path,clock});await store.patch({enabled:true},0);
    const before=await readFile(path,'utf8');store.fs.rename=async()=>{throw Error('disk');};
    await assert.rejects(store.patch({armed:true},1),{code:'PERSISTENCE_FAILED'});
    assert.equal(await readFile(path,'utf8'),before);assert.equal(store.getSnapshot().armed,false);assert.deepEqual(await readdir(root),['config.json']);await store.close();
});
for(const raw of ['{bad',JSON.stringify({...defaultConfig(),revision:-1})])test('A1 corrupt startup never overwrites data '+raw,async t=>{
    const root=await directory(t),path=join(root,'config.json');await writeFile(path,raw);const store=new AutoLiveStore({path,clock});await store.initialize();
    assert.equal(store.status,'UNAVAILABLE');assert.equal(store.getSnapshot(),null);await assert.rejects(store.patch({armed:true},0),{code:'STORE_UNAVAILABLE'});
    assert.equal(await readFile(path,'utf8'),raw);await store.close();
});
test('A1 explicit migration preserves both consents once, marker survives reload',async t=>{
    const {owner,options}=await authority(t);assert.equal(owner.current().migration.pristine,true);
    await owner.mutate({version:1,enabled:false,armed:true,sourceId:'live-a'},0,{migration:true});
    assert.equal(owner.current().config.enabled,false);assert.equal(owner.current().config.armed,true);
    await assert.rejects(owner.mutate({version:1,enabled:true,armed:false,sourceId:null},1,{migration:true}),{code:'MIGRATION_CLOSED'});
    await owner.close();const next=new AutoLiveAuthority(options);t.after(()=>next.close());await next.ready;
    assert.equal(next.current().migration.completed,true);assert.equal(next.current().runtime.executionAuthority,'browser-legacy');
    assert.equal(next.current().runtime.entryHealthyMs,0);assert.equal(next.current().runtime.deadline,null);
});
test('A1 normal first mutation closes migration; stale revision cannot import',async t=>{
    const {owner}=await authority(t);await owner.mutate({enabled:true},0);
    await assert.rejects(owner.mutate({version:1,enabled:true,armed:true,sourceId:'live-a'},0,{migration:true}),{code:'REVISION_CONFLICT'});
    await assert.rejects(owner.mutate({version:1,enabled:true,armed:true,sourceId:'live-a'},1,{migration:true}),{code:'MIGRATION_CLOSED'});
});
for(const source of [{id:'live-a',kind:'media'},{id:'live-a',kind:'hls',enabled:false,url:'https://live.example/'},
    {id:'live-a',kind:'hls',configRef:'missing'},null])test('A1 source validation fail closed '+JSON.stringify(source),async t=>{
    const {owner}=await authority(t,{catalog:{initialized:true,sources:source?[source]:[],scenes:[]}});
    await assert.rejects(owner.mutate({sourceId:'live-a'},0),{code:'SOURCE_UNRESOLVED'});
    assert.equal(owner.current().config.revision,0);
});
test('A1 catalog change is runtime uncertainty, not config rewrite or health probe',async t=>{
    const {owner,state}=await authority(t);await owner.mutate({sourceId:'live-a',armed:true,enabled:true},0);
    assert.equal(owner.current().runtime.phase,'ARMED');state.sources=[];owner.refresh();
    assert.equal(owner.current().runtime.phase,'UNCERTAIN');assert.equal(owner.current().config.revision,1);
    assert.equal(owner.current().runtime.healthState,'UNKNOWN');assert.equal(owner.current().runtime.lastAction,null);
});
test('A1 duplicate process-local owner cannot mutate',async t=>{
    const {owner,options}=await authority(t),duplicate=new AutoLiveAuthority(options);t.after(()=>duplicate.close());await duplicate.ready;
    assert.equal(duplicate.available(),false);await assert.rejects(duplicate.mutate({armed:true},0),{code:'STORE_UNAVAILABLE'});assert.equal(owner.current().config.revision,0);
});
for(const playbackState of ['playing','paused','ended'])test('A1 recovery roundtrip '+playbackState,()=>{
    const value=normalizeRecovery({...record(),playbackState});assert.deepEqual(normalizeRecovery(JSON.parse(JSON.stringify(value))),value);
});
for(const patch of [{cueAtInterruption:-1},{cueAtInterruption:null},{sourceVersion:'http://evil/'},{actionKey:'../x'},
    {capturedActivation:{rendererInstanceId:'local'}},{timer:5},{assets:[{assetId:'../media',kind:'video'}]},
    {sceneId:'other'},{expectedCurrentActivation:{}}])test('A1 invalid recovery '+JSON.stringify(patch),()=>assert.throws(()=>normalizeRecovery({...record(),...patch})));
test('A1 recovery persistence, CAS, key guard, clear and restart',async t=>{
    const root=await directory(t),path=join(root,'recovery.json'),store=new AutoLiveRecoveryStore({path});await store.save(record(),0);
    const next=new AutoLiveRecoveryStore({path});await next.initialize();assert.equal(next.getSnapshot().record.cueAtInterruption,37.25);
    await assert.rejects(next.clear(1,'wrong'),{code:'RECOVERY_CONFLICT'});await assert.rejects(next.clear(0,record().actionKey),{code:'REVISION_CONFLICT'});
    await next.clear(1,record().actionKey);assert.equal(next.getSnapshot().record,null);await store.close();await next.close();
    const reloaded=new AutoLiveRecoveryStore({path});await reloaded.initialize();assert.equal(reloaded.getSnapshot().revision,2);assert.equal(reloaded.getSnapshot().record,null);await reloaded.close();
});
test('A1 recovery references protect canonical asset and clear releases; empty inactive storage does not hold assets',async t=>{
    const {owner}=await authority(t),asset={id:assetId,kind:'video'},repository={list:()=>[asset],get:id=>id===assetId?asset:null};
    // Only the recovery projection is measured here; production also includes catalog/Program/Preview.
    const inventory=new AssetReferenceInventory({repository,inventories:()=>owner.references().length?owner.references():[{name:'empty',complete:true,data:{}}]});
    assert.equal((await inventory.inspect(asset)).status,'UNUSED');await owner.recovery.save(record(),0);
    assert.equal((await inventory.inspect(asset)).status,'USED');assert.equal((await inventory.inspect(asset)).eligible,false);
    await owner.recovery.clear(1,record().actionKey);assert.equal((await inventory.inspect(asset)).status,'UNUSED');
    owner.recovery.status='UNAVAILABLE';assert.equal((await inventory.inspect(asset)).status,'UNUSED');assert.equal((await inventory.inspect(asset)).eligible,true);
});

test('A1 empty Program recovery is serializable without invented media identity',()=>{
    const value=record();Object.assign(value,{sceneId:null,sourceId:null,sourceKind:null,sourceVersion:null,cueAtInterruption:null,playbackState:'ready',assets:[]});
    Object.assign(value.capturedActivation,{sceneId:null,sourceId:null});
    assert.equal(normalizeRecovery(value).sourceId,null);
    assert.throws(()=>normalizeRecovery({...value,cueAtInterruption:0}));
});

test('A1 recovery pins assets after catalog removal and candidate references before return',async t=>{
    const {owner,state}=await authority(t);state.sources.push({id:'candidate',kind:'image',assetId:'asset-00000000-0000-4000-8000-000000000002'});
    const value=record();value.expectedCurrentActivation={...value.capturedActivation,sourceId:'candidate'};
    await owner.recovery.save(value,0);
    assert.equal(owner.references()[0].data.candidate.id,'candidate');
    state.sources=[];
    assert.equal(owner.references()[0].complete,true);assert.ok(owner.references()[0].unresolvedRefs.length);
    assert.equal(owner.references()[0].data.assets[0].assetId,assetId);
    await owner.recovery.clear(1,value.actionKey);assert.deepEqual(owner.references(),[]);
});

test('A1 recovery path cannot have a second process-local authority',async t=>{
    const {owner,options,root}=await authority(t);
    const duplicate=new AutoLiveAuthority({...options,path:join(root,'different-config.json')});t.after(()=>duplicate.close());await duplicate.ready;
    assert.equal(duplicate.available(),false);assert.equal(owner.available(),true);
});

for(const enabled of [false,true])for(const armed of [false,true])test(`review migration preserves enabled=${enabled}, armed=${armed}`,async t=>{
    const {owner}=await authority(t);await owner.mutate({version:1,enabled,armed,sourceId:'live-a'},0,{migration:true});
    assert.equal(owner.current().config.enabled,enabled);assert.equal(owner.current().config.armed,armed);
});
test('review concurrent migration and lost-response retry cannot apply twice',async t=>{
    const {owner}=await authority(t),value={version:1,enabled:true,armed:true,sourceId:'live-a'};
    const results=await Promise.allSettled([owner.mutate(value,0,{migration:true}),owner.mutate({...value,armed:false},0,{migration:true})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'REVISION_CONFLICT');
    await assert.rejects(owner.mutate(value,0,{migration:true}),{code:'REVISION_CONFLICT'});
    await assert.rejects(owner.mutate(value,1,{migration:true}),{code:'MIGRATION_CLOSED'});assert.equal(owner.current().config.revision,1);
});
for(const sourceId of ['missing','../bad','live-a?url=evil'])test('review failed migration remains pristine '+sourceId,async t=>{
    const {owner}=await authority(t);await assert.rejects(owner.mutate({version:1,enabled:true,armed:true,sourceId},0,{migration:true}));
    assert.equal(owner.current().migration.pristine,true);assert.equal(owner.current().config.enabled,false);assert.equal(owner.current().config.armed,false);
});
function reviewInventory(owner){
    const a={id:assetId,kind:'video'},b={id:'asset-00000000-0000-4000-8000-000000000002',kind:'video'};
    const repository={list:()=>[a,b],get:id=>[a,b].find(a=>a.id===id)};
    return {a,b,inventory:new AssetReferenceInventory({repository,inventories:()=>owner.references().length?owner.references():[{name:'empty',complete:true,data:{}}]})};
}
test('review recovery holds A while unrelated B is eligible and clear releases only A',async t=>{
    const {owner}=await authority(t),{a,b,inventory}=reviewInventory(owner);await owner.recovery.save(record(),0);
    assert.equal((await inventory.inspect(a)).status,'USED');assert.equal((await inventory.inspect(b)).eligible,true);
    await owner.recovery.clear(1,record().actionKey);assert.equal((await inventory.inspect(a)).eligible,true);assert.equal((await inventory.inspect(b)).eligible,true);
});
test('review gate: stale selected source must not make unrelated B UNKNOWN',async t=>{
    const {owner,state}=await authority(t),{b,inventory}=reviewInventory(owner);await owner.mutate({sourceId:'live-a'},0);state.sources=[];owner.refresh();
    assert.equal((await inventory.inspect(b)).status,'UNUSED','stale selected source poisoned unrelated asset inventory');
});
test('review gate: durable A hold survives catalog removal without poisoning unrelated B',async t=>{
    const {owner,state}=await authority(t),{b,inventory}=reviewInventory(owner);await owner.recovery.save(record(),0);state.sources=[];owner.refresh();
    assert.equal((await inventory.inspect(b)).status,'UNUSED','canonical removal broadened a specific durable hold');
});
test('review gate: corrupt recovery must have bounded unrelated-asset impact',async t=>{
    const {owner,options}=await authority(t);await owner.recovery.save(record(),0);await owner.close();await writeFile(options.recoveryPath,'{corrupt');
    const reloaded=new AutoLiveAuthority(options);t.after(()=>reloaded.close());await reloaded.ready;
    const {b,inventory}=reviewInventory(reloaded);assert.equal(reloaded.current().runtime.phase,'ERROR');
    assert.equal((await inventory.inspect(b)).status,'UNUSED','no independently trusted asset scope survives corrupt recovery');
});

for(const enabled of [false,true])test('scoping invalid selected source with enabled/armed '+enabled,async t=>{
    const {owner,state}=await authority(t),{b,inventory}=reviewInventory(owner);
    await owner.mutate({sourceId:'live-a',enabled,armed:enabled},0);state.sources=[];owner.refresh();
    assert.equal(owner.current().runtime.phase,'UNCERTAIN');assert.equal((await inventory.inspect(b)).status,'UNUSED');
    assert.deepEqual((await inventory.collect()).unresolvedRefs,[{sourceId:'live-a',authority:'AutoLive selected source'}]);
});
test('scoping valid recovery keeps A protected after catalog removal',async t=>{
    const {owner,state}=await authority(t),{a,b,inventory}=reviewInventory(owner);await owner.recovery.save(record(),0);state.sources=[];
    assert.equal((await inventory.inspect(a)).status,'USED');assert.equal((await inventory.inspect(b)).status,'UNUSED');
    await owner.recovery.clear(1,record().actionKey);assert.equal((await inventory.inspect(a)).status,'UNUSED');
});
test('scoping corrupt but parsable recovery protects recovered IDs without repairing bytes',async t=>{
    const {owner,options}=await authority(t);await owner.close();const raw=JSON.stringify({version:1,revision:1,record:{...record(),cueAtInterruption:-1}});
    await writeFile(options.recoveryPath,raw);const next=new AutoLiveAuthority(options);t.after(()=>next.close());await next.ready;
    const {a,b,inventory}=reviewInventory(next);assert.equal(next.recovery.referenceScope().classification,'CORRUPT_BUT_SCOPABLE');
    assert.equal(next.current().runtime.phase,'ERROR');assert.equal((await inventory.inspect(a)).status,'UNKNOWN');assert.equal((await inventory.inspect(b)).status,'UNUSED');
    await assert.rejects(next.recovery.clear(1,record().actionKey),{code:'STORE_UNAVAILABLE'});assert.equal(await readFile(options.recoveryPath,'utf8'),raw);
});
for(const raw of ['{bad',JSON.stringify({version:99,record:null})])test('scoping inactive unreadable foundation is not a global writer '+raw,async t=>{
    const {owner,options}=await authority(t);await owner.close();await writeFile(options.recoveryPath,raw);
    const next=new AutoLiveAuthority(options);t.after(()=>next.close());await next.ready;const {b,inventory}=reviewInventory(next);
    const scope=next.recovery.referenceScope();assert.equal(scope.executionCapability,'storage-only');assert.equal(scope.globallyIncomplete,false);
    assert.equal(scope.classification,raw==='{bad'?'CORRUPT_UNSCOPABLE':'INVALID_NONAUTHORITATIVE');
    assert.equal((await inventory.inspect(b)).eligible,true);assert.equal(await readFile(options.recoveryPath,'utf8'),raw);
});
test('scoping multiple recovery assets A/C remain protected independently of B',async t=>{
    const {owner}=await authority(t),{a,b}=reviewInventory(owner),c={id:'asset-00000000-0000-4000-8000-000000000003',kind:'image'};
    await owner.recovery.save({...record(),assets:[{assetId:a.id,kind:'video'},{assetId:c.id,kind:'image'}]},0);
    const inventory=new AssetReferenceInventory({repository:{list:()=>[a,b,c]},inventories:()=>owner.references()});
    assert.equal((await inventory.inspect(a)).status,'USED');assert.equal((await inventory.inspect(c)).status,'USED');assert.equal((await inventory.inspect(b)).status,'UNUSED');
});
for(const invalid of [false,true])test('scoping selected canonical source mapping invalid='+invalid,async t=>{
    const {owner,state}=await authority(t),{a,b,inventory}=reviewInventory(owner);await owner.mutate({sourceId:'live-a'},0);
    Object.assign(state.sources[0],{stillAssetId:a.id,...(invalid?{motionAssetId:'invalid'}:{})});
    assert.equal((await inventory.inspect(a)).status,invalid?'UNKNOWN':'USED');assert.equal((await inventory.inspect(b)).status,'UNUSED');
});
test('scoping never weakens other incomplete authorities or deletion recovery',async t=>{
    const {owner}=await authority(t),{b}=reviewInventory(owner);
    for(const name of ['PROGRAM','Preview ownership','Scheduler','Legacy current writer']){
        const inventory=new AssetReferenceInventory({repository:{list:()=>[b]},inventories:()=>[...owner.references(),{name,complete:false,data:null}]});
        assert.equal((await inventory.inspect(b)).status,'UNKNOWN');
    }
    const inventory=new AssetReferenceInventory({repository:{list:()=>[b],deleteRecoveryRequired:true},inventories:()=>[{name:'empty',complete:true,data:{}}]});
    assert.equal((await inventory.inspect(b)).status,'UNKNOWN');
});

test('scoping duplicate live writer ownership remains genuinely globally incomplete',async t=>{
    const {options}=await authority(t);const duplicate=new AutoLiveAuthority(options);t.after(()=>duplicate.close());await duplicate.ready;
    const {b,inventory}=reviewInventory(duplicate);assert.equal((await inventory.inspect(b)).status,'UNKNOWN');
    assert.deepEqual((await inventory.globalCompleteness()).reasons,['AutoLive writer ownership unavailable']);
});
