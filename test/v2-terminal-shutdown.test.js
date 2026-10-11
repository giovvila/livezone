import test from 'node:test';
import {registerNativeTestRoot} from '../test-support/NativeTempGuard.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ledgerRecoveryEvidence,reconcileScheduledEntryLedgerV2} from '../server/scheduler/ReconcileScheduledEntryLedgerV2.js';
import {inspectV2,envelope,seal,hash,terminalShutdown} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import Repository from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import {scheduledEntryIdentity} from '../server/scheduler/ScheduledEntryIdentity.js';
import {ledgerSnapshot} from '../server/scheduler/ScheduledEntryLedgerContract.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {randomUUID} from 'node:crypto';
import {artifact} from '../server/recovery/RecoveryContract.js';
import {harness,START} from '../test-support/ScheduledEntryHarness.js';
import {offlineWorkflow} from '../test-support/TerminalShutdownFixture.mjs';
const windows={skip:process.platform!=='win32',timeout:180000};
async function removeTemp(path,prefix){const rel=relative(tmpdir(),path);assert.ok(rel.startsWith(prefix)&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(path,{recursive:true,force:true});}
test('R17 exact R16: READY terminal END survives missing companion locks and reconciles without replay',windows,async t=>{
    const root=await mkdtemp(join(tmpdir(),'lz-r17-output-')),output=join(root,'observation.json');t.after(()=>removeTemp(root,'lz-r17-output-'));
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../test-support/TerminalShutdownChild.mjs',import.meta.url)),output],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(child.status,77,child.stdout+child.stderr);
    const h=JSON.parse(await readFile(output,'utf8'));registerNativeTestRoot(h.root);t.after(()=>removeTemp(h.root,'lz-r10-integrity-'));
    assert.ok(h.ready);assert.ok(h.ledgerLock);assert.equal(h.authorityLock,null);assert.equal(h.scheduledLock,null);assert.equal(h.lastType,'END');assert.equal(h.owner,null);assert.equal(h.pending,null);
    assert.throws(()=>process.kill(h.pid,0),{code:'ESRCH'});
    const args={path:h.p.ledger,authorityPath:h.p.authority,scheduledPath:h.p.scheduled,operationId:'r17-exact',proveOffline:async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}]}),reserve:async()=>()=>{}};args.expected=(await ledgerRecoveryEvidence(args)).hashes;
    const before=await ledgerRecoveryEvidence(args),w=offlineWorkflow(h.root,h.p);await assert.rejects(w.workflow.restore());assert.equal(w.calls(),0);
    const result=await reconcileScheduledEntryLedgerV2(args);const after=await ledgerRecoveryEvidence(args);
    for(const key of ['ledger','wal','marker','authority','authorityLock','scheduled','scheduledLock'])assert.equal(after.bytes[key],before.bytes[key],key);
    assert.equal(after.bytes.lock,null);assert.equal(await readFile(result.archive,'utf8'),before.bytes.lock);assert.deepEqual((await inspectV2(h.p.ledger)).current,h.snapshot);
    assert.equal(result.reason,'TERMINAL_SHUTDOWN_ORPHAN');await reconcileScheduledEntryLedgerV2(args);
    const repeat=await controlledStart({workflow:w.workflow,authorizeStart:true,launch:()=>assert.fail('READY retry must not launch')});assert.equal(repeat.owner,null);
    const repo=new Repository({path:h.p.ledger,authority:{authorityEpoch:21,authorityProcessSession:'r17-reopen'}});await repo.initialize();assert.equal(repo.status,'READY',repo.error);
    for(const entry of h.snapshot.entries)assert.equal((await repo.inspect(entry.identity)).status,'ALREADY_CONSUMED');await repo.close();
    await w.workflow.restore();assert.equal(w.calls(),1);
});

