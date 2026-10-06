import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,readdir,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {seedMigration,migrationFixture} from '../test-support/CleanLedgerMigrationFixture.mjs';
import {ledgerSnapshot} from '../server/scheduler/ScheduledEntryLedgerContract.js';
import {initializeEntryLedger} from '../server/scheduler/ScheduledEntryRuntime.js';
import ScheduledEntryRuntime from '../server/scheduler/ScheduledEntryRuntime.js';
import Repository from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import {envelope,inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
const windows={skip:process.platform!=='win32',timeout:180000};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'lz-r8-policy-'));t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(rel.startsWith('lz-r8-policy-')&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});});return {root,...await seedMigration(root)};}
test('only the held maintenance reservation may explain this process listening on 8080',windows,async t=>{
    const {migration:m}=await fixture(t);const inspect=m.host.inspect;let held=false;
    m.host.inspect=async()=>({...await inspect(),ports:held?[{LocalPort:8080,OwningProcess:process.pid}]:[]});
    m.host.reserve=async()=>{assert.equal(held,false);held=true;return ()=>{held=false;};};
    assert.equal((await m.prepare()).migrationState,'INTENT_DURABLE');assert.equal(held,false);
    held=true;await assert.rejects(m.start(),{code:'CANONICAL_OFFLINE_PROOF_REQUIRED'});held=false;
});
test('foreign listener appearing after reservation stops before intent mutation',windows,async t=>{
    const {migration:m}=await fixture(t);const inspect=m.host.inspect;let held=false;
    m.host.inspect=async()=>({...await inspect(),ports:held?[{LocalPort:8080,OwningProcess:999999}]:[]});
    m.host.reserve=async()=>{held=true;return ()=>{held=false;};};
    await assert.rejects(m.prepare(),{code:'MIGRATION_RESERVATION_PORT_CONFLICT'});
    await assert.rejects(readFile(m.path+'.migration.intent.stage'),{code:'ENOENT'});assert.equal(held,false);
});
test('fresh exact v1 hash is checked again before the first intent write',windows,async t=>{
    const {root,migration:m}=await fixture(t);const changed=JSON.stringify(ledgerSnapshot());
    m.hook=async stage=>{if(stage==='before-intent')await writeFile(m.path,changed);};
    await assert.rejects(m.prepare(),{code:'LEDGER_MIGRATION_FRESH_HASH_CHANGED'});
    assert.equal(await readFile(m.path,'utf8'),changed);assert.ok(!(await readdir(root)).some(n=>n.includes('.migration.')));
});
test('a migration repository path cannot escape the reviewed root',windows,async t=>{
    const {root}=await fixture(t);assert.throws(()=>migrationFixture(root,{path:join(root,'..','outside-ledger.json')}),{code:'LEDGER_MIGRATION_REPOSITORY_MISMATCH'});
});
test('v2 snapshot with no WAL selects v2 and never acquires a legacy writer lock',windows,async t=>{
    const {migration:m,snapshot}=await fixture(t);await writeFile(m.path,JSON.stringify(envelope(m.path,snapshot)));
    const ledger=await initializeEntryLedger({path:m.path,ownership:{available:true,authorityEpoch:21,authorityProcessSession:'startup'},startupSchedule:{events:[]},executionRepository:{status:'READY'}});
    assert.equal(ledger.protocolVersion,2);assert.equal(ledger.error,'LEDGER_V2_WAL_MISSING');await ledger.close();
    await assert.rejects(readFile(m.path+'.lock'),{code:'ENOENT'});
});
test('migration intent gates Scheduled evaluation and capture until v2 readiness',windows,async t=>{
    const {migration:m}=await fixture(t);await m.prepare();
    const ledger=await initializeEntryLedger({path:m.path,ownership:{available:true,authorityEpoch:21,authorityProcessSession:'startup'},startupSchedule:{events:[]},executionRepository:{status:'READY'}});
    assert.equal(ledger.protocolVersion,2);assert.equal(ledger.error,'LEDGER_MIGRATION_RESUME_REQUIRED');
    const runtime=new ScheduledEntryRuntime({scheduler:{store:{}},ready:Promise.resolve(ledger),automation:{resolveSource(){assert.fail('Scheduled source evaluation before READY');}}});
    await runtime.ready;assert.equal(runtime.gate({}), 'LEDGER_UNAVAILABLE');runtime.close();await ledger.close();
});
test('a torn UTF-8 path in intent staging resumes by exact byte prefix, without lossy decoding',windows,async t=>{
    const root=await mkdtemp(join(tmpdir(),'lz-r8-policy-è-'));
    t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(rel.startsWith('lz-r8-policy-')&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});});
    const {migration:m,snapshot}=await seedMigration(root);await m.prepare();
    const complete=await readFile(m.path+'.migration.intent'),offset=complete.indexOf(Buffer.from('è'));
    assert.ok(offset>0);await unlink(m.path+'.migration.intent');
    await writeFile(m.path+'.migration.intent.stage',complete.subarray(0,offset+1));
    assert.equal((await m.inspect()).migrationState,'INTENT_STAGING');
    assert.equal((await m.start()).migrationState,'COMPLETED');assert.deepEqual((await inspectV2(m.path)).current,snapshot);
});
test('a stage altered at native install entry is never installed as canonical',windows,async t=>{
    const {migration:m}=await fixture(t);const original=await readFile(m.path);
    m.hook=async stage=>{if(stage==='snapshot-installing')await writeFile(m.path+'.migration.snapshot.stage','{');};
    await assert.rejects(m.start(),{code:'LEDGER_MIGRATION_STAGE_CORRUPT'});assert.deepEqual(await readFile(m.path),original);
});
test('invalid UTF-8 provenance is refused rather than hashed after lossy decoding',windows,async t=>{
    const {root,migration:m}=await fixture(t);
    await writeFile(m.authorityPath,Buffer.concat([Buffer.from('{"epoch":20,"opaque":"'),Buffer.from([255]),Buffer.from('"}') ]));
    await assert.rejects(m.prepare(),{code:'LEDGER_MIGRATION_ENCODING_UNPROVEN'});
    assert.ok(!(await readdir(root)).some(n=>n.includes('.migration.')));
});
test('retained completed intent forbids bootstrap even when canonical, WAL and marker are missing',windows,async t=>{
    const {migration:m}=await fixture(t);await m.start();
    for(const p of [m.path,m.path+'.wal',m.path+'.bootstrap'])await unlink(p);
    const ledger=await initializeEntryLedger({path:m.path,ownership:{available:true,authorityEpoch:21,authorityProcessSession:'startup'},
        startupSchedule:{events:[]},executionRepository:{status:'READY'},bootstrap:true});
    assert.equal(ledger.protocolVersion,2);assert.equal(ledger.error,'LEDGER_MIGRATION_CANONICAL_MISSING');await ledger.close();
    const direct=new Repository({path:m.path,create:true,authority:{authorityEpoch:21,authorityProcessSession:'startup'}});
    await direct.initialize();assert.equal(direct.error,'LEDGER_MIGRATION_CANONICAL_MISSING');await direct.close();
    for(const p of [m.path,m.path+'.wal',m.path+'.bootstrap',m.path+'.lock'])await assert.rejects(readFile(p),{code:'ENOENT'});
});
test('completed migration with a changed marker refuses ordinary v2 startup',windows,async t=>{
    const {migration:m}=await fixture(t);await m.start();
    await writeFile(m.path+'.bootstrap',JSON.stringify({version:1,authorityEpoch:19}));
    const direct=new Repository({path:m.path,authority:{authorityEpoch:21,authorityProcessSession:'startup'}});
    await direct.initialize();assert.equal(direct.error,'LEDGER_MIGRATION_PROVENANCE_CHANGED');await direct.close();
    await assert.rejects(readFile(m.path+'.lock'),{code:'ENOENT'});
});
