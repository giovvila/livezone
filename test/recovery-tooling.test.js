import test from 'node:test';
import {registerNativeTestRoot} from '../test-support/NativeTempGuard.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,readdir,unlink,rename,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {paths,capture,artifact,classifyMaintenance,bootstrapPlan,verifyMigration,verifyReadiness,runtimeStatus,assertRestore,BRANCH} from '../server/recovery/RecoveryContract.js';
import {RecoveryWorkflow} from '../server/recovery/RecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {offlineDisarm} from '../server/recovery/OfflineDisarm.js';
import {reconcileAuthorityLock} from '../server/autolive/ReconcileAuthorityLock.js';
import {digest} from '../server/scheduler/ScheduledExecutionProvenance.js';
import {recordFor} from '../server/program-output/DurableProgramContract.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
import {createInitializedState} from '../server/studio/AuthoritativeStateContract.js';
import {createProgramOutputServer} from '../server/program-output-server.js';
import ScheduleStore from '../server/scheduler/ScheduleStore.js';
import ScheduledRepository from '../server/scheduler/ScheduledLiveExecutionRepository.js';
import {initializeEntryLedger} from '../server/scheduler/ScheduledEntryRuntime.js';
import {ledgerSnapshot,entryConsumption} from '../server/scheduler/ScheduledEntryLedgerContract.js';
import {identity as migrationIdentity} from '../test-support/CleanLedgerMigrationFixture.mjs';
import {evaluateWindowsAuthorityCensus} from '../server/autolive/WindowsAuthorityProcessProof.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const HEAD='b63c03d94a7f932d6c4052e9f1bed407819ae12b';
const save=(path,value)=>writeFile(path,JSON.stringify(value));
const stamp='2026-09-01T00:00:00.000Z';
const event={id:'historical-fixture',version:1,type:'source.live',enabled:true,startAt:stamp,endAt:'2026-09-01T01:00:00.000Z',priority:1,
    payload:{sourceId:'primecast',precheckSeconds:180,unavailableAction:'KEEP_PROGRAM',unavailableSceneId:null,endAction:'RETURN',endSceneId:null},createdAt:stamp,updatedAt:stamp};
