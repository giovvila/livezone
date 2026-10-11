import test from 'node:test';
import {registerNativeTestRoot} from '../test-support/NativeTempGuard.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import Ledger from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import Scheduled from '../server/scheduler/ScheduledLiveExecutionRepository.js';
import {completedTransaction,fixtureProgram} from '../test-support/CompletedScheduledHistoryFixture.mjs';
import {completedScheduledHistory,journalEnvelope,journalMatchesLock} from '../server/scheduler/ScheduledExecutionProvenance.js';
import {ledgerRecoveryEvidence,reconcileScheduledEntryLedgerV2} from '../server/scheduler/ReconcileScheduledEntryLedgerV2.js';
import {inspectV2,terminalShutdown,hash} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {artifact} from '../server/recovery/RecoveryContract.js';
import {offlineWorkflow} from '../test-support/TerminalShutdownFixture.mjs';
import {harness,START} from '../test-support/ScheduledEntryHarness.js';
const unitSync=()=> 'DIRECTORY_SYNCED'; // Protocol fixture only; no native durability claim.
const reseal=value=>{const {checksum,...payload}=value;return {...payload,checksum:hash(payload)};};
async function removeTemp(root,prefix){const rel=relative(tmpdir(),root);assert.ok(rel.startsWith(prefix)&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});}
async function fixture(t,{lock=false}={}) {
    const root=await mkdtemp(join(tmpdir(),'lz-r18-unit-')),path=join(root,'ledger'),scheduledPath=join(root,'scheduled'),authorityPath=join(root,'authority');
    const authority={available:true,closed:false,path:authorityPath,authorityEpoch:22,authorityProcessSession:'r18-unit'};
    const ledger=new Ledger({path,create:true,authority,syncDirectory:unitSync});
    const scheduled=new Scheduled({path:scheduledPath,publicRoot:join(root,'public'),authority});
    t.after(async()=>{await scheduled.close();await ledger.close().catch(()=>{});await removeTemp(root,'lz-r18-unit-');});
    await writeFile(authorityPath,JSON.stringify({epoch:22}));await writeFile(path+'.bootstrap',JSON.stringify({version:1,authorityEpoch:22}));
    await ledger.initialize();assert.equal(ledger.status,'READY',ledger.error);
    await scheduled.initialize();assert.equal(scheduled.status,'READY',scheduled.error);
    await scheduled.write(completedTransaction());await ledger.finalize();
    const owner=scheduled.owner;if(!lock)await scheduled.close();
    const args={path,authorityPath,scheduledPath,operationId:'completed',proveOffline:async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}]}),reserve:async()=>()=>{},isAlive:()=>false,syncDirectory:unitSync};
    return {root,path,authorityPath,scheduledPath,ledger,scheduled,owner,args};
}
test('R18 exact R17 blocker: valid COMPLETED history survives legitimate Scheduled close and ledger reconciliation',async t=>{
    const f=await fixture(t),before=await ledgerRecoveryEvidence(f.args);f.args.expected=before.hashes;
    assert.equal(before.bytes.scheduledLock,null);assert.equal(before.bytes.authorityLock,null);
    assert.equal(terminalShutdown(await inspectV2(f.path),f.ledger.lockOwner),true);
    journalMatchesLock(before.bytes.scheduled,f.owner);
    const result=await reconcileScheduledEntryLedgerV2(f.args);assert.equal(result.reason,'TERMINAL_LEDGER_WITH_COMPLETED_SCHEDULED_HISTORY');
    const after=await ledgerRecoveryEvidence(f.args);for(const key of Object.keys(before.bytes))if(key!=='lock')assert.equal(after.bytes[key],before.bytes[key],key);
    assert.equal(after.bytes.lock,null);assert.equal(await readFile(result.archive,'utf8'),before.bytes.lock);
    await reconcileScheduledEntryLedgerV2(f.args);
});
for(const kind of ['CAPTURED','PREROLL','LIVE','POSTROLL','RETURN_PENDING','ABORTED','RECOVERY_BLOCKED','PREPARED','malformed','checksum','repository','authority epoch','authority session','authority repository','invalid publisher','contradictory captured PROGRAM','unexpected lock','duplicate journal','staging conflict','journal race','namespace race','owner alive','durability unavailable'])test('R18 completed history rejection: '+kind,async t=>{
    const f=await fixture(t),value=JSON.parse(await readFile(f.scheduledPath,'utf8'));
    const owner={...f.owner};let tx={...completedTransaction()};
    if(['CAPTURED','PREROLL','LIVE','POSTROLL','RETURN_PENDING','ABORTED','RECOVERY_BLOCKED','PREPARED'].includes(kind)){
        tx.state=kind;tx.reason=kind==='ABORTED'?'MANUAL_INTENT_DOMINATES':kind==='RECOVERY_BLOCKED'?'RECOVERY_RECONCILIATION_REQUIRED':null;
        if(kind==='PREPARED')await writeFile(f.scheduledPath,JSON.stringify({...value,transaction:{...value.transaction,record:tx}}));
        else await writeFile(f.scheduledPath,JSON.stringify(journalEnvelope(tx,owner)));
    }
    if(kind==='malformed')await writeFile(f.scheduledPath,'{');
    if(kind==='checksum')await writeFile(f.scheduledPath,JSON.stringify({...value,checksum:'0'.repeat(64)}));
    if(kind==='repository')owner.repositoryId='0'.repeat(64);
    if(kind==='authority epoch')owner.authorityEpoch=21;
    if(kind==='authority session')owner.authorityProcessSession='foreign';
    if(kind==='authority repository')owner.authorityId='0'.repeat(64);
    if(['repository','authority epoch','authority session','authority repository'].includes(kind))await writeFile(f.scheduledPath,JSON.stringify(journalEnvelope(tx,owner)));
    if(kind==='invalid publisher'||kind==='contradictory captured PROGRAM'){
        // Preserve both journal checksums so these faults must be rejected by
        // captured PROGRAM identity validation, not incidental corruption.
        if(kind==='invalid publisher')value.transaction.record.capturedProgram.publisherSessionId='foreign-header';
        else value.transaction.record.capturedProgram.revision++;
        value.transaction=reseal(value.transaction);await writeFile(f.scheduledPath,JSON.stringify(reseal(value)));
    }
    if(kind==='unexpected lock')await writeFile(f.scheduledPath+'.lock',JSON.stringify({...owner,authorityProcessSession:'foreign'}));
    const conflictingPath=process.platform==='win32'?f.scheduledPath.toUpperCase():f.scheduledPath;
    if(kind==='duplicate journal')await writeFile(conflictingPath+'.OTHER.JSON',JSON.stringify(value));
    if(kind==='staging conflict')await writeFile(conflictingPath+'.FOREIGN.TMP',JSON.stringify(value));
    if(kind==='journal race')f.args.hook=async stage=>{if(stage==='prepared')await writeFile(f.scheduledPath,JSON.stringify(journalEnvelope(completedTransaction(fixtureProgram('different-manual')),owner)));};
    if(kind==='namespace race')f.args.hook=async stage=>{if(stage==='prepared')await writeFile(f.scheduledPath+'.new.json',JSON.stringify(value));};
    if(kind==='owner alive')f.args.isAlive=()=>true;
    if(kind==='durability unavailable')f.args.syncDirectory=()=> 'FILE_SYNC_ONLY';
    const before=await ledgerRecoveryEvidence(f.args);f.args.expected=before.hashes;
    await assert.rejects(reconcileScheduledEntryLedgerV2(f.args),
        kind==='invalid publisher'||kind==='contradictory captured PROGRAM'?{code:'INVALID_PROGRAM_ENVELOPE'}:undefined);
    const after=await ledgerRecoveryEvidence(f.args);for(const key of Object.keys(before.bytes))if(kind!=='journal race'||key!=='scheduled')assert.equal(after.bytes[key],before.bytes[key],key);
    assert.equal(await artifact(f.path+'.lock.reconciled-completed'),null);
});
test('R18 compatible retained Scheduled lock remains a separate ownership obligation',async t=>{
    const f=await fixture(t,{lock:true});await writeFile(f.authorityPath+'.lock',JSON.stringify({pid:process.pid,authorityProcessSession:'r18-unit'}));
    const before=await ledgerRecoveryEvidence(f.args);f.args.expected=before.hashes;
    const result=await reconcileScheduledEntryLedgerV2(f.args);assert.equal(result.reason,'TERMINAL_SHUTDOWN_ORPHAN');
    assert.equal((await ledgerRecoveryEvidence(f.args)).bytes.scheduledLock,before.bytes.scheduledLock);
});
test('R18 D10 captured publisher is not final PROGRAM identity or an executable entry key',async t=>{
    const f=await fixture(t),bytes=await readFile(f.scheduledPath,'utf8');
    const history=completedScheduledHistory(bytes,{scheduledPath:f.scheduledPath,authorityPath:f.authorityPath,ledgerLock:f.ledger.lockOwner});
    assert.equal(history.state,'COMPLETED');assert.notEqual(f.owner.processSession,f.ledger.lockOwner.processSession);
    assert.equal(f.ledger.snapshot.generation,0); // Diagnostic transactions need not be ledger consumptions.
});
test('R18 Scheduled drain freezes new writes and preserves already admitted terminal history',async t=>{
    const f=await fixture(t,{lock:true});const writing=f.scheduled.write(completedTransaction(fixtureProgram('latest'))),drained=f.scheduled.drainForShutdown();
    await assert.rejects(f.scheduled.write(completedTransaction()));await writing;await drained;
    assert.equal(f.scheduled.record.capturedProgram.publisherSessionId,'latest');assert.ok(await artifact(f.scheduledPath+'.lock'));
});
test('R18 completed journal changed after archival cannot receive completion or a successful retry',async t=>{
    const f=await fixture(t);f.args.expected=(await ledgerRecoveryEvidence(f.args)).hashes;
    f.args.hook=async stage=>{if(stage==='archived')await writeFile(f.scheduledPath,JSON.stringify(journalEnvelope(completedTransaction(fixtureProgram('changed')),f.owner)));};
    await assert.rejects(reconcileScheduledEntryLedgerV2(f.args),{code:'LEDGER_V2_POST_ARCHIVE_EVIDENCE_CHANGED'});
    assert.ok(await artifact(f.path+'.lock.reconciled-completed'));assert.equal(await artifact(f.path+'.recovery-completed.json.completed'),null);
    f.args.hook=()=>{};await assert.rejects(reconcileScheduledEntryLedgerV2(f.args),{code:'LEDGER_V2_PROVENANCE_CHANGED'});
});
test('R18 journal changes during END prevent shutdown from releasing companion witnesses',async t=>{
    let armed=false,h;
    h=await harness(t,{serverOptions:{scheduledEntryLedgerOptions:{protocolVersion:2,syncDirectory:unitSync,hook:stage=>{
        if(armed&&stage==='end-flushed'){
            armed=false;const repo=h.owner.scheduledLiveExecutionRepository;
            writeFileSync(repo.path,JSON.stringify(journalEnvelope(completedTransaction(fixtureProgram('changed')),repo.owner)));
        }
    }}}});
    await h.owner.scheduledLiveExecutionRepository.write(completedTransaction());armed=true;
    const paths=[h.owner.scheduledEntry.ledger.path+'.lock',h.owner.scheduledLiveExecutionRepository.path+'.lock',h.owner.executionOwnership.path+'.lock'];
    const before=await Promise.all(paths.map(p=>readFile(p,'utf8')));
    const error=await new Promise(done=>h.owner.server.close(done));assert.equal(error.code,'LEDGER_V2_SCHEDULED_SHUTDOWN_CHANGED');
    for(let i=0;i<paths.length;i++)assert.equal(await readFile(paths[i],'utf8'),before[i]);
    await h.owner.scheduledEntry.ledger.close();await h.owner.scheduledLiveExecutionRepository.close();await h.owner.executionOwnership.close();
});
test('R18 active Scheduled shutdown retains all witnesses for normal offline recovery',async t=>{
    const h=await harness(t,{serverOptions:{scheduledEntryLedgerOptions:{protocolVersion:2,syncDirectory:unitSync}}});
    h.fire(START+1);await h.settle();assert.equal(h.owner.scheduledLiveExecutionRepository.record.state,'LIVE');
    const paths=[h.owner.scheduledEntry.ledger.path+'.lock',h.owner.scheduledLiveExecutionRepository.path+'.lock',h.owner.executionOwnership.path+'.lock'];
    const before=await Promise.all(paths.map(p=>readFile(p,'utf8')));
    const error=await new Promise(done=>h.owner.server.close(done));assert.equal(error.code,'LEDGER_V2_TERMINAL_SCHEDULED_UNRESOLVED');
    for(let i=0;i<paths.length;i++)assert.equal(await readFile(paths[i],'utf8'),before[i]);
    assert.equal((await inspectV2(h.owner.scheduledEntry.ledger.path)).records.at(-1).type,'COMMIT');
    // Explicit TEMP teardown after asserting the retained-witness contract.
    await h.owner.scheduledEntry.ledger.close();await h.owner.scheduledLiveExecutionRepository.close();await h.owner.executionOwnership.close();
});
for(const point of ['before-Scheduled-release','after-Scheduled-release','before-authority-release','after-authority-release','before-ledger-release'])test('R18 native READY completed history shutdown: '+point,{skip:process.platform!=='win32',timeout:180000},async t=>{
    const root=await mkdtemp(join(tmpdir(),'lz-r18-output-')),output=join(root,'observation.json');t.after(()=>removeTemp(root,'lz-r18-output-'));
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('../test-support/CompletedScheduledHistoryChild.mjs',import.meta.url)),output,point],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(child.status,77,child.stdout+child.stderr);
    const h=JSON.parse(await readFile(output,'utf8'));registerNativeTestRoot(h.root);t.after(()=>removeTemp(h.root,'lz-r10-integrity-'));assert.throws(()=>process.kill(h.pid,0),{code:'ESRCH'});
    assert.ok(h.ready);assert.ok(h.ledgerLock);assert.equal(h.scheduled.value.transaction.record.state,'COMPLETED');assert.equal(h.lastType,'END');assert.equal(h.pending,null);assert.equal(h.owner,null);
    assert.deepEqual(h.programAfter,h.programBefore);
    assert.equal(h.captures,0);assert.equal(h.executions,0);
    const args={path:h.p.ledger,authorityPath:h.p.authority,scheduledPath:h.p.scheduled,operationId:'r18-native',proveOffline:async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}]}),reserve:async()=>()=>{}};
    const before=await ledgerRecoveryEvidence(args);args.expected=before.hashes;
    const w=offlineWorkflow(h.root,h.p);await assert.rejects(w.workflow.restore());assert.equal(w.calls(),0);
    const result=await reconcileScheduledEntryLedgerV2(args),after=await ledgerRecoveryEvidence(args);
    for(const key of Object.keys(before.bytes))if(key!=='lock')assert.equal(after.bytes[key],before.bytes[key],key);
    assert.deepEqual(await artifact(h.p.program),h.programBefore);
    assert.equal(result.reason,h.scheduledLock?'TERMINAL_SHUTDOWN_ORPHAN':'TERMINAL_LEDGER_WITH_COMPLETED_SCHEDULED_HISTORY');
    if(h.authorityLock||h.scheduledLock){await assert.rejects(w.workflow.restore());assert.equal(w.calls(),0);}
    else {await w.workflow.restore();assert.equal(w.calls(),1);}
});
