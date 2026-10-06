import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {recoveryIntegrityFixture,save} from '../test-support/RecoveryIntegrityFixture.mjs';
import {artifact,capture} from '../server/recovery/RecoveryContract.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {createProgramOutputServer} from '../server/program-output-server.js';
import {createInitializedState} from '../server/studio/AuthoritativeStateContract.js';
import {phaseChain} from '../server/recovery/RecoveryLineage.js';
import {envelope,seal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {repositoryIdentity} from '../server/scheduler/ScheduledExecutionProvenance.js';

const windows={skip:process.platform!=='win32',timeout:180000};
async function fixture(t,{native=true}={}){
    const owners=[];
    t.after(async()=>{for(const owner of owners)await new Promise(done=>owner.server.close(()=>done()));});
    const h=await recoveryIntegrityFixture(t);
    if(native){
        // Seed genuine native v2 directly, with file and NTFS namespace
        // barriers, rather than creating/deleting migration artifacts.
        await save(h.p.ledger,envelope(h.p.ledger,h.snapshot));
        await writeFile(h.p.ledgerWal,JSON.stringify(seal({schemaVersion:2,type:'BASE',previous:null,
            data:{repositoryId:repositoryIdentity(h.p.ledger),snapshot:h.snapshot,namespaceDurability:'DIRECTORY_SYNCED'}}))+'\n');
        for(const key of ['ledger','ledgerWal','marker','authority'])await h.migration.durability.syncFile(h.p[key]);
    }
    await save(h.p.studio,createInitializedState({sources:[],scenes:[],scheduler:{version:1,timezone:'Europe/Rome',items:[],enabled:false},
        globalOverlays:{textCrawl:null},dominantLive:{armed:false,authorizedSourceId:null}},{stateId:'r15',updatedAt:new Date().toISOString()}));
    let online=false,launches=0;const inspect=h.host.inspect;
    h.host.inspect=async()=>({...await inspect(),proof:{absent:!online,processes:[{pid:process.pid,kind:'MAINTENANCE_SELF'}]},ports:online?[{OwningProcess:process.pid,LocalPort:8080}]:[]});
    h.host.proveOffline=async()=>({absent:!online});
    h.launch=options=>{launches++;online=true;const owner=createProgramOutputServer({...options,publisherToken:'r15-temp-only-publisher-token',scheduledEntryLogger:()=>{},
        scheduleSetTimer:()=>1,scheduleClearTimer:()=>{},mediaAssetRepository:{initialize:async()=>{},list:()=>[],get:()=>null}});owners.push(owner);return owner;};
    h.launches=()=>launches;h.offline=()=>{online=false;};
    h.stop=async()=>{for(const owner of owners)await new Promise(done=>owner.server.close(()=>done()));online=false;};
    await h.w.begin();await h.w.prepared();const audit=await h.w.load();
    await h.w.disarm({authorize:true,expectedRevision:audit.before.auto.value.revision,expectedHash:audit.before.auto.hash});
    return h;
}
async function tree(root){
    const result={};async function walk(dir){for(const name of await readdir(dir)){const path=join(dir,name),s=await stat(path);
        if(s.isDirectory())await walk(path);else result[relative(root,path)]={bytes:(await readFile(path)).toString('base64'),mtime:s.mtimeMs};}}
    await walk(root);return result;
}
test('R15 exact native v2 blocker: durable reservation interruption retries once through READY',windows,async t=>{
    const h=await fixture(t);const before=await capture(h.p),walBefore=await readFile(h.p.ledgerWal,'utf8');
    h.w.hook=stage=>{if(stage==='start-reserved')throw Error('RESERVATION_INTERRUPTED');};
    await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch}),/RESERVATION_INTERRUPTED/);
    assert.equal(h.launches(),0);const saved=await artifact(h.w.audit+'.start'),bytes=await readFile(h.w.audit+'.start');
    assert.equal(saved.value.state,'START_RESERVED');assert.deepEqual(await capture(h.p),before);
    h.w.hook=()=>{};
    for(let n=0;n<3;n++)assert.deepEqual(await h.w.reserveStart({authorizeStart:true}),saved.value);
    assert.deepEqual(await capture(h.p),before);assert.equal(h.launches(),0);
    const started=await controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch});
    assert.equal(started.result.ready,true);assert.equal(h.launches(),1);
    assert.deepEqual(await readFile(h.w.audit+'.start'),bytes);
    const after=await capture(h.p);assert.equal(after.ledger.hash,before.ledger.hash);assert.equal(after.marker.hash,before.marker.hash);
    assert.equal(after.ledger.value.snapshot.ledgerId,before.ledger.value.snapshot.ledgerId);
    assert.ok((await readFile(h.p.ledgerWal,'utf8')).startsWith(walBefore));
    assert.equal(after.migrationIntent,null);const ready=await phaseChain(h.w,'ready');
    assert.equal(ready.records.ready.value.lineage.predecessorHash,saved.hash);
    await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch}));assert.equal(h.launches(),1);
    await new Promise(done=>started.owner.server.close(()=>done()));h.offline();
    const closed=await tree(h.root);
    const repeated=await controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch});
    assert.equal(repeated.result.ready,true);assert.equal(repeated.owner,null);assert.equal(h.launches(),1);assert.deepEqual(await tree(h.root),closed);
    await writeFile(h.p.schedule,Buffer.concat([await readFile(h.p.schedule),Buffer.from(' ')]));const stale=await tree(h.root);
    await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch}));assert.equal(h.launches(),1);assert.deepEqual(await tree(h.root),stale);
});