async function fixture(t,{legacy=true,adopt=true}={}){
    const root=await mkdtemp(join(tmpdir(),'lz-recovery-')),p=paths(root),owners=[];
    registerNativeTestRoot(root);
    t.after(async()=>{for(const owner of owners)await new Promise(done=>owner.server.close(()=>done()));
        const child=relative(tmpdir(),root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(root,{recursive:true,force:true});});
    await mkdir(dirname(p.auto),{recursive:true});await mkdir(dirname(p.schedule),{recursive:true});
    const service={Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',PathName:join(root,'ops/LivezoneNode.exe'),StartName:'LocalSystem',DelayedPresent:true,DelayedValue:1};
    const media={status:'VERIFIED',Name:'LivezoneMediaMtx',State:'Running',StartMode:'Auto',PathName:'fixture-mediamtx'};
    const original={...service,StartMode:'Auto'};
    let online=false,reserves=0,restores=0;
    const host={inspect:async()=>({root,head:HEAD,branch:BRANCH,administrator:true,service:{...service},media:{...media},
        bootstrapPermission:false,proof:{absent:true,processes:[{pid:process.pid,kind:'MAINTENANCE_SELF'}]},ports:online?[{OwningProcess:process.pid,LocalPort:8080}]:[]}),
        proveOffline:async()=>({absent:!online}),reserve:async()=>{assert.equal(online,false);reserves++;return ()=>{};},fixtureAlive:()=>false,
        restore:async value=>{restores++;Object.assign(service,value);}};
    if(adopt)await save(p.maintenance,{Version:1,Repository:root,Head:'44816ca167b1042c8670c169f401ae7e961727ae',CapturedAt:stamp,Original:original});
    await save(p.auto,{version:1,revision:7,enabled:true,armed:true,sourceId:'primecast',updatedAt:stamp,migration:null});
    await save(p.authority,{epoch:20});await save(p.authorityLock,{pid:50780,authorityProcessSession:'previous-authority'});
    await save(p.schedule,{version:2,revision:50,events:[event],programPlan:{version:1,timezone:'Europe/Rome',items:[]}});
    const envelope=createProgramOutputEnvelope({version:1,publisherSessionId:'fixture',revision:1,publishedAt:stamp,committedAt:stamp,
        scene:null,source:null,playback:{initialTime:27,duration:120,playing:true,ended:false,state:'playing',startedAt:stamp},graphics:{items:[]},transition:{type:'cut',durationMs:0}});
    assert.ok(envelope);
    await save(p.program,recordFor({envelope,retiredPublisherSessions:[],identity:{sourceFingerprint:null,catalog:null,assets:[]},generation:8,authorityEpoch:20}));
    const studio=createInitializedState({sources:[{id:'primecast',name:'Live',kind:'hls',enabled:true,url:'https://example.test/live.m3u8'}],scenes:[],
        scheduler:{version:1,timezone:'Europe/Rome',items:[],enabled:false},globalOverlays:{textCrawl:null},dominantLive:{armed:false,authorizedSourceId:null}},{stateId:'fixture',updatedAt:stamp});
    await save(p.studio,studio);
    if(legacy)await save(p.scheduledLock,{version:1,processSession:'legacy-session'});
    const w=new RecoveryWorkflow({root,runId:'fixture-run',host,expectedHead:HEAD});
    async function auto(){const plan=await w.autoPlan();if(!plan.args.length)return;
        const [path,epoch,pid,session,epochHash,lockHash]=plan.args;
        return reconcileAuthorityLock({path,expectedEpoch:Number(epoch),expectedPid:Number(pid),expectedSession:session,expectedEpochHash:epochHash,expectedLockHash:lockHash,
            proveOffline:host.proveOffline,reserve:host.reserve,isAlive:()=>false});}
    async function prepare(){await w.begin({authorizeLegacy:legacy});await auto();await w.scheduled();await w.prepared();}
    async function disarm(){const r=await w.load();return w.disarm({authorize:true,expectedHash:r.before.auto.hash,expectedRevision:r.before.auto.value.revision});}
    function launch(options){online=true;const owner=createProgramOutputServer({...options,mediaLibraryRoot:join(root,'var/media'),
        publisherToken:'fixture-only-publisher-token',scheduledEntryLogger:()=>{},scheduleSetTimer:()=>1,scheduleClearTimer:()=>{},
        mediaAssetRepository:{initialize:async()=>{},list:()=>[],get:()=>null}});owners.push(owner);return owner;}
    return {root,p,w,host,service,media,original,prepare,auto,disarm,launch,owners,setOffline:()=>{online=false;},counts:()=>({reserves,restores})};
}
async function tree(root){const values=[];async function visit(dir){for(const name of await readdir(dir)){const path=join(dir,name),s=await stat(path);if(s.isDirectory())await visit(path);else values.push([relative(root,path),digest(await readFile(path)),s.mtimeMs]);}}await visit(root);return values.sort();}

test('post-bootstrap Prepare returns PREPARED and exits despite persistent TCP probes',async t=>{
    const h=await fixture(t,{legacy:false});await unlink(h.p.authorityLock);
    await save(h.p.authority,{epoch:21});
    await save(h.p.auto,{...(await artifact(h.p.auto)).value,revision:27,armed:false});
    const store=new ScheduleStore({path:h.p.schedule});await store.initialize();await store.destroy();
    await save(h.p.ledger,ledgerSnapshot());await save(h.p.marker,{version:1,authorityEpoch:21});
    const before=await capture(h.p);
    const child=fileURLToPath(new URL('../test-support/post-bootstrap-prepare-child.mjs',import.meta.url));
    let result;
    // Repeated Prepare now performs native preflight and final evidence fences.
    // Keep the natural-exit/socket-leak proof bounded by the native child budget.
    try{result=await promisify(execFile)(process.execPath,[child,h.root,HEAD],{timeout:300000,windowsHide:true,
        env:{...process.env,LIVEZONE_NATIVE_TEST_ROOTS:JSON.stringify([h.root])}});}
    catch(error){assert.fail('Fixture did not complete/exit: '+error.message+'\n'+error.stdout+'\n'+error.stderr);}
    assert.match(result.stdout,/AUDIT_DURABLE_ADOPTED/);assert.match(result.stdout,/RELEASE_RETURN/);
    assert.match(result.stdout,/PREPARED_UNCHANGED/);assert.equal(result.stderr,'');
    const preparedEvidence=await capture(h.p);
    for(const key of Object.keys(before).filter(k=>!k.startsWith('migration')))assert.deepEqual(preparedEvidence[key],before[key]);
    assert.equal(preparedEvidence.migrationIntent.value.state,'INTENT');assert.ok(await artifact(h.w.audit+'.prepared'));
});

test('DryRun inventory is zero mutation, including timestamps and no port reservation',async t=>{
    const h=await fixture(t),before=await tree(h.root),result=await h.w.inspect();
    assert.equal(result.maintenance,'ADOPTED_MAINTENANCE');assert.equal(result.scheduled,'LEGACY_UNVERIFIABLE');
    assert.equal(result.evidence.schedule.value.revision,50);assert.equal(result.evidence.auto.value.armed,true);
    assert.deepEqual(await tree(h.root),before);assert.deepEqual(h.counts(),{reserves:0,restores:0});
});
test('NEW maintenance creation preserves observed service configuration',async t=>{
    const h=await fixture(t,{adopt:false});assert.equal((await h.w.begin({authorizeLegacy:true})).maintenance,'NEW_MAINTENANCE');
    assert.deepEqual((await artifact(h.p.maintenance)).value.Original,h.service);
});
test('old HEAD adoption preserves Automatic/delayed original bytes and audits current HEAD separately',async t=>{
    const h=await fixture(t),bytes=await readFile(h.p.maintenance);await h.w.begin({authorizeLegacy:true});
    assert.deepEqual(await readFile(h.p.maintenance),bytes);assert.equal((await h.w.load()).head,HEAD);
});
for(const field of ['Repository','Name','PathName','StartName','StartMode','DelayedPresent','DelayedValue'])test('maintenance conflict: '+field,async t=>{
    const h=await fixture(t),r=(await artifact(h.p.maintenance)).value;
    if(field==='Repository')r.Repository=join(h.root,'other');else r.Original[field]='invalid';await save(h.p.maintenance,r);
    const before=await tree(h.root);await assert.rejects(h.w.begin({authorizeLegacy:true}),/MAINTENANCE_CONFLICT/);assert.deepEqual(await tree(h.root),before);
});
test('legacy authorization is mandatory; lock operations do not disarm',async t=>{
    const h=await fixture(t);await assert.rejects(h.w.begin(),/EXPLICIT_LEGACY_AUTHORIZATION_REQUIRED/);await h.prepare();
    assert.equal((await artifact(h.p.auto)).value.armed,true);assert.equal(await artifact(h.p.scheduledLock),null);
    const c=(await artifact(h.p.scheduled+'.reconciliation-fixture-run.json.completed')).value;assert.equal(c.reason,'LEGACY_UNVERIFIABLE');
});
test('legacy with journal is blocked before any recovery audit',async t=>{
    const h=await fixture(t);await save(h.p.scheduled,{schemaVersion:1});await assert.rejects(h.w.begin({authorizeLegacy:true}),/LEGACY_JOURNAL_REVIEW_REQUIRED/);
    assert.equal(await artifact(h.w.audit),null);
});
test('new-schema locks reconcile before AutoLive using actual provenance module',async t=>{
    const h=await fixture(t,{legacy:false}),a={available:true,path:h.p.authority,authorityEpoch:20,authorityProcessSession:'previous-authority'};
    const r=new ScheduledRepository({path:h.p.scheduled,authority:a});await r.initialize();const lock=await readFile(h.p.scheduledLock);await r.close();await writeFile(h.p.scheduledLock,lock);
    await save(h.p.authorityLock,{pid:process.pid,authorityProcessSession:a.authorityProcessSession});
    await h.w.begin();await assert.rejects(h.w.autoPlan(),/SCHEDULED_COMPLETION_REQUIRED/);await h.w.scheduled();await h.auto();await h.w.prepared();
});
for(const kind of ['hash','session'])test('reviewed Scheduled '+kind+' mismatch refuses archival',async t=>{
    const h=await fixture(t);await h.w.begin({authorizeLegacy:true});await h.auto();const lock=(await artifact(h.p.scheduledLock)).value;
    if(kind==='session')lock.processSession='changed';else lock.extra=true;await save(h.p.scheduledLock,lock);
    await assert.rejects(h.w.scheduled(),/EXPECTED_EVIDENCE_MISMATCH/);assert.ok(await artifact(h.p.scheduledLock));
});
test('census changing between checks refuses mutations',async t=>{
    const h=await fixture(t),before=await tree(h.root);let n=0;h.host.proveOffline=async()=>({absent:++n===1});
    await assert.rejects(h.w.begin({authorizeLegacy:true}),/CANONICAL_OFFLINE/);assert.deepEqual(await tree(h.root),before);
});
for(const field of ['administrator','head','branch','bootstrapPermission'])test('preflight refuses '+field,async t=>{
    const h=await fixture(t),inspect=h.host.inspect,before=await tree(h.root);h.host.inspect=async()=>({...await inspect(),[field]:field==='administrator'?false:field==='bootstrapPermission'?true:'wrong'});
    await assert.rejects(h.w.begin({authorizeLegacy:true}));assert.deepEqual(await tree(h.root),before);
});
test('explicit canonical disarm advances revision and preserves enabled/source',async t=>{
    const h=await fixture(t);await h.prepare();const r=await h.w.load();
    await assert.rejects(h.w.disarm({expectedHash:r.before.auto.hash,expectedRevision:7}),/EXPLICIT_DISARM/);
    const result=await h.disarm(),a=(await artifact(h.p.auto)).value;
    assert.equal(a.armed,false);assert.equal(a.revision,8);assert.equal(a.enabled,true);assert.equal(a.sourceId,'primecast');assert.equal(result.afterRevision,8);
});
for(const field of ['revision','hash'])test('stale disarm '+field+' refuses',async t=>{
    const h=await fixture(t);await h.prepare();const r=await h.w.load(),before=await readFile(h.p.auto);
    await assert.rejects(h.w.disarm({authorize:true,expectedRevision:field==='revision'?6:7,expectedHash:field==='hash'?digest('wrong'):r.before.auto.hash}),/STALE_AUTOLIVE_EVIDENCE/);
    assert.deepEqual(await readFile(h.p.auto),before);
});
test('disarm rechecks file immediately before canonical atomic installation',async t=>{
    const h=await fixture(t);await h.prepare();const a=await artifact(h.p.auto);let calls=0;
    await assert.rejects(offlineDisarm({path:h.p.auto,authorityPath:h.p.authority,audit:h.w.audit+'.race',expectedRevision:7,expectedHash:a.hash,authorize:true,
        reserve:h.host.reserve,proveOffline:async()=>{if(++calls===3)await save(h.p.auto,{...a.value,revision:9});return {absent:true};}}),/PERSISTENCE_FAILED/);
    assert.equal((await artifact(h.p.auto)).value.revision,9);
});
test('marker-only bootstrap blocks without rewriting state',async t=>{
    const h=await fixture(t);await save(h.p.marker,{version:1,authorityEpoch:21});const before=await tree(h.root);
    await assert.rejects(h.w.begin({authorizeLegacy:true}),/MARKER_ONLY/);assert.deepEqual(await tree(h.root),before);
});
test('existing valid ledger never requests bootstrap and retains consumption knowledge',async t=>{
    const h=await fixture(t);await save(h.p.ledger,ledgerSnapshot());await save(h.p.marker,{version:1,authorityEpoch:19});
    assert.equal(bootstrapPlan(await capture(h.p),true),false);
});
test('start authorization and bootstrap remain distinct on validated reservation reuse',async t=>{
    const h=await fixture(t);await h.prepare();await h.disarm();
    await assert.rejects(h.w.reserveStart(),/EXPLICIT_START/);
    await assert.rejects(h.w.reserveStart({authorizeStart:true}),/EXPLICIT_BOOTSTRAP/);
    const start=await h.w.reserveStart({authorizeStart:true,authorizeBootstrap:true});assert.equal(start.bootstrap,true);
    const before=await tree(h.root);
    await assert.rejects(h.w.reserveStart({authorizeBootstrap:true}),/EXPLICIT_START/);
    await assert.rejects(h.w.reserveStart({authorizeStart:true}),/EXPLICIT_BOOTSTRAP/);
    assert.deepEqual(await h.w.reserveStart({authorizeStart:true,authorizeBootstrap:true}),start);
    assert.deepEqual(await tree(h.root),before);
    assert.equal(h.owners.length,0);
});
test('canonical ScheduleStore v2/50 -> v3/51 observation verifies EXCLUDED and FUTURE without eventId special cases',async t=>{
    const h=await fixture(t);const before=(await artifact(h.p.schedule)).value;
    before.events.push({...event,id:'future',startAt:'2099-01-01T00:00:00.000Z',endAt:'2099-01-01T01:00:00.000Z'});await save(h.p.schedule,before);
    const store=new ScheduleStore({path:h.p.schedule});await store.initialize();const after=store.getSnapshot();
    assert.equal(verifyMigration(before,after),true);assert.equal(after.revision,51);
    assert.equal(after.events.find(e=>e.id===event.id).entryMigration.disposition,'EXCLUDED');
    assert.equal(after.events.find(e=>e.id==='future').entryMigration.disposition,'FUTURE');
    const changed=structuredClone(after);changed.events.find(e=>e.id===event.id).entryMigration.disposition='FUTURE';assert.throws(()=>verifyMigration(before,changed));await store.destroy();
});
test('healthz-only state can never satisfy recovery readiness',()=>assert.throws(()=>verifyReadiness({before:{},after:{},runtime:{healthz:200},ports:[{OwningProcess:1}]}),/CURRENT_UNIQUE/));
test('controlled real fixture startup: process-local bootstrap, migration, ledger and retained PROGRAM readiness',async t=>{
    const h=await fixture(t);await h.prepare();await h.disarm();const env=process.env.LIVEZONE_SCHEDULED_ENTRY_BOOTSTRAP;
    const {result,owner}=await controlledStart({workflow:h.w,authorizeStart:true,authorizeBootstrap:true,launch:h.launch});
    assert.equal(result.ready,true);assert.equal(result.epoch,21);assert.equal(result.restartReconciliationRequired,true);
    assert.equal(process.env.LIVEZONE_SCHEDULED_ENTRY_BOOTSTRAP,env);assert.equal(owner.scheduledEntry.ledger.snapshot.generation,0);
    assert.equal((await artifact(h.p.schedule)).value.revision,51);assert.ok(await artifact(h.w.audit+'.ready'));
});
test('restore checks clean shutdown and restores original Automatic/delayed without starting service',async t=>{
    const h=await fixture(t);await h.prepare();await h.disarm();
    const result=await h.w.restore();assert.deepEqual(result,{restored:true,started:false});assert.equal(h.service.StartMode,'Auto');assert.equal(h.service.DelayedValue,1);assert.equal(h.media.State,'Running');
});
for(const key of ['authorityLock','scheduledLock','ledgerLock','gate'])test('restore refuses remaining '+key,async t=>{
    const h=await fixture(t);await h.prepare();await save(h.p[key],{blocking:true});await assert.rejects(h.w.restore());assert.equal(h.counts().restores,0);
});
test('crash after adoption resumes without overwriting original service record',async t=>{
    const h=await fixture(t);h.w.hook=stage=>{if(stage==='adopted')throw Error('crash');};const bytes=await readFile(h.p.maintenance);
    await assert.rejects(h.w.begin({authorizeLegacy:true}),/crash/);h.w.hook=()=>{};await h.w.begin({authorizeLegacy:true});assert.deepEqual(await readFile(h.p.maintenance),bytes);
});
for(const stage of ['prepared','archived'])test('AutoLive partial '+stage+' refuses retry; no fabricated completion',async t=>{
    const h=await fixture(t);await h.w.begin({authorizeLegacy:true});const result=await h.auto();await unlink(result.audit+'.completed');
    if(stage==='prepared')await rename(result.archive,h.p.authorityLock);
    await assert.rejects(h.w.autoPlan(),stage==='prepared'?/AUTOLIVE_PREPARED_REVIEW_REQUIRED/:/AUTOLIVE_ARCHIVAL_REVIEW_REQUIRED/);
});
for(const stage of ['scheduled-prepared','scheduled-archived'])test('Scheduled crash retry: '+stage,async t=>{
    const h=await fixture(t);await h.w.begin({authorizeLegacy:true});await h.auto();h.w.hook=point=>{if(point===stage)throw Error('crash');};
    await assert.rejects(h.w.scheduled(),/crash/);h.w.hook=()=>{};await h.w.scheduled();await h.w.prepared();
});
test('crash after disarm completes audit on retry without second revision increment',async t=>{
    const h=await fixture(t);await h.prepare();h.w.hook=stage=>{if(stage==='disarm-disarmed')throw Error('crash');};await assert.rejects(h.disarm(),/crash/);
    assert.equal((await artifact(h.p.auto)).value.revision,8);h.w.hook=()=>{};await h.disarm();assert.equal((await artifact(h.p.auto)).value.revision,8);
});
for(const phase of ['before-migration','after-migration','marker-only','after-ledger'])test('startup crash state '+phase+' preserves actual state and refuses automatic restart',async t=>{
    const h=await fixture(t);await h.prepare();await h.disarm();await h.w.reserveStart({authorizeStart:true,authorizeBootstrap:true});
    await save(h.p.authority,{epoch:21});
    if(phase!=='before-migration') {const store=new ScheduleStore({path:h.p.schedule});await store.initialize();await store.destroy();}
    if(['marker-only','after-ledger'].includes(phase))await save(h.p.marker,{version:1,authorityEpoch:21});
    if(phase==='after-ledger')await save(h.p.ledger,ledgerSnapshot());
    const before=await tree(h.root);await assert.rejects(h.w.reserveStart({authorizeStart:true,authorizeBootstrap:true}));assert.deepEqual(await tree(h.root),before);
});
test('ledger created before readiness evidence is never erased on verification crash',async t=>{
    const h=await fixture(t);await h.prepare();await h.disarm();h.w.hook=stage=>{if(stage==='before-readiness-evidence')throw Error('crash');};
    await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,authorizeBootstrap:true,launch:h.launch}),/crash/);
    assert.ok(await artifact(h.p.ledger));assert.ok(await artifact(h.p.marker));assert.equal(await artifact(h.w.audit+'.ready'),null);
});
test('canonical census refuses absent or duplicate service records',()=>{
    for(const services of [[],[{State:'Stopped',StartMode:'Disabled'},{State:'Stopped',StartMode:'Disabled'}]])
        assert.equal(evaluateWindowsAuthorityCensus({services,nodes:[]}).absent,false);
});
test('readiness independently rejects every missing recovery invariant',async t=>{
    const h=await fixture(t);await h.prepare();await h.disarm();const {owner}=await controlledStart({workflow:h.w,authorizeStart:true,authorizeBootstrap:true,launch:h.launch});
    const start=(await artifact(h.w.audit+'.start')).value;
    const good={before:start.before,after:await capture(h.p),runtime:runtimeStatus(owner),processes:[{pid:process.pid}],ports:[{OwningProcess:process.pid}],service:h.service,startedAt:start.at,bootstrap:true};
    assert.equal(verifyReadiness(good).ready,true);
    const cases={
        competingAuthority:v=>v.processes.push({pid:999,blocks:true}),
        authorityLock:v=>v.after.authorityLock.value.authorityProcessSession='other',
        authorityEpoch:v=>v.after.authority.value.epoch++,
        scheduledUnavailable:v=>v.runtime.scheduled.status='LOCKED',
        journalConflict:v=>v.after.scheduled={hash:'x',value:{}},
        scheduleUnavailable:v=>v.runtime.schedule.status='UNAVAILABLE',
        ledgerUnavailable:v=>v.runtime.ledger.status='UNAVAILABLE',
        ledgerCorrupt:v=>v.after.ledger.value.checksum.value='wrong',
        ledgerOwner:v=>v.after.ledgerLock.value.processSession='other',
        marker:v=>v.after.marker.value.authorityEpoch--,
        autoliveArmed:v=>v.after.auto.value.armed=true,
        autoliveSource:v=>v.after.auto.value.sourceId='other',
        retainedProgram:v=>v.runtime.program.current=null,
        restartBypass:v=>v.runtime.restartBlocked=false,
        diagnostics:v=>v.runtime.diagnostics=null
    };
    for(const [name,mutate] of Object.entries(cases))await t.test(name,()=>{const value=structuredClone(good);mutate(value);assert.throws(()=>verifyReadiness(value));});
});
test('canonical bootstrap marker creation crash cannot grant a second creation attempt',async t=>{
    const h=await fixture(t);const store=new ScheduleStore({path:h.p.schedule});await store.initialize();
    const args={path:h.p.ledger,ownership:{available:true,authorityEpoch:21},startupSchedule:store.getSnapshot(),executionRepository:{status:'READY',record:null},bootstrap:true};
    const first=await initializeEntryLedger({...args,options:{hook:stage=>{if(stage==='before-replace')throw Error('fixture-crash');}}});
    assert.notEqual(first.status,'READY');await first.close();assert.ok(await artifact(h.p.marker));assert.equal(await artifact(h.p.ledger),null);
    const second=await initializeEntryLedger(args);assert.notEqual(second.status,'READY');await second.close();await store.destroy();
});
test('next controlled startup uses existing ledger without bootstrap permission; restore follows actual shutdown',async t=>{
    const h=await fixture(t);await h.prepare();await h.disarm();const first=await controlledStart({workflow:h.w,authorizeStart:true,authorizeBootstrap:true,launch:h.launch});
    const ledger=await artifact(h.p.ledger),marker=await artifact(h.p.marker);
    await assert.rejects(h.w.restore(),/CANONICAL_OFFLINE/);
    await new Promise(done=>first.owner.server.close(()=>done()));h.setOffline();
    const next=new RecoveryWorkflow({root:h.root,runId:'second-run',host:h.host,expectedHead:HEAD});await next.begin();await next.prepared();
    const run=await next.load();await next.disarm({authorize:true,expectedRevision:run.before.auto.value.revision,expectedHash:run.before.auto.hash});
    let permission;
    const second=await controlledStart({workflow:next,authorizeStart:true,launch:options=>{permission=options.scheduledEntryLedgerBootstrap;return h.launch(options);}});
    assert.equal(permission,false);assert.equal(second.result.epoch,22);
    const migrated=await artifact(h.p.ledger);assert.deepEqual(migrated.value.snapshot,ledger.value);
    assert.equal(migrated.value.schemaVersion,2);assert.equal((await artifact(h.p.marker)).hash,marker.hash);
    await new Promise(done=>second.owner.server.close(()=>done()));h.setOffline();await next.restore();assert.equal(h.service.StartMode,'Auto');
});
test('controlled clean history migration is audited before launch without bootstrap permission',async t=>{
    const h=await fixture(t,{legacy:false});
    const snapshot=ledgerSnapshot({generation:3,entries:[0,1,2].map(n=>entryConsumption(migrationIdentity(n),
        {authorityEpoch:20,authorityProcessSession:'old-history',consumedAt:'2026-10-02T12:01:00.000Z'}))});
    await save(h.p.ledger,snapshot);await save(h.p.marker,{version:1,authorityEpoch:20});
    await h.prepare();assert.equal((await h.w.migration.inspect()).migrationState,'INTENT_DURABLE');
    assert.equal((await artifact(h.p.ledger)).value.schemaVersion,1);await h.disarm();
    await assert.rejects(h.w.reserveStart({authorizeStart:true,authorizeBootstrap:true}),/BOOTSTRAP_FORBIDDEN/);
    const first=await h.w.reserveStart({authorizeStart:true}),retry=await h.w.reserveStart({authorizeStart:true});
    assert.deepEqual(retry,first);assert.equal(first.bootstrap,false);assert.equal(first.ledgerProtocolVersion,2);
    const started=await controlledStart({workflow:h.w,authorizeStart:true,launch:options=>{
        assert.equal(options.scheduledEntryLedgerOptions.protocolVersion,2);
        assert.equal(options.scheduledEntryLedgerBootstrap,false);return h.launch(options);
    }});
    assert.equal(started.result.ready,true);assert.deepEqual(started.owner.scheduledEntry.ledger.snapshot,snapshot);
    assert.equal((await artifact(h.w.audit+'.ready')).value.migrationTransactionId,first.migrationTransactionId);
    await new Promise(done=>started.owner.server.close(()=>done()));h.setOffline();
    const next=new RecoveryWorkflow({root:h.root,runId:'migrated-restart',host:h.host,expectedHead:HEAD});
    const before=await artifact(h.p.migrationCompleted);await next.begin();await next.prepared();
    assert.equal((await artifact(h.p.migrationCompleted)).hash,before.hash);
});
test('Prepare never authorizes the real orphan-v1-lock shape in TEMP',async t=>{
    const h=await fixture(t);await save(h.p.ledger,ledgerSnapshot());await save(h.p.marker,{version:1,authorityEpoch:20});
    await save(h.p.ledgerLock,{version:1,pid:999999,processSession:'orphan-v1'});
    const before=await tree(h.root);const dry=await h.w.inspect();
    assert.equal(dry.blockingReason,'LEGACY_LEDGER_LOCK_UNVERIFIABLE');
    await assert.rejects(h.w.begin({authorizeLegacy:true}),{code:'LEGACY_LEDGER_LOCK_UNVERIFIABLE'});
    assert.deepEqual(await tree(h.root),before);
});
test('operator Prepare and Start resume installed v2 after a migration interruption without rollback',async t=>{
    const h=await fixture(t,{legacy:false});
    const snapshot=ledgerSnapshot({generation:2,entries:[0,1].map(n=>entryConsumption(migrationIdentity(n),
        {authorityEpoch:20,authorityProcessSession:'original-history',consumedAt:'2026-10-02T12:01:00.000Z'}))});
    await save(h.p.ledger,snapshot);await save(h.p.marker,{version:1,authorityEpoch:20});await h.prepare();await h.disarm();
    let trip=true;h.w.hook=stage=>{if(stage==='migration-snapshot-installed'&&trip){trip=false;throw Error('MIGRATION_INTERRUPTED');}};
    await assert.rejects(h.w.reserveStart({authorizeStart:true}),/MIGRATION_INTERRUPTED/);
    assert.equal((await h.w.inspect()).ledgerMode,'V2_PENDING');assert.equal((await artifact(h.p.ledger)).value.schemaVersion,2);
    assert.equal(await artifact(h.w.audit+'.start'),null);await assert.rejects(h.w.restore(),/MIGRATION_COMPLETION_REQUIRED/);
    const prepared=await h.w.begin();assert.equal(prepared.migrationResumable,true);await h.w.prepared();
    const started=await controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch});
    assert.equal(started.result.ready,true);assert.deepEqual(started.owner.scheduledEntry.ledger.snapshot,snapshot);
    await new Promise(done=>started.owner.server.close(()=>done()));h.setOffline();
});
test('controlled startup refuses an unrelated pending media delete recovery',async t=>{
    const h=await fixture(t);await h.prepare();await h.disarm();await mkdir(h.p.mediaRoot,{recursive:true});await save(h.p.mediaDelete,{pending:true});
    await assert.rejects(h.w.reserveStart({authorizeStart:true,authorizeBootstrap:true}),/MEDIA_DELETE_JOURNAL_REVIEW_REQUIRED/);
    assert.equal(await artifact(h.w.audit+'.start'),null);
});
test('disarm retry rejects changed bytes even when the planned after-values match',async t=>{
    const h=await fixture(t);await h.prepare();h.w.hook=stage=>{if(stage==='disarm-disarmed')throw Error('crash');};
    await assert.rejects(h.disarm(),/crash/);h.w.hook=()=>{};
    await save(h.p.auto,(await artifact(h.p.auto)).value); // removes canonical trailing newline
    await assert.rejects(h.disarm(),/STALE_AUTOLIVE_EVIDENCE/);
});


