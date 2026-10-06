import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,unlink,readdir,stat,writeFile,link} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join,relative} from 'node:path';
import {recoveryIntegrityFixture,completedIntegrityFixture,save} from '../test-support/RecoveryIntegrityFixture.mjs';
import {artifact,capture} from '../server/recovery/RecoveryContract.js';
import {hash,envelope,seal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {ledgerSnapshot,entryConsumption} from '../server/scheduler/ScheduledEntryLedgerContract.js';
import {identity} from '../test-support/CleanLedgerMigrationFixture.mjs';
import Repository from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
const windows={skip:process.platform!=='win32',timeout:180000};
test('R9 regression: maintenance conflict refuses Prepare before durable migration intent',windows,async t=>{
    const h=await recoveryIntegrityFixture(t),record=JSON.parse(await readFile(h.p.maintenance));record.Repository=h.root+'-other';await save(h.p.maintenance,record);
    await assert.rejects(h.w.begin(),{code:'MAINTENANCE_CONFLICT'});
    await assert.rejects(readFile(h.p.migrationIntent),{code:'ENOENT'});
    await assert.rejects(readFile(h.p.ledgerWal),{code:'ENOENT'});
});
test('R9 regression: lost authoritative state refuses full Restore before any service mutation',windows,async t=>{
    const h=await completedIntegrityFixture(t);
    for(const path of [h.p.ledger,h.p.ledgerWal,h.p.marker])await unlink(path);
    await assert.rejects(h.w.restore());assert.equal(h.restoreCalls(),0);assert.equal(h.service.StartMode,'Disabled');
});
async function inventory(root){const result=[];async function visit(dir){for(const name of await readdir(dir)){const p=join(dir,name),s=await stat(p);if(s.isDirectory())await visit(p);else result.push([relative(root,p),hash(await readFile(p)),s.mtimeMs]);}}await visit(root);return result.sort();}
for(const kind of ['HEAD','service','process','MediaMTX','native','helper-trust','ledger','audit','audit-authorization','schedule','authority','program','media-delete','gate','orphan-v1','prepared-without-audit','prepared-audit-conflict','begin-prepared-audit-conflict','start-audit-conflict','ready-audit-conflict','restore-state','disarm-audit-conflict'])test('Prepare static rejection has zero mutation: '+kind,windows,async t=>{
    const h=await recoveryIntegrityFixture(t),inspect=h.host.inspect;
    if(['HEAD','service','process','MediaMTX'].includes(kind))h.host.inspect=async()=>{const v=await inspect();if(kind==='HEAD')v.head='0'.repeat(40);if(kind==='service')v.service.PathName='';if(kind==='process')v.proof.absent=false;if(kind==='MediaMTX')v.media.status='UNVERIFIED';return v;};
    if(['native','helper-trust'].includes(kind))h.w.migration.native={capability(){throw Object.assign(Error('unproven'),{code:'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'});}};
    if(kind==='ledger')await writeFile(h.p.ledger,'corrupt');
    if(kind==='audit')await save(h.w.audit,{version:1,root:h.root,head:'0'.repeat(40),runId:h.w.runId});
    if(kind==='audit-authorization'){await h.seedAudit();const a=(await artifact(h.w.audit)).value;a.authorizeLegacy=true;await save(h.w.audit,a);}
    if(kind==='schedule')await save(h.p.schedule,{invalid:true});
    if(kind==='authority')await save(h.p.authority,{epoch:0});
    if(kind==='program')await save(h.p.program,{invalid:true});
    if(kind==='media-delete')await save(h.p.mediaDelete,{pending:true});
    if(kind==='gate')await save(h.p.gate,{pid:999});
    if(kind==='orphan-v1')await save(h.p.ledgerLock,{version:1,pid:999,processSession:'real-state-shape'});
    if(kind==='prepared-audit-conflict'){await h.seedAudit();await save(h.w.audit+'.prepared',{state:'OTHER'});}
    if(kind==='begin-prepared-audit-conflict'){await h.seedAudit();await save(h.w.audit+'.prepared',{state:'OTHER'});}
    if(kind==='start-audit-conflict'){await h.seedAudit();await save(h.w.audit+'.start',{state:'OTHER'});}
    if(kind==='ready-audit-conflict'){await h.seedAudit();await save(h.w.audit+'.ready',{ready:true,head:'0'.repeat(40)});}
    if(kind==='restore-state'){await h.seedAudit();await save(h.w.audit+'.restore-prepared',{state:'PREPARED'});}
    if(kind==='disarm-audit-conflict'){await h.seedAudit();await save(h.w.audit+'.disarm',{state:'OTHER'});}
    const before=await inventory(h.root);
    await assert.rejects(kind.startsWith('prepared-')?h.w.prepared():h.w.begin());
    assert.deepEqual(await inventory(h.root),before);await assert.rejects(readFile(h.p.migrationIntent),{code:'ENOENT'});
});
test('Prepare evidence changed at exclusive recheck refuses before gate, audit or intent',windows,async t=>{
    const h=await recoveryIntegrityFixture(t);h.w.hook=async stage=>{if(stage==='before-mutation-recheck'){const a=(await artifact(h.p.auto)).value;a.revision++;await save(h.p.auto,a);}};
    await assert.rejects(h.w.begin(),{code:'PREFLIGHT_EVIDENCE_CHANGED'});
    for(const p of [h.p.gate,h.w.audit,h.p.migrationIntent,h.p.ledgerWal])await assert.rejects(readFile(p),{code:'ENOENT'});
});
test('Prepare rechecks again after audit barriers and refuses changed evidence before intent',windows,async t=>{
    const h=await recoveryIntegrityFixture(t);h.w.hook=async stage=>{if(stage==='before-migration-recheck'){const a=(await artifact(h.p.auto)).value;a.revision++;await save(h.p.auto,a);}};
    await assert.rejects(h.w.begin());
    for(const p of [h.p.gate,h.p.migrationIntent,h.p.ledgerWal,h.w.audit+'.prepared'])await assert.rejects(readFile(p),{code:'ENOENT'});
    assert.ok(await artifact(h.w.audit)); // Original evidence, never PREPARED/completed.
});
for(const kind of ['missing-ledger','corrupt-ledger','wrong-ledgerId','rollback','invalid-WAL','invalid-UTF8','missing-WAL','missing-marker','changed-marker','pending','repository','storage','hardlink','orphan-lock','ready-identity','start-identity','audit-history','fork'])test('Restore authoritative-state rejection has zero service mutation: '+kind,windows,async t=>{
    const h=await completedIntegrityFixture(t);
    if(kind==='missing-ledger')await unlink(h.p.ledger);
    if(kind==='corrupt-ledger')await writeFile(h.p.ledger,'corrupt');
    if(kind==='wrong-ledgerId')await save(h.p.ledger,envelope(h.p.ledger,ledgerSnapshot({generation:3,entries:h.snapshot.entries})));
    if(kind==='rollback')await save(h.p.ledger,envelope(h.p.ledger,ledgerSnapshot({ledgerId:h.snapshot.ledgerId})));
    if(kind==='invalid-WAL'){const rows=(await readFile(h.p.ledgerWal,'utf8')).trim().split('\n').map(JSON.parse);rows.at(-1).previous='0'.repeat(64);await writeFile(h.p.ledgerWal,rows.map(JSON.stringify).join('\n')+'\n');}
    if(kind==='invalid-UTF8')await writeFile(h.p.ledgerWal,Buffer.concat([await readFile(h.p.ledgerWal),Buffer.from([255])]));
    if(kind==='missing-WAL')await unlink(h.p.ledgerWal);
    if(kind==='missing-marker')await unlink(h.p.marker);
    if(kind==='changed-marker')await save(h.p.marker,{version:1,authorityEpoch:19});
    if(kind==='pending'){
        const rows=(await readFile(h.p.ledgerWal,'utf8')).trim().split('\n').map(JSON.parse);rows.pop();
        const owner=rows.at(-1).data,next=ledgerSnapshot({ledgerId:h.snapshot.ledgerId,generation:4,entries:[...h.snapshot.entries,entryConsumption(identity(30),{authorityEpoch:21,authorityProcessSession:owner.authorityProcessSession,consumedAt:'2026-10-02T12:03:00.000Z'})]});
        rows.push(seal({schemaVersion:2,type:'INTENT',previous:rows.at(-1).checksum,data:{transactionId:randomUUID(),entryKey:identity(30).entryKey,owner,previousGeneration:3,previousHash:hash(h.snapshot),nextGeneration:4,nextHash:hash(next),next,createdAt:'2026-10-02T12:03:00.000Z'}}));
        await writeFile(h.p.ledgerWal,rows.map(JSON.stringify).join('\n')+'\n');
    }
    if(kind==='repository'){const value=(await artifact(h.p.ledger)).value;const {checksum,...payload}=value;payload.repositoryId='0'.repeat(64);await save(h.p.ledger,seal(payload));}
    if(kind==='storage'){const storage=h.w.migration.storage.bind(h.w.migration);h.w.migration.storage=async()=>{const v=await storage();return {...v,capability:{...v.capability,volumeSerial:v.capability.volumeSerial^1}};};}
    if(kind==='hardlink')await link(h.p.ledger,h.p.ledger+'.other-link');
    if(kind==='orphan-lock')await save(h.p.ledgerLock,{schemaVersion:2,pid:999});
    if(kind==='ready-identity'){const ready=(await artifact(h.w.audit+'.ready')).value;ready.recoveryRunId='other';await save(h.w.audit+'.ready',ready);}
    if(kind==='start-identity'){const start=(await artifact(h.w.audit+'.start')).value;start.before.marker.hash='0'.repeat(64);await save(h.w.audit+'.start',start);}
    if(kind==='audit-history'){const audit=(await artifact(h.w.audit)).value;audit.before.ledger.value=envelope(h.p.ledger,ledgerSnapshot({generation:3,entries:h.snapshot.entries}));await save(h.w.audit,audit);}
    if(kind==='fork'){const rows=(await readFile(h.p.ledgerWal,'utf8')).trim().split('\n').map(JSON.parse);rows[1].data.processSession='11111111-1111-1111-1111-111111111111';rows[2].data.processSession=rows[1].data.processSession;const updated=[];for(const row of rows){const {checksum,...payload}=row;payload.previous=updated.at(-1)?.checksum??null;updated.push(seal(payload));}await writeFile(h.p.ledgerWal,updated.map(JSON.stringify).join('\n')+'\n');}
    const before=await inventory(h.root);await assert.rejects(h.w.restore());assert.equal(h.restoreCalls(),0);assert.equal(h.service.StartMode,'Disabled');assert.equal(h.service.DelayedValue,1);assert.deepEqual(await inventory(h.root),before);
});
test('Restore accepts later consumed generation proved by retained READY WAL prefix, and repeats without SCM',windows,async t=>{
    const h=await completedIntegrityFixture(t),repo=new Repository({path:h.p.ledger,authority:{authorityEpoch:21,authorityProcessSession:'r10-later'}});
    await repo.initialize();assert.equal(repo.status,'READY',repo.error);
    assert.equal((await repo.consume(identity(30),{authorityEpoch:21,authorityProcessSession:'r10-later',consumedAt:'2026-10-02T12:03:00.000Z'})).status,'CONSUMED');await repo.close();
    assert.equal((await artifact(h.p.ledger)).value.snapshot.generation,4);
    assert.deepEqual(await h.w.restore(),{restored:true,started:false});assert.equal(h.restoreCalls(),1);assert.equal(h.service.StartMode,'Auto');
    const before=await inventory(h.root);await h.w.restore();assert.equal(h.restoreCalls(),1);assert.deepEqual(await inventory(h.root),before);
    const inspect=h.host.inspect;
    h.host.inspect=async()=>({...await inspect(),proof:{absent:false,services:[{State:'Stopped',StartMode:'Auto'}],processes:[{pid:process.pid,kind:'MAINTENANCE_SELF'}]}});
    h.host.proveOffline=async()=>({absent:false,services:[{State:'Stopped',StartMode:'Auto'}],processes:[{pid:process.pid,kind:'MAINTENANCE_SELF'}]});
    await h.w.restore();assert.equal(h.restoreCalls(),1);
    h.host.proveOffline=async()=>({absent:false,services:[{State:'Stopped',StartMode:'Auto'}],processes:[{pid:999,kind:'LIVEZONE_AUTHORITY',blocks:true}]});
    await assert.rejects(h.w.restore());assert.equal(h.restoreCalls(),1);
});
test('Restore rechecks immediately before SCM and refuses changed authoritative bytes',windows,async t=>{
    const h=await completedIntegrityFixture(t);h.w.hook=async stage=>{if(stage==='before-service-restore')await writeFile(h.p.ledgerWal,'corrupt');};
    await assert.rejects(h.w.restore());assert.equal(h.restoreCalls(),0);assert.equal(h.service.StartMode,'Disabled');await assert.rejects(readFile(h.w.audit+'.restore-completed'),{code:'ENOENT'});
});

test('R14 Restore rejects legacy LIVE after READY with zero service mutation',windows,async t=>{
    const h=await completedIntegrityFixture(t);
    const stamp='2026-10-02T00:00:00.000Z';
    await save(h.p.schedule,{version:2,revision:2,programPlan:{version:1,timezone:'Europe/Rome',items:[]},events:[{
        id:'legacy-live',version:1,type:'source.live',enabled:false,startAt:stamp,endAt:'2026-10-02T01:00:00.000Z',priority:0,
        payload:{sourceId:'camera',precheckSeconds:0,unavailableAction:'KEEP_PROGRAM',unavailableSceneId:null,endAction:'RETURN',endSceneId:null},createdAt:stamp,updatedAt:stamp}]});
    await assert.rejects(h.w.restore(),{code:'SCHEDULE_V3_REQUIRED'});assert.equal(h.restoreCalls(),0);
});
