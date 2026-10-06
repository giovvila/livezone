import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {capturedEvidence,readEvidence} from '../server/recovery/PersistentEvidence.js';
import {artifact,capture,paths,evidenceKeys} from '../server/recovery/RecoveryContract.js';
import {ordinary,inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {migrationArtifacts,assertMigrationStartup} from '../server/recovery/CleanLedgerV1Migration.js';
import {ledgerAuthority} from '../server/recovery/RestoreLedgerAuthority.js';
import {phaseRecord,validatePhase} from '../server/recovery/RecoveryLineage.js';
import {completedScheduledHistory,journalMatchesLock} from '../server/scheduler/ScheduledExecutionProvenance.js';
import {reconcileAuthorityLock} from '../server/autolive/ReconcileAuthorityLock.js';
import {reconcileScheduledExecutionLock} from '../server/scheduler/ReconcileScheduledExecutionLock.js';
import AutoLiveStore from '../server/autolive/AutoLiveStore.js';
import Ownership from '../server/autolive/BrowserExecutionOwnership.js';
import ScheduleStore from '../server/scheduler/ScheduleStore.js';
import Program from '../server/program-output/DurableProgramRepository.js';
import Scheduled from '../server/scheduler/ScheduledLiveExecutionRepository.js';
import LedgerV1 from '../server/scheduler/ScheduledEntryLedgerRepository.js';
import LedgerV2 from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import {initializeEntryLedger} from '../server/scheduler/ScheduledEntryRuntime.js';
import {recordFor} from '../server/program-output/DurableProgramContract.js';
import {fixtureProgram} from '../test-support/CompletedScheduledHistoryFixture.mjs';

const invalid={truncated:[0xe2,0x82],continuation:[0xe2,0x28,0xa1],overlong:[0xc0,0xaf],
    surrogate:[0xed,0xa0,0x80],outOfRange:[0xf4,0x90,0x80,0x80],embedded:[0xff]};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function temp(t){
    const root=await mkdtemp(join(tmpdir(),'lz-r20-evidence-'));
    t.after(async()=>{const rel=relative(tmpdir(),root);assert.ok(rel.startsWith('lz-r20-evidence-')&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});});
    return root;
}
const malformed=bytes=>Buffer.concat([Buffer.from('{"name":"'),Buffer.from(bytes),Buffer.from('"}')]);
function collision(valid){
    const offset=valid.indexOf(Buffer.from('\uFFFD'));assert.ok(offset>=0);
    const damaged=Buffer.concat([valid.subarray(0,offset),Buffer.from([0xff]),valid.subarray(offset+3)]);
    assert.equal(valid.toString('utf8'),damaged.toString('utf8'));return damaged;
}
test('PROGRAM semantic checksum cannot authorize replacement-decoded corrupt bytes',async t=>{
    const root=await temp(t),path=join(root,'program'),envelope=structuredClone(fixtureProgram());
    envelope.snapshot.scene.name='literal-\uFFFD';
    const record=recordFor({envelope,identity:{sourceFingerprint:null,catalog:null,assets:[]},retiredPublisherSessions:[],generation:1,authorityEpoch:22});
    const valid=Buffer.from(JSON.stringify(record));await writeFile(path,valid);
    const program=new Program({path});assert.ok(await program.load());
    const damaged=collision(valid);await writeFile(path,damaged);
    assert.equal(await program.load(),null);assert.equal(program.status,'CORRUPT');
    assert.deepEqual(await readFile(path),damaged);
});
test('Schedule identity migration cannot persist a replacement-decoded document',async t=>{
    const root=await temp(t),path=join(root,'schedule'),at='2026-10-02T00:00:00.000Z';
    const value={version:1,revision:1,events:[{id:'live',version:1,type:'source.live',name:'literal-\uFFFD',enabled:true,
        startAt:at,endAt:'2026-10-03T00:00:00.000Z',priority:1,createdAt:at,updatedAt:at,
        payload:{sourceId:'camera',precheckSeconds:180,unavailableAction:'KEEP_PROGRAM',unavailableSceneId:null,endAction:'RETURN',endSceneId:null}}]};
    const valid=Buffer.from(JSON.stringify(value));await writeFile(path,valid);
    const good=new ScheduleStore({path});await good.initialize();assert.equal(good.status,'READY');
    assert.equal(good.state.version,3);assert.ok(good.state.events[0].incarnationId);await good.destroy();
    const damaged=collision(valid);await writeFile(path,damaged);let writes=0;
    const bad=new ScheduleStore({path,fileOperations:{rename:async()=>{writes++;throw Error('UNEXPECTED_WRITE');}}});
    await bad.initialize();assert.equal(bad.status,'UNAVAILABLE');assert.equal(writes,0);await bad.destroy();
    assert.deepEqual(await readFile(path),damaged);
});
for(const [name,bytes] of Object.entries(invalid))test('Strict UTF8 rejects '+name+' before JSON protocol interpretation',async t=>{
    const root=await temp(t),path=join(root,'record'),raw=malformed(bytes);
    await writeFile(path,raw);
    assert.equal(capturedEvidence(raw,{text:false}).sha256,sha(raw));
    assert.throws(()=>capturedEvidence(raw,{json:true}),{code:'PERSISTENT_EVIDENCE_INVALID_UTF8'});
    for(const read of [readEvidence,artifact,ordinary])await assert.rejects(read(path),{code:'PERSISTENT_EVIDENCE_INVALID_UTF8'});
    assert.throws(()=>completedScheduledHistory(raw,{scheduledPath:path}),{code:'PERSISTENT_EVIDENCE_INVALID_UTF8'});
    assert.throws(()=>journalMatchesLock(raw,{}),{code:'PERSISTENT_EVIDENCE_INVALID_UTF8'});
    assert.deepEqual(await readFile(path),raw);
});
const validPairs={
    'valid Unicode':['{"a":"café"}','{"a":"cafè"}'],
    'BOM':['{"a":1}','\uFEFF{"a":1}'],
    'CRLF/LF':['{"a":1}\n','{"a":1}\r\n'],
    'trailing whitespace':['{"a":1}','{"a":1} \t\n'],
    'JSON whitespace':['{"a":1}','{ "a" : 1 }'],
    'JSON key order':['{"a":1,"b":2}','{"b":2,"a":1}'],
    'Unicode normalization':['{"a":"é"}','{"a":"e\u0301"}']
};
for(const [name,pair] of Object.entries(validPairs))test('Byte identity preserves '+name,async t=>{
    const root=await temp(t),path=join(root,'record');let previous;
    for(const text of pair){const bytes=Buffer.from(text);await writeFile(path,bytes);
        const e=await readEvidence(path);assert.deepEqual(e.bytes,bytes);assert.equal(e.byteLength,bytes.length);
        assert.equal(e.sha256,sha(bytes));assert.equal(e.text,text);assert.equal((await artifact(path)).hash,e.sha256);
        if(previous)assert.notEqual(e.sha256,previous);previous=e.sha256;
    }
    if(name==='BOM'){assert.throws(()=>capturedEvidence(Buffer.from(pair[1]),{json:true}),SyntaxError);}
    else if(!['valid Unicode','Unicode normalization'].includes(name))assert.deepEqual(JSON.parse(pair[0]),JSON.parse(pair[1]));
});
test('One captured buffer supplies digest and parse even when pathname changes',async t=>{
    const root=await temp(t),path=join(root,'record'),first=Buffer.from('{"version":1}');
    await writeFile(path,first);const e=await readEvidence(path,{json:true});
    await writeFile(path,'{"version":2}');
    assert.equal(e.sha256,sha(first));assert.deepEqual(e.value,{version:1});assert.deepEqual(e.bytes,first);
    assert.notEqual((await readEvidence(path,{json:true})).sha256,e.sha256);
});
// All completed records share the strict boundary. Protocol-owned staging is
// opaque byte evidence, with prefix validation covered by the R26 suite.
for(const key of evidenceKeys.filter(key=>key!=='migrationIntentStage'))test('Recovery capture fails closed on malformed UTF8 '+key,async t=>{
    const root=await temp(t),p=paths(root);await mkdir(dirname(p[key]),{recursive:true});
    const raw=malformed([0xff]);await writeFile(p[key],raw);
    await assert.rejects(capture(p),{code:'PERSISTENT_EVIDENCE_INVALID_UTF8'});
    assert.deepEqual(await readFile(p[key]),raw);
});
test('Migration staging capture preserves invalid bytes without text or JSON interpretation',async t=>{
    const root=await temp(t),p=paths(root);await mkdir(dirname(p.ledger),{recursive:true});
    const raw=malformed([0xff]);await writeFile(p.migrationIntentStage,raw);
    const e=(await capture(p)).migrationIntentStage;
    assert.equal(e.hash,sha(raw));assert.deepEqual(e.value,{migrationStage:true,byteLength:raw.length});
    await assert.rejects(artifact(p.migrationIntentStage),{code:'PERSISTENT_EVIDENCE_INVALID_UTF8'});
    assert.deepEqual(await readFile(p.migrationIntentStage),raw);
});
test('Valid UTF8 malformed JSON stays diagnostic and cannot satisfy phase lineage',async t=>{
    const root=await temp(t),path=join(root,'record');await writeFile(path,'{"a":');
    await assert.rejects(readEvidence(path,{json:true}),SyntaxError);
    const record=await artifact(path);assert.deepEqual(record.value,{invalidJSON:true});
    assert.throws(()=>validatePhase(record,{},'prepared'),{code:'LEGACY_PHASE_RECORD_REVIEW_REQUIRED'});
});
test('Phase predecessor and audit identity distinguish formatting without semantic fallback',async t=>{
    const root=await temp(t),path=join(root,'phase'),context={version:1,auditHash:'a'.repeat(64),runId:'run',head:'b'.repeat(40),root};
    await writeFile(path,'{"state":"first"}');const first=await artifact(path);
    const next={value:phaseRecord(context,'disarm',first,{state:'PREPARED'})};
    await writeFile(path,'{ "state" : "first" }');const changed=await artifact(path);
    assert.deepEqual(first.value,changed.value);assert.notEqual(first.hash,changed.hash);
    assert.throws(()=>validatePhase(next,context,'disarm',changed),{code:'RECOVERY_PHASE_LINEAGE_MISMATCH'});
});
for(const [name,bytes] of [...Object.entries(invalid),['malformedJSON',null]])test('Authoritative readers reject '+name+' without replacing protocol files',async t=>{
    const root=await temp(t),raw=bytes?malformed(bytes):Buffer.from('{"epoch":'),path=join(root,'record');
    const authorityPath=join(root,'authority.execution'),authority={available:true,closed:false,path:authorityPath,authorityEpoch:22,authorityProcessSession:'r20-test'};
    const authorityBytes=Buffer.from('{"epoch":22}');await writeFile(authorityPath,authorityBytes);
    const prepare=()=>writeFile(path,raw);
    await prepare();const auto=new AutoLiveStore({path});await auto.initialize();assert.equal(auto.status,'UNAVAILABLE');await auto.close();
    const schedule=new ScheduleStore({path});await schedule.initialize();assert.equal(schedule.status,'UNAVAILABLE');await schedule.destroy();
    const program=new Program({path});assert.equal(await program.load(),null);assert.equal(program.status,'CORRUPT');
    const scheduled=new Scheduled({path,publicRoot:join(root,'public'),authority});await scheduled.initialize();assert.equal(scheduled.status,'CORRUPT');await scheduled.close();
    for(const [index,Repository] of [LedgerV1,LedgerV2].entries()){
        const ledgerPath=join(root,'ledger'+index);await writeFile(ledgerPath,raw);
        const ledger=new Repository({path:ledgerPath,authority,syncDirectory:()=> 'DIRECTORY_SYNCED'});
        await ledger.initialize();assert.notEqual(ledger.status,'READY');await ledger.close();assert.deepEqual(await readFile(ledgerPath),raw);
    }
    await writeFile(authorityPath,raw);const owner=new Ownership({path:authorityPath});await owner.ready;assert.equal(owner.available,false);await owner.close();assert.deepEqual(await readFile(authorityPath),raw);
    await writeFile(authorityPath,authorityBytes);
    const migrationPath=join(root,'migration');await writeFile(migrationPath+'.migration.intent',raw);
    if(bytes)await assert.rejects(migrationArtifacts(migrationPath),{code:'LEDGER_MIGRATION_ENCODING_UNPROVEN'});
    if(!bytes)assert.equal((await migrationArtifacts(migrationPath)).intent,raw.toString());
    await assert.rejects(assertMigrationStartup(migrationPath));
    const walPath=join(root,'wal-ledger');await writeFile(walPath+'.wal',raw);await assert.rejects(inspectV2(walPath));
    await assert.rejects(ledgerAuthority({p:{ledger:path,ledgerWal:path+'.wal',marker:path+'.bootstrap',authority:authorityPath}}));
    if(bytes)await assert.rejects(initializeEntryLedger({path,options:{},ownership:authority}),{code:'PERSISTENT_EVIDENCE_INVALID_UTF8'});
    await writeFile(authorityPath,raw);await writeFile(authorityPath+'.lock',raw);
    await assert.rejects(reconcileAuthorityLock({path:authorityPath}));
    await writeFile(path+'.lock',raw);
    await assert.rejects(reconcileScheduledExecutionLock({path,authorityPath,operationId:'negative',expected:{},
        proveOffline:async()=>({absent:true}),reserve:async()=>()=>{},isAlive:()=>false}));
    assert.deepEqual(await readFile(path),raw);assert.deepEqual(await readFile(path+'.lock'),raw);
});