test('approved newer recovery HEAD passes DryRun and Prepare up to the next pre-mutation boundary',async t=>{
    const h=await fixture(t),before=await tree(h.root);
    const result=await h.w.inspect();
    assert.deepEqual(result.expected,{branch:BRANCH,head:HEAD});
    assert.equal(result.evidence.maintenance.value.Head,'44816ca167b1042c8670c169f401ae7e961727ae');
    let reached=false;
    h.host.reserve=async()=>{reached=true;throw Error('FIXTURE_PRE_MUTATION_BOUNDARY');};
    await assert.rejects(h.w.begin({authorizeLegacy:true}),/FIXTURE_PRE_MUTATION_BOUNDARY/);
    assert.equal(reached,true);assert.deepEqual(await tree(h.root),before);
    assert.equal(await artifact(h.w.audit),null);
});
for(const field of ['branch','head','root'])test('DryRun and Prepare share repository rejection without mutations: '+field,async t=>{
    const h=await fixture(t),inspect=h.host.inspect,before=await tree(h.root);
    h.host.inspect=async()=>({...await inspect(),[field]:field==='head'?'06a0962e481c2f35a8c00b53a674a445383acb22':'wrong'});
    await assert.rejects(h.w.inspect(),/REPOSITORY_BRANCH_HEAD_MISMATCH/);
    await assert.rejects(h.w.begin({authorizeLegacy:true}),/REPOSITORY_BRANCH_HEAD_MISMATCH/);
    assert.deepEqual(await tree(h.root),before);assert.deepEqual(h.counts(),{reserves:0,restores:0});
});
test('maintenance repository mismatch blocks both paths before mutation',async t=>{
    const h=await fixture(t),r=(await artifact(h.p.maintenance)).value;
    await save(h.p.maintenance,{...r,Repository:join(h.root,'other')});const before=await tree(h.root);
    await assert.rejects(h.w.inspect(),/MAINTENANCE_CONFLICT/);
    await assert.rejects(h.w.begin({authorizeLegacy:true}),/MAINTENANCE_CONFLICT/);
    assert.deepEqual(await tree(h.root),before);assert.deepEqual(h.counts(),{reserves:0,restores:0});
});
test('expected recovery HEAD is mandatory, full length and explicitly normalized',async t=>{
    const h=await fixture(t);
    for(const expectedHead of [undefined,'','HEAD',HEAD.slice(0,7),' '+HEAD, 'g'.repeat(40)])
        assert.throws(()=>new RecoveryWorkflow({root:h.root,host:h.host,expectedHead}),/EXPLICIT_RECOVERY_HEAD_REQUIRED/);
    const w=new RecoveryWorkflow({root:h.root,host:h.host,expectedHead:HEAD.toUpperCase()});
    assert.equal((await w.inspect()).expected.head,HEAD);
});
test('audit recovery HEAD cannot be reused under a different approved version',async t=>{
    const h=await fixture(t);await h.w.begin({authorizeLegacy:true});
    const other=new RecoveryWorkflow({root:h.root,host:h.host,runId:h.w.runId,expectedHead:'f'.repeat(40)});
    await assert.rejects(other.load(),/RECOVERY_AUDIT_REQUIRED/);
    assert.equal((await h.w.load()).head,HEAD);
});

