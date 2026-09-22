import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import Repository from '../server/autolive/ActionTransactionRepository.js';
import Model, {inspectAction, ACTION_STATES} from '../server/autolive/ActionTransactionModel.js';
import Transfer, {compareTransferCAS} from '../server/autolive/ExecutionTransferContract.js';
import ProgramRepository from '../server/program-output/DurableProgramRepository.js';
import ProgramStore from '../server/program-output/ProgramOutputStore.js';
import Coordinator from '../server/program-output/ProgramCommitCoordinator.js';
import {fixture, action, binding, program} from '../test-support/Phase2ActionFixture.js';

async function begin(t) {
    const h = await fixture(t); h.origin = h.current(); h.target = binding(program('hls', 2), 2);
    await h.model.reserve(action(h.origin)); return h;
}
async function commit(h) {
    await h.model.transition('begin-commit', 1, h.target);
    // Only the isolated test driver calls the existing DP1 coordinator. The action model cannot.
    const result = await h.coordinator.accept(program('hls', 2), {check: () => compareTransferCAS(h.origin, h.current()).matches});
    assert.equal(result.accepted, true); return result;
}
async function reopen(h) {
    await h.journal.close();
    const repository = new Repository({path: h.path}); h.journals.push(repository); await repository.initialize();
    return {repository, model: new Model({repository, current: h.current})};
}
function child(script, args = []) {
    return new Promise((resolve, reject) => {
        const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script, ...args], {cwd: globalThis.process.cwd(), windowsHide: true, stdio: ['ignore','pipe','pipe']});
        let output = ''; process.stdout.on('data', v => output += v); process.stderr.on('data', v => output += v);
        process.on('error', reject); process.on('exit', code => resolve({code, output}));
    });
}
test('all transaction states are non-executing; full durable sequence references DP1 only', async t => {
    const h = await fixture(t); assert.equal(h.model.inspect().state, 'NONE');
    const seen = ['NONE']; const origin = h.current(), target = binding(program('hls', 2), 2), returned = binding(program('media', 3), 3);
    const state = r => { seen.push(r.state); assert.equal(h.model.inspect().executionAllowed, false); };
    state(await h.model.reserve(action(origin))); state(await h.model.transition('begin-commit', 1, target));
    assert.equal(h.store.getCurrent().revision, 1);
    assert.equal((await h.coordinator.accept(program('hls', 2), {check: () => true})).accepted, true);
    state(await h.model.transition('observe-commit', 2)); state(await h.model.transition('activate-model', 3));
    state(await h.model.transition('prepare-return', 4, returned));
    assert.equal(h.store.getCurrent().revision, 2);
    assert.equal((await h.coordinator.accept(program('media', 3), {check: () => true})).accepted, true);
    state(await h.model.transition('observe-return', 5));
    assert.deepEqual(seen, ACTION_STATES.slice(0, 7));
    const {model} = await reopen(h); assert.equal(model.inspect().state, 'COMPLETED'); assert.equal(model.inspect().returnAllowed, false);
    const disk = await readFile(h.path, 'utf8'); assert.doesNotMatch(disk, /https?:|leaseId|token|snapshot|"envelope"/);
});

const crashPoints = ['before-reservation','after-reservation','after-final-CAS','during-program-staging',
    'after-program-before-journal','after-journal','during-active','during-loss','before-return',
    'after-return-commit','before-completion-marker'];
