import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {eraFixture,testDurability} from '../test-support/NewExecutionEraFixture.js';
import BrowserExecutionOwnership from '../server/autolive/BrowserExecutionOwnership.js';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {ERA_PHASES,eraRecordBytes} from '../server/recovery/ExecutionEraContract.js';
import {seal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {verifyLocalSystemCapabilityProof} from '../server/recovery/LocalSystemCapabilityProof.js';
import {assertNativeTestTarget,registerNativeTestRoot} from '../test-support/NativeTempGuard.mjs';
const states=['AUTHORIZED','FORENSIC_DURABLE','RETIREMENT_DURABLE','ERA_INTENT_DURABLE','LEGACY_ARCHIVED','LEDGER_INITIALIZED','SCHEDULE_BOUND','ERA_ACTIVATED'];
for(let i=0;i<ERA_PHASES.length;i++)test('read-only recovery recognizes '+states[i]+' without creating another era',async t=>{
    const f=await eraFixture(t,{hook:p=>{if(p==='phase:'+ERA_PHASES[i])throw Error('INSPECTION_INTERRUPTION');}});
    assert.equal((await f.writer.inspectRecovery()).state,'NO_TRANSITION');
    await assert.rejects(f.writer.transition(f.authorization),/INSPECTION_INTERRUPTION/);
    const before=await readdir(f.root),view=await f.writer.inspectRecovery({authorization:f.authorization});
    assert.equal(view.state,states[i]);for(const k of ['transitionId','executionEraId','ledgerId','retirementHash'])assert.equal(view[k],f.authorization[k]);
    assert.deepEqual(await readdir(f.root),before);
});
for(const key of ['transitionId','executionEraId','approvedHead','repository','retirementHash','ledgerId'])test('recovery rejects changed authorization '+key,async t=>{
    const f=await eraFixture(t,{hook:p=>{if(p==='phase:authorized')throw Error('INTERRUPT');}});
    await assert.rejects(f.writer.transition(f.authorization),/INTERRUPT/);
    await assert.rejects(f.writer.inspectRecovery({authorization:{...f.authorization,[key]:'foreign'}}),{code:'NEW_ERA_RECOVERY_CONTEXT'});
});
test('native preload refuses real var and traversal before launching helper',async t=>{
    const root=await mkdtemp(join(tmpdir(),'lz-era06-native-'));registerNativeTestRoot(root);
    t.after(async()=>{const r=relative(resolve(tmpdir()),root);assert.ok(r.startsWith('lz-era06-native-')&&!r.startsWith('..')&&!isAbsolute(r));await rm(root,{recursive:true,force:true});});
    assert.throws(()=>registerNativeTestRoot(resolve('var')),{code:'NATIVE_TEST_TARGET_OUTSIDE_TEMP'});
    for(const path of [resolve('var'),join(root,'..','escape'),'relative'])assert.throws(()=>assertNativeTestTarget(path),{code:'NATIVE_TEST_TARGET_OUTSIDE_TEMP'});
    const {spawnSync}=await import('node:child_process');
    assert.throws(()=>spawnSync('windows-ledger-durability.exe',['durable-remove',resolve('var/never-create')]),{code:'NATIVE_TEST_TARGET_OUTSIDE_TEMP'});
    const input=['gate','windows-ledger-durability.exe','pin','durable-remove',resolve('var/never-create')].map(s=>Buffer.from(s).toString('base64')).join('\n')+'\n';
    assert.throws(()=>spawnSync('powershell.exe',[],{input}),{code:'NATIVE_TEST_TARGET_OUTSIDE_TEMP'});
    const alternate=await import('../test-support/NativeTempGuard.mjs?independent-import');
    assert.doesNotThrow(()=>alternate.assertNativeTestTarget(join(root,'allowed')));
    assert.doesNotThrow(()=>assertNativeTestTarget(join(root,'allowed')));
});

test('recovery rejects a resealed foreign predecessor rather than trusting checksum alone',async t=>{
    const f=await eraFixture(t,{hook:p=>{if(p==='phase:forensic')throw Error('INTERRUPT');}});
    await assert.rejects(f.writer.transition(f.authorization),/INTERRUPT/);
    await writeFile(join(f.root,'execution-era','forensic.json'),eraRecordBytes(seal({version:1,phase:'forensic',previous:'foreign',authorization:f.authorization})));
    await assert.rejects(f.writer.inspectRecovery(),{code:'NEW_ERA_RECOVERY_LINEAGE'});
});
test('real LocalSystem proof is current and rejects another service identity without rerunning probe',()=>{
    const directory=process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY;
    assert.ok(directory,'explicit retained proof required');
    assert.equal(verifyLocalSystemCapabilityProof(directory,{serviceIdentity:'LocalSystem'}).status,'PERMANENT DEPLOYABLE PROOF VALID');
    assert.throws(()=>verifyLocalSystemCapabilityProof(directory,{serviceIdentity:'interactive'}),{code:'PERMANENT_PROOF_CONTRACT'});
    assert.throws(()=>verifyLocalSystemCapabilityProof(undefined,{serviceIdentity:'LocalSystem'}),{code:'LOCALSYSTEM_CAPABILITY_PROOF_REQUIRED'});
});

test('production transition requires retained LocalSystem proof before reservation or any persistent mutation',async t=>{
    const f=await eraFixture(t),before=await readdir(f.root);
    let reservations=0;
    const options={...f.options,runtimeCapabilityProof:undefined,
        verifyRuntimeCapability:verifyLocalSystemCapabilityProof,
        host:{...f.options.host,reserve:async()=>{reservations++;throw Error('MUST_NOT_RESERVE');}}};
    await assert.rejects(new NewExecutionEra(options).transition(f.authorization),{code:'LOCALSYSTEM_CAPABILITY_PROOF_REQUIRED'});
    assert.equal(reservations,0);assert.deepEqual(await readdir(f.root),before);
});

test('partial recovery refuses changed retained PROGRAM evidence',async t=>{
    const f=await eraFixture(t,{hook:p=>{if(p==='phase:authorized')throw Error('INTERRUPT');}});
    await assert.rejects(f.writer.transition(f.authorization),/INTERRUPT/);
    await writeFile(f.paths.program,Buffer.concat([await readFile(f.paths.program),Buffer.from(' ')]));
    await assert.rejects(f.writer.inspectRecovery(),{code:'NEW_ERA_EVIDENCE_CHANGED'});
});

test('exact-byte real snapshot DryRun reports unverifiable legacy lock and preserves every TEMP file byte',async t=>{
    const f=await eraFixture(t);
    const capture=async()=>{const names=(await readdir(f.root)).sort();return Promise.all(names.map(async name=>[name,(await readFile(join(f.root,name))).toString('base64')]));};
    const before=await capture(),view=await f.writer.dryRun({expectedInventoryHash:f.view.inventoryHash});
    assert.equal(view.reason,'LEGACY_LEDGER_LOCK_UNVERIFIABLE');
    assert.equal(view.classification,'EXACT_ELIGIBLE_LEGACY_STATE');
    assert.equal(view.eligibleForRealExecution,false);
    assert.equal(view.program.generation,47);assert.equal(view.program.programState,'PRESENT');assert.equal(view.program.acceptedAuthorityEpoch,20);
    assert.deepEqual(await capture(),before);
});

test('read-only owner classification validates durable anchor without claiming live runtime ownership',async t=>{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);
    const owner=new BrowserExecutionOwnership({path:f.paths.authority,eraLedgerPath:f.paths.ledger,eraDurability:testDurability});
    try{
        await owner.ready;assert.equal(owner.available,true,owner.initializationError);
        const view=await f.writer.inspectRecovery();
        assert.equal(view.state,'OWNER_ANCHOR_DURABLE');
        assert.equal(view.liveOwnerStatus,'NOT_PROVEN_BY_READ_ONLY_INSPECTION');
        assert.equal(view.authorityEpoch,23);
    }finally{await owner.close();}
});
