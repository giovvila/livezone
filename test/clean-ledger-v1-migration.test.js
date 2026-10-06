import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,unlink,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {seedMigration,migrationFixture,identity} from '../test-support/CleanLedgerMigrationFixture.mjs';
import {migrationPath,assertMigrationStartup} from '../server/recovery/CleanLedgerV1Migration.js';
import {hash,inspectV2,seal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {ledgerSnapshot} from '../server/scheduler/ScheduledEntryLedgerContract.js';
import Repository from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import Legacy from '../server/scheduler/ScheduledEntryLedgerRepository.js';
import {initializeEntryLedger} from '../server/scheduler/ScheduledEntryRuntime.js';
const windows={skip:process.platform!=='win32',timeout:180000};
async function fixture(t,options={}) {
    const root=await mkdtemp(join(tmpdir(),'lz-r8-migration-'));
    t.after(async()=>{const rel=relative(resolve(tmpdir()),resolve(root));assert.ok(rel.startsWith('lz-r8-migration-')&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});});
    return {root,...await seedMigration(root,options)};
}
async function inventory(root){return Promise.all((await readdir(root)).sort().map(async n=>{const p=join(root,n),s=await stat(p);return [n,hash(await readFile(p)),s.mtimeMs];}));}
for(const entries of [0,3])test('clean v1 preserves exact history and generation; DryRun/Prepare/Start are idempotent: '+entries,windows,async t=>{
    const {root,migration:m,snapshot}=await fixture(t,{entries});const before=await inventory(root);
    for(let n=0;n<2;n++){const d=await m.inspect();assert.equal(d.ledgerMode,'V1');assert.equal(d.migrationRequired,true);assert.equal(d.blockingReason,null);}
    assert.deepEqual(await inventory(root),before);
    const original=await readFile(m.path,'utf8');assert.equal((await m.prepare()).migrationState,'INTENT_DURABLE');
    assert.equal(await readFile(m.path,'utf8'),original);await m.prepare();
    const legacy=new Legacy({path:m.path});await legacy.initialize();assert.notEqual(legacy.status,'READY');await legacy.close();
    assert.equal((await m.start()).migrationState,'COMPLETED');const after=await inventory(root);
    await m.prepare();await m.start();assert.deepEqual(await inventory(root),after);
    const state=await inspectV2(m.path);assert.deepEqual(state.current,snapshot);assert.equal(state.records.length,1);
    const repo=new Repository({path:m.path,authority:{authorityEpoch:21,authorityProcessSession:'new-authority'}});await repo.initialize();assert.equal(repo.status,'READY',repo.error);
    for(let n=0;n<entries;n++){assert.equal((await repo.inspect(identity(n))).status,'ALREADY_CONSUMED');assert.equal((await repo.consume(identity(n),{authorityEpoch:21,authorityProcessSession:'new-authority',consumedAt:'2026-10-02T12:02:00.000Z'})).status,'ALREADY_CONSUMED');}
    assert.deepEqual(repo.snapshot,snapshot);await repo.close();assert.equal(await assertMigrationStartup(m.path),true);
    assert.equal((await m.inspect()).migrationRequired,false);
});
export const crashPoints=['before-intent','intent-opened','intent-partial','intent-flushed','intent-installed','after-intent',
    'base-opened','base-partial','base-flushed','base-installed','snapshot-opened','snapshot-partial','snapshot-flushed',
    'snapshot-staged','snapshot-installing','snapshot-installed','snapshot-durable','before-activation','activation-opened','activation-partial',
    'activation-installed','after-activation','completion-opened','completion-partial','completion-installed','after-completion'];
