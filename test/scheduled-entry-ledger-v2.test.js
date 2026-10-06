import test from 'node:test';
import {transitionScheduledLiveTransaction} from '../server/scheduler/ScheduledLiveExecutionTransaction.js';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Repository from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import Legacy from '../server/scheduler/ScheduledEntryLedgerRepository.js';
import {scheduledEntryIdentity} from '../server/scheduler/ScheduledEntryIdentity.js';
import {repositoryIdentity} from '../server/scheduler/ScheduledExecutionProvenance.js';
import {envelope,inspectV2,ordinary,parseWal,seal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {ledgerRecoveryEvidence,reconcileScheduledEntryLedgerV2} from '../server/scheduler/ReconcileScheduledEntryLedgerV2.js';
import {initializeEntryLedger} from '../server/scheduler/ScheduledEntryRuntime.js';
import {harness,START,END} from '../test-support/ScheduledEntryHarness.js';
import {directorySync as realDirectorySync} from '../server/scheduler/LedgerV2Durability.js';
import {migrationFixture} from '../test-support/CleanLedgerMigrationFixture.mjs';
import BrowserExecutionOwnership from '../server/autolive/BrowserExecutionOwnership.js';

const identity=scheduledEntryIdentity({eventId:'v2-event',incarnationId:'12345678-1234-1234-1234-123456789abc',entryRevision:1,
    type:'source.live',sourceId:'camera',startAt:'2026-10-01T12:00:00.000Z',endAt:'2026-10-01T12:05:00.000Z'});
const context={authorityEpoch:22,authorityProcessSession:'authority-session',consumedAt:'2026-10-01T12:01:00.000Z'};
const nativeMode=process.env.LZ_TEST_NATIVE_DURABILITY==='1'; // Test runner only; never a production capability override.
const syncDirectory=nativeMode?realDirectorySync:()=> 'DIRECTORY_SYNCED';
const proof=async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}]});
const child=fileURLToPath(new URL('../test-support/LedgerV2CrashChild.mjs',import.meta.url));
async function fixture(t) {
    const dir=await mkdtemp(join(tmpdir(),'lz-ledger-v2-')),path=join(dir,'ledger.json');const repositories=[];
    t.after(async()=>{
        for(const r of repositories)await r.close().catch(()=>{});
        const rel=relative(resolve(tmpdir()),resolve(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&rel.startsWith('lz-ledger-v2-'));
        await rm(dir,{recursive:true,force:true});
    });
    const make=options=>{const r=new Repository({path,authority:context,syncDirectory,...options});repositories.push(r);return r;};
    const first=make({create:true});await first.initialize();assert.equal(first.status,'READY',first.error);await first.close();
    const inputPath=join(dir,'input.json');await writeFile(inputPath,JSON.stringify({identity,context}));
    const crash=point=>{const r=spawnSync(process.execPath,[child,path,point,inputPath,nativeMode?'native':'fixture'],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(r.status,77,r.stderr);};
    const setupRecovery=async()=>{
        const owner=JSON.parse(await readFile(path+'.lock','utf8'));
        const authorityPath=join(dir,'authority.execution'),scheduledPath=join(dir,'scheduled.json');
        await writeFile(path+'.bootstrap',JSON.stringify({version:1,authorityEpoch:22}));
        await writeFile(authorityPath,JSON.stringify({epoch:22}));
        await writeFile(authorityPath+'.lock',JSON.stringify({pid:owner.pid,authorityProcessSession:context.authorityProcessSession}));
        await writeFile(scheduledPath+'.lock',JSON.stringify({schemaVersion:2,repositoryId:repositoryIdentity(scheduledPath),
            processId:owner.pid,processSession:'scheduled-session',authorityEpoch:22,authorityProcessSession:context.authorityProcessSession,
            authorityId:repositoryIdentity(authorityPath),initialJournalHash:null,createdAt:new Date().toISOString()}));
        const args={path,authorityPath,scheduledPath,operationId:'test-recovery',proveOffline:proof,reserve:async()=>()=>{},isAlive:()=>false,syncDirectory};
        args.expected=(await ledgerRecoveryEvidence(args)).hashes;
        return args;
    };
    return {dir,path,make,crash,setupRecovery};
}

test('v2 clean same/different concurrent consumption and clean restart retain exact executable identity',async t=>{
    const f=await fixture(t),r=f.make();await r.initialize();
    const results=await Promise.all([r.consume(identity,context),r.consume(identity,context)]);
    assert.deepEqual(results.map(r=>r.status),['CONSUMED','ALREADY_CONSUMED']);
    const identities=Array.from({length:4},(_,i)=>({...identity,entryRevision:i+2}));
    // Recompute derived identity rather than supplying a forged entryKey.
    for(const i of identities){delete i.entryKey;delete i.identitySchema;}
    assert.ok((await Promise.all(identities.map(i=>r.consume(i,context)))).every(r=>r.status==='CONSUMED'));
    await r.close();const next=f.make();await next.initialize();assert.equal(next.status,'READY');
    assert.ok(Object.isFrozen(next.snapshot));assert.ok(Object.isFrozen(next.lockOwner));
    assert.equal((await next.consume(identity,context)).status,'ALREADY_CONSUMED');assert.equal(next.snapshot.generation,5);
});

const points=['before-intent','intent-opened','intent-written','intent-flushed','opened','written','flushed','staged','before-replace',
    'replaced','durable','commit-opened','commit-written','commit-flushed','before-publication','published','end-opened','end-written','end-flushed','shutdown-durable'];
for(const point of points)test('abrupt child loss at '+point+': no ambiguous outcome becomes executable',async t=>{
    const f=await fixture(t);f.crash(point);const args=await f.setupRecovery();
    const locked=f.make();await locked.initialize();assert.equal(locked.status,'CONFLICT');
    if(point==='opened') {
        await assert.rejects(reconcileScheduledEntryLedgerV2(args));assert.ok(await ordinary(f.path+'.lock'));return;
    }
    await reconcileScheduledEntryLedgerV2(args);
    await reconcileScheduledEntryLedgerV2(args); // retry after completed archival
    const r=f.make();await r.initialize();assert.equal(r.status,'READY',r.error);
    const answer=await r.inspect(identity);
    assert.equal(answer.status,['before-intent','intent-opened'].includes(point)?'UNCONSUMED':'ALREADY_CONSUMED');
    if(answer.status==='ALREADY_CONSUMED')assert.equal((await r.consume(identity,context)).status,'ALREADY_CONSUMED');
});

for(const point of ['prepared','opened','written','flushed','staged','before-replace','replaced','durable','commit-flushed','end-flushed','recovered','archived','completed'])
test('recovery interruption at '+point+' retains suppression or blocks retry',async t=>{
    const f=await fixture(t);f.crash('intent-flushed');const args=await f.setupRecovery();
    await assert.rejects(reconcileScheduledEntryLedgerV2({...args,hook:stage=>{if(stage===point)throw Error('recovery-crash');}}),/recovery-crash/);
    if(point==='opened'){await assert.rejects(reconcileScheduledEntryLedgerV2(args));return;}
    await reconcileScheduledEntryLedgerV2(args);
    const r=f.make();await r.initialize();assert.equal(r.status,'READY',r.error);assert.equal((await r.inspect(identity)).status,'ALREADY_CONSUMED');
});

test('old and new canonical both recover to the identical conservative intent snapshot',async t=>{
    for(const point of ['intent-flushed','replaced']){
        const f=await fixture(t);f.crash(point);const before=await inspectV2(f.path),args=await f.setupRecovery();
        assert.ok(before.pending);await reconcileScheduledEntryLedgerV2(args);
        assert.deepEqual((await inspectV2(f.path)).current,before.pending.next);
    }
});

for(const corruption of ['partial-intent','checksum','generation','next-hash','ledger-id','repository-id','owner','canonical-corrupt','canonical-missing','stage-partial','unknown-temp'])
test('v2 refuses '+corruption+' without removing lock',async t=>{
    const f=await fixture(t);f.crash('intent-flushed');
    const wal=await readFile(f.path+'.wal','utf8');
    if(corruption==='partial-intent')await writeFile(f.path+'.wal',wal.slice(0,-10));
    else if(['checksum','generation','next-hash','ledger-id','repository-id','owner'].includes(corruption)) {
        const records=wal.trimEnd().split('\n').map(JSON.parse),last=records.at(-1);
        if(corruption==='checksum')last.checksum='0'.repeat(64);
        else {
            if(corruption==='generation')last.data.previousGeneration++;
            if(corruption==='next-hash')last.data.nextHash='0'.repeat(64);
            if(corruption==='ledger-id')last.data.next.ledgerId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
            if(corruption==='repository-id')last.data.owner.repositoryId='0'.repeat(64);
            if(corruption==='owner')last.data.owner.processSession='wrong';
            const {checksum,...payload}=last;records[records.length-1]=seal(payload);
        }
        await writeFile(f.path+'.wal',records.map(r=>JSON.stringify(r)).join('\n')+'\n');
    }else if(corruption==='canonical-corrupt')await writeFile(f.path,'{}');
    else if(corruption==='canonical-missing')await unlink(f.path);
    else if(corruption==='unknown-temp')await writeFile(f.path+'.unknown.tmp','x');
    else {const state=parseWal(f.path,wal);await writeFile(f.path+'.'+state.pending.transactionId+'.stage','partial');}
    const args=await f.setupRecovery();await assert.rejects(reconcileScheduledEntryLedgerV2(args));assert.ok(await ordinary(f.path+'.lock'));
});

for(const mismatch of ['live','census','service','marker','authority','scheduled','lock','race','namespace'])test('offline refusal: '+mismatch,async t=>{
    const f=await fixture(t);f.crash('intent-flushed');const args=await f.setupRecovery();
    if(mismatch==='live')args.isAlive=()=>true;
    if(mismatch==='census')args.proveOffline=async()=>({absent:false,services:[]});
    if(mismatch==='service')args.proveOffline=async()=>({absent:true,services:[{State:'Running',StartMode:'Auto'}]});
    if(mismatch==='namespace')args.syncDirectory=()=> 'FILE_SYNC_ONLY';
    if(mismatch==='race')args.hook=async stage=>{if(stage==='prepared')await writeFile(args.authorityPath,JSON.stringify({epoch:23}));};
    if(['marker','authority','scheduled','lock'].includes(mismatch)) {
        const p=mismatch==='marker'?f.path+'.bootstrap':mismatch==='authority'?args.authorityPath:mismatch==='scheduled'?args.scheduledPath+'.lock':f.path+'.lock';
        const value=JSON.parse(await readFile(p,'utf8'));
        if(mismatch==='marker')value.authorityEpoch=99;
        if(mismatch==='authority')value.epoch=23;
        if(mismatch==='scheduled')value.authorityProcessSession='wrong';
        if(mismatch==='lock')value.initialGeneration=99;
        await writeFile(p,JSON.stringify(value));args.expected=(await ledgerRecoveryEvidence(args)).hashes;
    }
    await assert.rejects(reconcileScheduledEntryLedgerV2(args));assert.ok(await ordinary(f.path+'.lock'));
});

test('v1 migration is explicit; orphan v1 cannot be migrated or reconciled',async t=>{
    const f=await fixture(t); // use separate path in this private fixture directory
    const path=join(f.dir,'legacy.json'),legacy=new Legacy({path,create:true});
    await legacy.consume(identity,context);await legacy.close();const before=await readFile(path,'utf8');
    const denied=new Repository({path,authority:context,syncDirectory});await denied.initialize();assert.equal(denied.error,'LEDGER_V2_EXPLICIT_MIGRATION_REQUIRED');
    assert.equal(await readFile(path,'utf8'),before);
    await writeFile(path+'.lock',JSON.stringify({version:1,pid:999999,processSession:'legacy'}));
    const blocked=new Repository({path,authority:context,migrateV1:true});await blocked.initialize();assert.equal(blocked.error,'LEGACY_LEDGER_LOCK_UNVERIFIABLE');
    await assert.rejects(reconcileScheduledEntryLedgerV2({path,authorityPath:join(f.dir,'a'),scheduledPath:join(f.dir,'s'),operationId:'legacy',expected:{},proveOffline:proof}),/LEGACY_LEDGER_LOCK_UNVERIFIABLE/);
    // Isolated fixture models a separate clean-shutdown history, never real v1.
    await unlink(path+'.lock');
    const unapproved=new Repository({path,authority:context,migrateV1:true,syncDirectory});await unapproved.initialize();
    assert.equal(unapproved.error,'LEDGER_V2_CONTROLLED_MIGRATION_REQUIRED');
    await writeFile(path+'.bootstrap',JSON.stringify({version:1,authorityEpoch:22}));
    const authorityPath=join(f.dir,'migration-authority');await writeFile(authorityPath,JSON.stringify({epoch:22}));
    await migrationFixture(f.dir,{path,authorityPath}).start();
    const migrated=new Repository({path,authority:context,syncDirectory});await migrated.initialize();
    assert.equal(migrated.status,'READY',migrated.error);assert.equal((await migrated.inspect(identity)).status,'ALREADY_CONSUMED');await migrated.close();
    const oldWriter=new Legacy({path});await oldWriter.initialize();assert.equal(oldWriter.error,'LEDGER_V2_REPOSITORY_REQUIRED');
});

test('startup v2 selection is sticky and never exposes pending recovery as READY',async t=>{
    const f=await fixture(t);f.crash('intent-flushed');
    const r=await initializeEntryLedger({path:f.path,ownership:{available:true,...context},startupSchedule:{events:[]},executionRepository:{status:'READY'}});
    assert.equal(r.protocolVersion,2);assert.equal(r.status,'CONFLICT');await r.close();
});

test('missing WAL on v2 canonical never falls back to v1',async t=>{
    const f=await fixture(t);await unlink(f.path+'.wal');const r=f.make({migrateV1:true});await r.initialize();assert.equal(r.error,'LEDGER_V2_WAL_MISSING');
    const legacy=new Legacy({path:f.path});await legacy.initialize();assert.notEqual(legacy.status,'READY');await legacy.close();
});

test('real Scheduled v2 pipeline consumes before capture once and never replays after clean restart',async t=>{
    const h=await harness(t,{serverOptions:{scheduledEntryLedgerOptions:{protocolVersion:2,syncDirectory}}});
    assert.equal(h.owner.scheduledEntry.ledger.protocolVersion,2);
    h.fire(START+1);await h.settle();
    assert.equal(h.owner.scheduledEntry.ledger.snapshot.generation,1);assert.equal(h.captures.length,1);
    const history=h.owner.scheduledEntry.diagnostics();
    assert.ok(history.findIndex(e=>e.decision==='CONSUMED')<history.findIndex(e=>e.decision==='CAPTURE'));
    // A clean shutdown must retain completed diagnostic history. An active
    // sequence instead keeps ownership witnesses for normal offline recovery.
    let terminal=h.owner.scheduledLiveExecutionRepository.record;
    for(const operation of ['begin-postroll','prepare-return','complete'])
        terminal=transitionScheduledLiveTransaction(terminal,operation,{manualIntentRevision:terminal.manualIntentRevision});
    await h.owner.scheduledLivePersistence.persist(terminal);
    await h.restart(START+20);await h.clearRestart();h.health({});await h.settle();
    assert.equal(h.captures.length,1);assert.equal(h.owner.scheduledEntry.ledger.snapshot.generation,1);
});

for(const fence of ['manual','end','authority'])test('v2 irrevocable intent suppresses capture when '+fence+' changes before install',async t=>{
    let h,armed=false,finish;
    h=await harness(t,{serverOptions:{scheduledEntryLedgerOptions:{protocolVersion:2,syncDirectory,hook(stage){
        if(!armed||stage!=='before-replace')return;armed=false;
        if(fence==='manual')finish=h.owner.scheduledLiveExecution.reconciliation.beginManualIntent();
        if(fence==='end')h.advance(END);
        if(fence==='authority')h.owner.executionOwnership.restartBlocked=true;
    }}}});
    armed=true;h.fire(START+1);await h.settle();finish?.();
    assert.equal(h.owner.scheduledEntry.ledger.snapshot.generation,1);
    assert.equal(h.captures.length,0);assert.equal(h.acceptedLive().length,0);
});

test('pending v2 startup recovery never captures before READY',async t=>{
    let armed=false;
    const h=await harness(t,{serverOptions:{scheduledEntryLedgerOptions:{protocolVersion:2,syncDirectory,hook(stage){
        if(armed&&stage==='replaced'){armed=false;throw Error('simulated-loss');}
    }}}});
    armed=true;h.fire(START+1);await h.settle();assert.equal(h.captures.length,0);
    assert.equal(h.owner.scheduledEntry.ledger.status,'DURABILITY_UNCERTAIN');
    const path=h.owner.scheduledEntry.ledger.path,authorityPath=h.owner.executionOwnership.path;
    const locks=await Promise.all([path+'.lock',authorityPath+'.lock',h.owner.scheduledLiveExecutionRepository.path+'.lock'].map(p=>readFile(p,'utf8')));
    const shutdownError=await new Promise(done=>h.owner.server.close(done));assert.equal(shutdownError.code,'LEDGER_V2_SHUTDOWN_RECOVERY_REQUIRED');
    assert.deepEqual(await Promise.all([path+'.lock',authorityPath+'.lock',h.owner.scheduledLiveExecutionRepository.path+'.lock'].map(p=>readFile(p,'utf8'))),locks);
    // An unresolved ledger shutdown now retains its companion witnesses. A
    // normal restart must not manufacture a new authority before recovery.
    const ownership=new BrowserExecutionOwnership({path:authorityPath});await ownership.ready;assert.equal(ownership.available,false);
    const blocked=await initializeEntryLedger({path,ownership,startupSchedule:h.owner.scheduler.store.getSnapshot(),executionRepository:{status:'READY'},options:{protocolVersion:2,syncDirectory}});
    assert.equal(blocked.error,'AUTHORITY_UNAVAILABLE');assert.notEqual(blocked.status,'READY');await blocked.close();await ownership.close();
    assert.equal(h.captures.length,0);assert.equal(h.acceptedLive().length,0);
});

test('completed WAL with rolled-back canonical fails closed instead of exposing UNCONSUMED',async t=>{
    const f=await fixture(t),old=await readFile(f.path,'utf8');f.crash('commit-flushed');
    await writeFile(f.path,old);const args=await f.setupRecovery();await assert.rejects(reconcileScheduledEntryLedgerV2(args),/CANONICAL_MISMATCH/);
});

test('canonical next with missing intent fails closed',async t=>{
    const f=await fixture(t);f.crash('replaced');const wal=await readFile(f.path+'.wal','utf8');
    await writeFile(f.path+'.wal',wal.trimEnd().split('\n').slice(0,-1).join('\n')+'\n');
    const args=await f.setupRecovery();await assert.rejects(reconcileScheduledEntryLedgerV2(args),/CANONICAL_MISMATCH/);
});

test('valid but different staging snapshot is never chosen by recovery',async t=>{
    const f=await fixture(t);f.crash('intent-flushed');const state=await inspectV2(f.path);
    await writeFile(f.path+'.'+state.pending.transactionId+'.stage',JSON.stringify(envelope(f.path,state.current))+'\n');
    const args=await f.setupRecovery();await assert.rejects(reconcileScheduledEntryLedgerV2(args),/STAGING_MISMATCH/);
});

test('missing marker and stale reviewed hashes refuse mutation',async t=>{
    const f=await fixture(t);f.crash('intent-flushed');const args=await f.setupRecovery();
    await assert.rejects(reconcileScheduledEntryLedgerV2({...args,expected:{...args.expected,wal:'0'.repeat(64)}}),/EXPECTED_EVIDENCE_MISMATCH/);
    await unlink(f.path+'.bootstrap');args.expected=(await ledgerRecoveryEvidence(args)).hashes;
    await assert.rejects(reconcileScheduledEntryLedgerV2(args));assert.ok(await ordinary(f.path+'.lock'));
});

test('unproven namespace durability blocks a writer before lock acquisition',async t=>{
    const f=await fixture(t),before=await readFile(f.path,'utf8');
    const r=f.make({syncDirectory:()=> 'FILE_SYNC_ONLY'});await r.initialize();
    assert.equal(r.status,'UNAVAILABLE');assert.equal(r.error,'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN');
    assert.equal(await ordinary(f.path+'.lock',{optional:true}),null);assert.equal(await readFile(f.path,'utf8'),before);
});

test('loss of namespace durability during intent never reports consumption success',async t=>{
    const f=await fixture(t);let broken=false;
    const r=f.make({syncDirectory:()=>broken?'FILE_SYNC_ONLY':'DIRECTORY_SYNCED'});await r.initialize();broken=true;
    assert.equal((await r.consume(identity,context)).status,'DURABILITY_UNCERTAIN');
    await r.close();assert.ok(await ordinary(f.path+'.lock'));
});