for (const point of crashPoints) test('restart inspection at ' + point + ' never replays', async t => {
    const h = await fixture(t), origin = h.current(), target = binding(program('hls', 2), 2), returned = binding(program('media', 3), 3);
    if (point !== 'before-reservation') await h.model.reserve(action(origin));
    if (!['before-reservation','after-reservation'].includes(point)) await h.model.transition('begin-commit', 1, target);
    if (point === 'during-program-staging') h.repository.hook = stage => { if (stage === 'staged') throw Error('simulated crash'); };
    const committed = ['after-program-before-journal','after-journal','during-active','during-loss','before-return','after-return-commit','before-completion-marker'].includes(point);
    if (committed || point === 'during-program-staging') assert.equal((await h.coordinator.accept(program('hls', 2), {check: () => true})).accepted, committed);
    if (committed && point !== 'after-program-before-journal') await h.model.transition('observe-commit', 2);
    if (['during-active','during-loss','before-return','after-return-commit','before-completion-marker'].includes(point)) await h.model.transition('activate-model', 3);
    if (['before-return','after-return-commit','before-completion-marker'].includes(point)) await h.model.transition('prepare-return', 4, returned);
    if (['after-return-commit','before-completion-marker'].includes(point)) await h.coordinator.accept(program('media', 3), {check: () => true});
    const r = await reopen(h);
    const programRepository = new ProgramRepository({path: h.programPath}), store = new ProgramStore();
    await new Coordinator({repository: programRepository, store, validate: async () => true}).initialize();
    const current = binding(store.getCurrent(), programRepository.record.generation);
    const first = inspectAction(r.repository.record, current);
    assert.deepEqual(inspectAction(r.repository.record, current), first);
    assert.equal(first.executionAllowed, false); assert.equal(first.replayAllowed, false); assert.equal(first.returnAllowed, false);
    if (point === 'before-reservation') assert.equal(first.disposition, 'NO_RESERVATION');
    else if (['after-return-commit','before-completion-marker'].includes(point)) assert.equal(first.disposition, 'RETURN_COMMITTED_DO_NOT_REPLAY');
    else if (committed) assert.equal(first.disposition, 'PROGRAM_COMMITTED_DO_NOT_REPLAY');
    else assert.equal(first.disposition, 'UNCOMMITTED_DO_NOT_REPLAY');
});
test('lost ACK, duplicate reservation and stale action revision cannot duplicate progress', async t => {
    const h = await begin(t); const bytes = await readFile(h.path, 'utf8');
    const duplicate = await h.model.reserve(action(h.origin)); assert.equal(duplicate.duplicate, true);
    assert.equal(await readFile(h.path, 'utf8'), bytes);
    await commit(h); assert.equal(h.model.inspect().disposition, 'PROGRAM_COMMITTED_DO_NOT_REPLAY');
    await assert.rejects(h.model.transition('observe-commit', 1), {code: 'ACTION_REVISION_CONFLICT'});
    await h.model.transition('observe-commit', 2);
    await assert.rejects(h.model.transition('observe-commit', 2), {code: 'INVALID_ACTION_TRANSITION'});
    assert.equal(h.store.getCurrent().revision, 2);
});
for (const field of ['manualIntentRevision','authorityEpoch','ownershipRevision','configRevision','recoveryRevision','actionRevision','sourceFingerprint','authorityProcessSession'])
    test('pending work is invalidated by ' + field, async t => {
        const h = await begin(t); h.fields[field] = typeof h.origin[field] === 'number' ? h.origin[field] + 1 : 'b'.repeat(64);
        await assert.rejects(h.model.transition('begin-commit', 1, h.target), {code: 'STALE_ACTION_CAS'});
        const r = await h.model.invalidate(1); assert.equal(r.state, field === 'manualIntentRevision' ? 'ABORTED' : 'RECOVERY_BLOCKED');
        assert.equal(h.model.inspect().executionAllowed, false); assert.equal(h.store.getCurrent().revision, 1);
    });