for(const point of crashPoints)test('native migration abrupt loss: '+point,windows,async t=>{
    const {root,migration:m,snapshot}=await fixture(t);
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../test-support/LedgerMigrationCrashChild.mjs',import.meta.url)),root,point],{windowsHide:true,encoding:'utf8',timeout:90000});
    assert.equal(result.status,77,result.stdout+result.stderr);
    const state=await m.inspect();assert.equal(state.blockingReason,null);t.diagnostic(JSON.stringify({point,state,artifacts:await readdir(root)}));
    const runtime=await initializeEntryLedger({path:m.path,ownership:{available:true,authorityEpoch:21,authorityProcessSession:'startup'},startupSchedule:{events:[]},executionRepository:{status:'READY'},options:{protocolVersion:2}});
    if(point==='completion-installed'||point==='after-completion')assert.equal(runtime.status,'READY',runtime.error);
    else assert.notEqual(runtime.status,'READY');await runtime.close();
    assert.equal((await m.start()).blockingReason,null);assert.deepEqual((await inspectV2(m.path)).current,snapshot);
    await m.start();assert.equal(await assertMigrationStartup(m.path),true);
});
for(const kind of ['legacy-lock','corrupt-v1','checksum','missing-marker','marker-mismatch','wal','foreign-stage','service','port','process','capability','trust'])test('refusal before mutation: '+kind,windows,async t=>{
    const {root,migration:m}=await fixture(t);
    if(kind==='legacy-lock')await writeFile(m.path+'.lock',JSON.stringify({version:1,pid:99999,processSession:'real-state-shape'}));
    if(kind==='corrupt-v1')await writeFile(m.path,'{broken');
    if(kind==='checksum'){const s=JSON.parse(await readFile(m.path));s.checksum.value='0'.repeat(64);await writeFile(m.path,JSON.stringify(s));}
    if(kind==='missing-marker')await unlink(m.path+'.bootstrap');
    if(kind==='marker-mismatch')await writeFile(m.path+'.bootstrap',JSON.stringify({version:1,authorityEpoch:21}));
    if(kind==='wal')await writeFile(m.path+'.wal','bad');
    if(kind==='foreign-stage')await writeFile(m.path+'.unrecognized.stage','bad');
    if(['service','port','process'].includes(kind)){const inspect=m.host.inspect;m.host.inspect=async()=>{const h=await inspect();if(kind==='service')h.service.State='Running';if(kind==='port')h.ports=[{LocalPort:8080}];if(kind==='process')h.proof.absent=false;return h;};}
    if(['capability','trust'].includes(kind))m.native={capability:()=>{throw Object.assign(Error('LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'),{code:'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'});}};
    const before=await inventory(root);const dry=await m.inspect();assert.ok(dry.blockingReason);
    await assert.rejects(m.prepare());await assert.rejects(m.start());assert.deepEqual(await inventory(root),before);
    if(kind==='legacy-lock')assert.equal(dry.blockingReason,'LEGACY_LEDGER_LOCK_UNVERIFIABLE');
});
for(const kind of ['intent','intent-stage','base','snapshot-stage','changed-v1','changed-authority','changed-marker','helper-midway'])test('preserve and refuse uncertain migration: '+kind,windows,async t=>{
    const {root,migration:m}=await fixture(t);
    if(kind==='helper-midway'){
        m.hook=stage=>{if(stage==='after-intent')m.native={capability:()=>{throw Object.assign(Error('unproven'),{code:'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'});}};};
        await assert.rejects(m.start(),{code:'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'});
        assert.ok(await readFile(migrationPath(m.path,'intent')));return;
    }
    await m.prepare();
    if(kind==='intent')await writeFile(migrationPath(m.path,'intent'),'corrupt');
    if(kind==='intent-stage')await writeFile(migrationPath(m.path,'intent.stage'),'different');
    if(kind==='base')await writeFile(m.path+'.wal','corrupt');
    if(kind==='snapshot-stage')await writeFile(migrationPath(m.path,'snapshot.stage'),'corrupt');
    if(kind==='changed-v1')await writeFile(m.path,JSON.stringify(ledgerSnapshot()));
    if(kind==='changed-authority')await writeFile(m.authorityPath,JSON.stringify({epoch:21}));
    if(kind==='changed-marker')await writeFile(m.path+'.bootstrap',JSON.stringify({version:1,authorityEpoch:19}));
    const before=await inventory(root);await assert.rejects(m.start());assert.deepEqual(await inventory(root),before);
});