const identity=n=>scheduledEntryIdentity({eventId:'r17-'+n,incarnationId:'12345678-1234-1234-1234-123456789abc',entryRevision:1,type:'source.live',sourceId:'camera',startAt:'2026-10-02T12:00:00.000Z',endAt:'2026-10-02T12:05:00.000Z'});
const context={authorityEpoch:22,authorityProcessSession:'r17-unit',consumedAt:'2026-10-02T12:01:00.000Z'};
const unitSync=()=> 'DIRECTORY_SYNCED'; // Isolated protocol/order tests, not a native durability claim.
async function unit(t,{terminal=true,hook=()=>{},operations={}}={}){
    const root=await mkdtemp(join(tmpdir(),'lz-r17-unit-')),path=join(root,'ledger'),authorityPath=join(root,'authority'),scheduledPath=join(root,'scheduled');
    const repo=new Repository({path,create:true,authority:context,syncDirectory:unitSync,hook,operations});
    t.after(async()=>{await repo.close().catch(()=>{});await removeTemp(root,'lz-r17-unit-');});
    await repo.initialize();assert.equal(repo.status,'READY',repo.error);assert.equal((await repo.consume(identity(1),context)).status,'CONSUMED');
    await writeFile(path+'.bootstrap',JSON.stringify({version:1,authorityEpoch:22}));await writeFile(authorityPath,JSON.stringify({epoch:22}));
    if(terminal)await repo.finalize();
    const args={path,authorityPath,scheduledPath,operationId:'unit',proveOffline:async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}]}),reserve:async()=>()=>{},isAlive:()=>false,syncDirectory:unitSync};
    return {root,path,repo,args};
}
for(const kind of ['END absent','END partial','END checksum','pending with END','wrong ledgerId','wrong repositoryId','wrong processSession','wrong authority session','wrong authority epoch','final generation','final hash','WAL after END','recovered END','owner alive','capability unavailable','authority lock incompatible','Scheduled lock incompatible','Scheduled journal without lock','changed before mutation'])test('R17 terminal rejection: '+kind,async t=>{
    const f=await unit(t),wal=await readFile(f.path+'.wal','utf8'),rows=wal.trim().split('\n').map(JSON.parse);const end=rows.at(-1),lock=JSON.parse(await readFile(f.path+'.lock','utf8'));
    const saveRows=()=>writeFile(f.path+'.wal',rows.map(JSON.stringify).join('\n')+'\n');
    if(kind==='END absent'){rows.pop();await saveRows();}
    if(kind==='END partial')await writeFile(f.path+'.wal',wal.slice(0,-3));
    if(kind==='END checksum'){end.checksum='0'.repeat(64);await saveRows();}
    if(kind==='pending with END'){rows.splice(rows.findIndex(r=>r.type==='COMMIT'),1);const updated=[];for(const {checksum,...p} of rows){p.previous=updated.at(-1)?.checksum??null;updated.push(seal(p));}await writeFile(f.path+'.wal',updated.map(JSON.stringify).join('\n')+'\n');}
    if(kind==='wrong ledgerId'){lock.ledgerId=randomUUID();await writeFile(f.path+'.lock',JSON.stringify(lock));}
    if(kind==='wrong repositoryId'){lock.repositoryId='0'.repeat(64);await writeFile(f.path+'.lock',JSON.stringify(lock));}
    if(kind==='wrong processSession'){lock.processSession=randomUUID();await writeFile(f.path+'.lock',JSON.stringify(lock));}
    if(kind==='wrong authority session'){lock.authorityProcessSession='foreign';await writeFile(f.path+'.lock',JSON.stringify(lock));}
    if(kind==='wrong authority epoch')await writeFile(f.args.authorityPath,JSON.stringify({epoch:23}));
    if(kind==='final generation')await writeFile(f.path,JSON.stringify(envelope(f.path,ledgerSnapshot({ledgerId:lock.ledgerId}))));
    if(kind==='final hash'){const {checksum,...p}=end;p.data.snapshotHash='0'.repeat(64);rows[rows.length-1]=seal(p);await saveRows();}
    if(kind==='WAL after END'){const owner={...lock,processSession:randomUUID(),initialGeneration:1,initialLedgerHash:hash(f.repo.snapshot)};rows.push(seal({schemaVersion:2,type:'BEGIN',previous:end.checksum,data:owner}));await saveRows();}
    if(kind==='recovered END'){const {checksum,...p}=end;p.data.recovered=true;rows[rows.length-1]=seal(p);await saveRows();}
    if(kind==='owner alive')f.args.isAlive=()=>true;
    if(kind==='capability unavailable')f.args.syncDirectory=()=> 'FILE_SYNC_ONLY';
    if(kind==='authority lock incompatible')await writeFile(f.args.authorityPath+'.lock',JSON.stringify({pid:lock.pid,authorityProcessSession:'foreign'}));
    if(kind==='Scheduled lock incompatible')await writeFile(f.args.scheduledPath+'.lock',JSON.stringify({schemaVersion:2}));
    if(kind==='Scheduled journal without lock')await writeFile(f.args.scheduledPath,'{}');
    if(kind==='changed before mutation')f.args.hook=async stage=>{if(stage==='prepared')await writeFile(f.path+'.wal',wal+' ');};
    f.args.expected=(await ledgerRecoveryEvidence(f.args)).hashes;const before=await ledgerRecoveryEvidence(f.args);
    await assert.rejects(reconcileScheduledEntryLedgerV2(f.args));const after=await ledgerRecoveryEvidence(f.args);
    for(const key of Object.keys(before.bytes))if(kind!=='changed before mutation'||key!=='wal')assert.equal(after.bytes[key],before.bytes[key],key);
    assert.equal(await artifact(f.path+'.lock.reconciled-unit'),null);
});
test('R17 finalization rejects new admission and drains an in-flight irrevocable intent before END',async t=>{
    let release,entered;const enteredPromise=new Promise(ok=>{entered=ok;}),pause=new Promise(ok=>{release=ok;});
    const f=await unit(t,{terminal:false});const open=f.repo.fs.open;let armed=true;
    f.repo.fs.open=async(...args)=>{if(armed&&args[0]===f.path+'.wal'){armed=false;entered();await pause;}return open(...args);};
    const consume=f.repo.consume(identity(2),context);await enteredPromise;const finalized=f.repo.finalize();
    assert.equal(f.repo.closed,true);const late=f.repo.consume(identity(3),context);release();assert.equal((await consume).status,'CONSUMED');await finalized;assert.equal((await late).status,'UNAVAILABLE');
    const before=await readFile(f.path+'.wal');assert.equal((await f.repo.consume(identity(4),context)).status,'UNAVAILABLE');assert.deepEqual(await readFile(f.path+'.wal'),before);
    const state=await inspectV2(f.path);assert.equal(state.current.generation,2);assert.equal(terminalShutdown(state,f.repo.lockOwner),true);assert.equal(state.records.at(-1).type,'END');await f.repo.close();
});
test('R17 terminal barrier failure keeps an owned ledger fail closed and cannot finalize twice',async t=>{
    const f=await unit(t,{terminal:false});f.repo.syncDirectory=()=> 'FILE_SYNC_ONLY';
    await assert.rejects(f.repo.finalize(),{code:'LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN'});assert.equal(f.repo.status,'DURABILITY_UNCERTAIN');assert.ok(await artifact(f.path+'.lock'));await assert.rejects(f.repo.finalize());
});
test('R17 changed terminal WAL after archival cannot receive a recovery completion',async t=>{
    const f=await unit(t),wal=await readFile(f.path+'.wal','utf8');f.args.expected=(await ledgerRecoveryEvidence(f.args)).hashes;
    f.args.hook=async stage=>{if(stage==='archived')await writeFile(f.path+'.wal',wal+' ');};
    await assert.rejects(reconcileScheduledEntryLedgerV2(f.args),{code:'LEDGER_V2_TERMINAL_CHANGED'});
    assert.ok(await artifact(f.path+'.lock.reconciled-unit'));assert.equal(await artifact(f.path+'.recovery-unit.json.completed'),null);
});
test('R17 admission close during an irrevocable consume prevents Scheduled capture before terminal END',async t=>{
    let h,armed=false,terminalized;
    h=await harness(t,{serverOptions:{scheduledEntryLedgerOptions:{protocolVersion:2,syncDirectory:unitSync,hook:stage=>{
        if(armed&&stage==='before-replace'){armed=false;h.owner.scheduledEntry.close();terminalized=h.owner.scheduledEntry.ledger.finalize();}
    }}}});
    armed=true;h.fire(START+1);await h.settle();await terminalized;
    assert.equal(h.owner.scheduledEntry.ledger.status,'TERMINAL');assert.equal(h.owner.scheduledEntry.ledger.snapshot.generation,1);assert.equal(h.captures.length,0);assert.equal(h.acceptedLive().length,0);
});
for(const point of ['before-admission','during-drain','after-drain-before-END','during-END','after-END-fsync','after-terminal-barrier','before-ledger-release','after-ledger-release','before-Scheduled-release','after-Scheduled-release','before-authority-release','after-authority-release'])test('R17 actual shutdown interruption: '+point,windows,async t=>{
    const root=await mkdtemp(join(tmpdir(),'lz-r17-output-')),output=join(root,'observation.json');t.after(()=>removeTemp(root,'lz-r17-output-'));
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../test-support/TerminalShutdownChild.mjs',import.meta.url)),output,point],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(child.status,77,child.stdout+child.stderr);
    const h=JSON.parse(await readFile(output,'utf8'));registerNativeTestRoot(h.root);t.after(()=>removeTemp(h.root,'lz-r10-integrity-'));assert.throws(()=>process.kill(h.pid,0),{code:'ESRCH'});
    assert.equal(h.lastType==='END',!['before-admission','during-drain','after-drain-before-END'].includes(point));
    if(['before-admission','during-drain','after-drain-before-END','during-END','after-END-fsync','after-terminal-barrier','before-Scheduled-release'].includes(point)){assert.ok(h.authorityLock);assert.ok(h.scheduledLock);}
    if(point==='after-ledger-release'){assert.equal(h.ledgerLock,null);assert.equal(h.authorityLock,null);assert.equal(h.scheduledLock,null);return;}
    const args={path:h.p.ledger,authorityPath:h.p.authority,scheduledPath:h.p.scheduled,operationId:'matrix',proveOffline:async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}]}),reserve:async()=>()=>{}};args.expected=(await ledgerRecoveryEvidence(args)).hashes;
    const before=await ledgerRecoveryEvidence(args),result=await reconcileScheduledEntryLedgerV2(args);assert.equal((await ledgerRecoveryEvidence(args)).bytes.ledger,before.bytes.ledger);assert.deepEqual((await inspectV2(h.p.ledger)).current,h.snapshot);
    if(h.lastType==='END'){assert.equal((await ledgerRecoveryEvidence(args)).bytes.wal,before.bytes.wal);assert.equal(result.reason,'TERMINAL_SHUTDOWN_ORPHAN');}
    else assert.equal(result.reason,'STABLE_ORPHAN');
});