const mutations={
    foreignRun:s=>{s.lineage.runId='foreign';},foreignHead:s=>{s.lineage.head='f'.repeat(40);},foreignRoot:s=>{s.lineage.root+='-foreign';},
    wrongPredecessor:s=>{s.lineage.predecessorHash='a'.repeat(64);},foreignAudit:s=>{s.lineage.auditHash='b'.repeat(64);},
    wrongBootstrap:s=>{s.bootstrap=true;},wrongMigration:s=>{s.migrationTransactionId='foreign';},wrongState:s=>{s.state='READY';}
};
for(const [name,mutate] of Object.entries(mutations))test('R15 rejects reservation '+name+' without mutation',windows,async t=>{
    const h=await fixture(t);await h.w.reserveStart({authorizeStart:true});const s=(await artifact(h.w.audit+'.start')).value;
    mutate(s);await save(h.w.audit+'.start',s);const before=await tree(h.root);
    await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch}));assert.equal(h.launches(),0);assert.deepEqual(await tree(h.root),before);
});
for(const bytes of ['{','{"version":1','null'])test('R15 malformed/truncated reservation '+bytes,windows,async t=>{
    const h=await fixture(t);await h.w.reserveStart({authorizeStart:true});await writeFile(h.w.audit+'.start',bytes);const before=await tree(h.root);
    await assert.rejects(h.w.reserveStart({authorizeStart:true}));assert.deepEqual(await tree(h.root),before);
});
for(const key of ['ledger','ledgerWal','schedule','auto','program','authority','marker','mediaManifest'])test('R15 stale current evidence '+key,windows,async t=>{
    const h=await fixture(t);await h.w.reserveStart({authorizeStart:true});
    if(key==='mediaManifest')await save(h.p[key],{changed:true});else await writeFile(h.p[key],Buffer.concat([await readFile(h.p[key]),Buffer.from(' ')]));
    const before=await tree(h.root);await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch}));
    assert.equal(h.launches(),0);assert.deepEqual(await tree(h.root),before);
});
test('R15 rejects conflicting READY before migration or runtime',windows,async t=>{
    const h=await fixture(t);await h.w.reserveStart({authorizeStart:true});await save(h.w.audit+'.ready',{ready:true,lineage:{runId:'foreign'}});
    const before=await tree(h.root);await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch}));assert.equal(h.launches(),0);assert.deepEqual(await tree(h.root),before);
});
test('R15 stale maintenance gate is never licensed by a valid reservation',windows,async t=>{
    const h=await fixture(t);await h.w.reserveStart({authorizeStart:true});await save(h.p.gate,{pid:999999});const before=await tree(h.root);
    await assert.rejects(h.w.reserveStart({authorizeStart:true}),{code:'MAINTENANCE_GATE_REVIEW_REQUIRED'});assert.deepEqual(await tree(h.root),before);
});
test('R15 migration-completed reservation is immutable across repeated retries',windows,async t=>{
    const h=await fixture(t,{native:false});const start=await h.w.reserveStart({authorizeStart:true}),before=await tree(h.root);
    assert.equal(start.ledgerProtocolVersion,2);assert.ok(start.migrationTransactionId);
    for(let n=0;n<3;n++)assert.deepEqual(await h.w.reserveStart({authorizeStart:true}),start);
    assert.deepEqual(await tree(h.root),before);
    const {result}=await controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch});assert.equal(result.ready,true);assert.equal(h.launches(),1);
});
test('R15 runtime launched before READY requires reconciliation and never launches twice',windows,async t=>{
    const h=await fixture(t);h.w.hook=stage=>{if(stage==='before-readiness-evidence')throw Error('BEFORE_READY_INTERRUPTED');};
    await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch}),/BEFORE_READY_INTERRUPTED/);
    assert.equal(h.launches(),1);assert.equal(await artifact(h.w.audit+'.ready'),null);h.w.hook=()=>{};
    const before=await tree(h.root);await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch}));assert.equal(h.launches(),1);assert.deepEqual(await tree(h.root),before);
    await h.stop();const closed=await tree(h.root);
    await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch}));assert.equal(h.launches(),1);assert.deepEqual(await tree(h.root),closed);
});
test('R15 copied reservation from a separate recovery is rejected read-only',windows,async t=>{
    const h=await fixture(t),other=await fixture(t);await h.w.reserveStart({authorizeStart:true});await other.w.reserveStart({authorizeStart:true});
    await writeFile(h.w.audit+'.start',await readFile(other.w.audit+'.start'));const before=await tree(h.root);
    await assert.rejects(h.w.reserveStart({authorizeStart:true}));assert.deepEqual(await tree(h.root),before);
});
test('R15 current Schedule is rechecked immediately before launch',windows,async t=>{
    const h=await fixture(t);await h.w.reserveStart({authorizeStart:true});
    h.w.hook=async stage=>{if(stage==='before-controlled-launch')await writeFile(h.p.schedule,Buffer.concat([await readFile(h.p.schedule),Buffer.from(' ')]));};
    await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,launch:h.launch}),{code:'START_EVIDENCE_CHANGED'});assert.equal(h.launches(),0);
});