test('manual intent during journal staging fails final CAS without installing new action state', async t => {
    const h = await begin(t); h.journal.hook = stage => { if (stage === 'staged') h.fields.manualIntentRevision = 1; };
    await assert.rejects(h.model.transition('begin-commit', 1, h.target), {code: 'STALE_ACTION_CAS'});
    assert.equal(h.journal.record.state, 'RESERVED'); assert.equal(h.store.getCurrent().revision, 1);
});
test('manual intent during DP1 staging prevents Program commit; after commit prevents automatic RETURN', async t => {
    const h = await begin(t); await h.model.transition('begin-commit', 1, h.target);
    h.repository.hook = stage => { if (stage === 'staged') h.fields.manualIntentRevision = 1; };
    assert.equal((await h.coordinator.accept(program('hls', 2), {check: () => compareTransferCAS(h.origin, h.current()).matches})).accepted, false);
    assert.equal(h.store.getCurrent().revision, 1);
    h.fields.manualIntentRevision = 0; h.repository.hook = () => {};
    await h.coordinator.accept(program('hls', 2), {check: () => true}); await h.model.transition('observe-commit', 2);
    await h.model.transition('activate-model', 3); h.fields.manualIntentRevision = 1;
    assert.equal(h.model.inspect().disposition, 'MANUAL_INTENT_DOMINATES');
    await assert.rejects(h.model.transition('prepare-return', 4, binding(program('media', 3), 3)), {code: 'STALE_ACTION_CAS'});
});
test('new genuine Program generation blocks candidate even with the same source', async t => {
    const h = await begin(t); await h.coordinator.accept(program('media', 2), {check: () => true});
    await assert.rejects(h.model.transition('begin-commit', 1, h.target), {code: 'STALE_ACTION_CAS'});
    assert.equal(h.model.inspect().disposition, 'RECONCILIATION_REQUIRED');
});
test('fenced Phase-1 candidate plus durable action cannot become an executor', async t => {
    const h = await fixture(t), before = h.current(), transfer = new Transfer({ownerInstanceId: 'tab', binding: before});
    transfer.prepare({transferId: 'transfer', operatorAuthorized: true, ownerInstanceId: 'tab', leaseValid: true, current: before, now: 0, expiresAt: 60000});
    h.fields.ownershipRevision = 2; const current = h.current();
    transfer.fence({current, now: 1, ownerInstanceId: 'tab', ownerPresent: false, oldGrantRejected: true, pendingRequestsFenced: true, exclusiveAuthority: true});
    const candidate = transfer.evaluate({current, now: 2, ownerPresent: false, exclusiveAuthority: true});
    await h.model.reserve(action(current));
    const r = h.model.evaluateCandidate(candidate); assert.equal(r.candidateState, 'SERVER_CANDIDATE'); assert.equal(r.executionAllowed, false);
    assert.equal(compareTransferCAS(before, current).matches, false); // stale browser/return CAS cannot cross release
    h.fields.ownershipRevision = 3; assert.equal(h.model.inspect().disposition, 'RECONCILIATION_REQUIRED');
});
for (const bad of ['{', '{}', 'oversized', 'checksum', 'schema']) test('journal corruption fails closed: ' + bad, async t => {
    const h = await begin(t); await h.journal.close(); let bytes = await readFile(h.path, 'utf8');
    if (bad === 'oversized') bytes = 'x'.repeat(32769);
    else if (bad === 'checksum') { const value = JSON.parse(bytes); value.record.reservedAt++; bytes = JSON.stringify(value); }
    else if (bad === 'schema') { const value = JSON.parse(bytes); value.schemaVersion = 99; bytes = JSON.stringify(value); }
    else bytes = bad;
    await writeFile(h.path, bytes); const r = await reopen(h);
    assert.equal(r.repository.status, 'CORRUPT'); assert.equal(r.model.inspect().disposition, 'ACTION_UNAVAILABLE');
    assert.equal(await readFile(h.path, 'utf8'), bytes);
    await assert.rejects(r.model.reserve(action()), {code: 'ACTION_UNAVAILABLE'});
});
test('public path and illegal journal transition rejected', async t => {
    assert.throws(() => new Repository({path: resolve('public/action.json')}), {code: 'PRIVATE_ACTION_PATH_REQUIRED'});
    const h = await begin(t);
    await assert.rejects(h.journal.write(1, {...h.journal.record, state: 'ACTIVE', actionRevision: 2}, () => true));
});
test('two actual processes cannot open the same action journal writer', async t => {
    const h = await begin(t);
    const script = `import Repository from './server/autolive/ActionTransactionRepository.js';
        const r=new Repository({path:process.argv[1]}); await r.initialize(); console.log(r.status); await r.close();`;
    const result = await child(script, [h.path]); assert.equal(result.code, 0); assert.equal(result.output.trim(), 'LOCKED');
    assert.equal(h.model.inspect().executionAllowed, false);
});
for (const stage of ['staged','replaced']) test('actual child exit at journal ' + stage + ' retains canonical old/new state and abandoned lock', async t => {
    const h = await begin(t); await h.journal.close();
    const script = `import {fixture,binding,program} from './test-support/Phase2ActionFixture.js';
        const h=await fixture(null,process.argv[1]); h.journal.hook=s=>{if(s===process.argv[2])process.exit(73)};
        await h.model.transition('begin-commit',1,binding(program('hls',2),2));`;
    const result = await child(script, [h.dir, stage]); assert.equal(result.code, 73, result.output);
    let r = await reopen(h); assert.equal(r.repository.status, 'LOCKED');
    // Explicit fixture-only operator step AFTER verified child exit. Never automatic lock breaking.
    await unlink(h.path + '.lock'); r = await reopen(h); assert.equal(r.repository.status, 'READY');
    assert.equal(r.repository.record.state, stage === 'staged' ? 'RESERVED' : 'COMMITTING');
    assert.equal(r.model.inspect().replayAllowed, false);
});
for (const stage of ['opened','written','flushed','staged','replaced']) test('journal failure at ' + stage + ' cannot publish Program', async t => {
    const h = await begin(t); h.journal.hook = s => { if (s === stage) throw Error('injected storage failure'); };
    await assert.rejects(h.model.transition('begin-commit', 1, h.target));
    assert.equal(h.store.getCurrent().revision, 1);
    if (stage === 'replaced') {
        assert.equal(h.journal.status, 'RECOVERY_BLOCKED');
        await assert.rejects(h.model.transition('begin-commit', 1, h.target), {code: 'ACTION_UNAVAILABLE'});
    }
    const r = await reopen(h); assert.equal(r.repository.record.state, stage === 'replaced' ? 'COMMITTING' : 'RESERVED');
});
for (const returning of [false, true]) test('actual crash after DP1 ' + (returning ? 'RETURN' : 'TAKE') + ' commit before action marker', async t => {
    const h = await begin(t); await h.journal.close();
    const script = `import {fixture,binding,program} from './test-support/Phase2ActionFixture.js';
        const h=await fixture(null,process.argv[1]);
        await h.model.transition('begin-commit',1,binding(program('hls',2),2));
        await h.coordinator.accept(program('hls',2),{check:()=>true});
        if(process.argv[2]==='return'){
          await h.model.transition('observe-commit',2);await h.model.transition('activate-model',3);
          await h.model.transition('prepare-return',4,binding(program('media',3),3));
          await h.coordinator.accept(program('media',3),{check:()=>true});
        } process.exit(74);`;
    const result = await child(script, [h.dir, returning ? 'return' : 'take']); assert.equal(result.code, 74, result.output);
    // Child is proven exited; remove only this isolated fixture's abandoned lock.
    await unlink(h.path + '.lock'); const r = await reopen(h);
    const repository = new ProgramRepository({path: h.programPath}), store = new ProgramStore();
    await new Coordinator({repository, store, validate: async () => true}).initialize();
    const current = binding(store.getCurrent(), repository.record.generation), observation = inspectAction(r.repository.record, current);
    assert.equal(observation.disposition, returning ? 'RETURN_COMMITTED_DO_NOT_REPLAY' : 'PROGRAM_COMMITTED_DO_NOT_REPLAY');
    assert.equal(observation.replayAllowed, false); assert.equal(store.getCurrent().revision, returning ? 3 : 2);
    assert.equal(inspectAction(r.repository.record, {...current, manualIntentRevision: 1}).disposition, 'MANUAL_INTENT_DOMINATES');
});