for(const status of ['VERIFIED','UNVERIFIED'])test('DryRun and Prepare share media identity: '+status,async t=>{
    const h=await fixture(t),before=await tree(h.root);h.media.status=status;
    const dry=await h.w.inspect();assert.equal(dry.host.media.status,status);
    if(status==='UNVERIFIED'){
        await assert.rejects(h.w.begin({authorizeLegacy:true}),/MEDIAMTX_IDENTITY_REQUIRED/);
        assert.deepEqual(h.counts(),{reserves:0,restores:0});
    }else{
        h.host.reserve=async()=>{throw Error('FIXTURE_PRE_MUTATION_BOUNDARY');};
        const pre=await h.w.preflight();assert.deepEqual(pre.media,dry.host.media);
        await assert.rejects(h.w.begin({authorizeLegacy:true}),/FIXTURE_PRE_MUTATION_BOUNDARY/);
    }
    assert.deepEqual(await tree(h.root),before);
});

for(const content of ['empty','crawl','sponsor'])test('R14 controlled empty-live v2 reaches READY without schedule mutation: '+content,async t=>{
    const h=await fixture(t);
    const events=content==='empty'?[]:[{...event,id:'overlay',type:'overlay.'+content,
        payload:content==='crawl'?{text:'News',position:'bottom',direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true}:
            {assetId:'logo',layout:'CORNER',position:'top-left',sizePercent:10,opacity:1}}];
    await save(h.p.schedule,{version:2,revision:50,events,programPlan:{version:1,timezone:'Europe/Rome',items:[]}});
    const bytes=await readFile(h.p.schedule);
    await h.prepare();await h.disarm();
    const {result,owner}=await controlledStart({workflow:h.w,authorizeStart:true,authorizeBootstrap:true,launch:h.launch});
    assert.equal(result.ready,true);assert.ok(await artifact(h.w.audit+'.ready'));
    assert.deepEqual(await readFile(h.p.schedule),bytes);
    assert.equal(owner.scheduler.store.getSnapshot().version,2);
});

test('R14 exact R11-BIS empty-live v2 with clean ledger v1 migration reaches READY',async t=>{
    const h=await fixture(t,{legacy:false});
    await save(h.p.schedule,{version:2,revision:50,events:[],programPlan:{version:1,timezone:'Europe/Rome',items:[]}});
    await save(h.p.ledger,ledgerSnapshot());await save(h.p.marker,{version:1,authorityEpoch:20});
    const bytes=await readFile(h.p.schedule);
    await h.prepare();await h.disarm();
    let started;
    try{started=await controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch});}
    catch(error){
        assert.equal(h.owners.length,1,'the RED probe reached runtime launch');
        assert.equal(await artifact(h.w.audit+'.ready'),null,'failed readiness must not persist READY');
        throw error;
    }
    const {result,owner}=started;
    assert.equal(result.ready,true);assert.ok(await artifact(h.w.audit+'.ready'));
    assert.equal((await artifact(h.p.ledger)).value.schemaVersion,2);
    assert.deepEqual(await readFile(h.p.schedule),bytes);
    await new Promise(done=>owner.server.close(()=>done()));h.setOffline();
    assert.deepEqual(await h.w.restore(),{restored:true,started:false});
    assert.deepEqual(await readFile(h.p.schedule),bytes);
});
