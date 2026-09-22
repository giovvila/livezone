import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Transfer, {bindTransferState, compareTransferCAS, acceptedProgramIdentity, STATES} from '../server/autolive/ExecutionTransferContract.js';
import {evaluateReadiness, CAPABILITIES, compareDecisionPaths} from '../server/autolive/ExecutionReadinessModel.js';
import {recoveryRecord, inspectRecovery, CRASH_POINTS, TIMING, timingContinuity, futurePriority} from '../server/autolive/ExecutionRecoveryContract.js';
import Ownership from '../server/autolive/BrowserExecutionOwnership.js';
import Shadow from '../server/autolive/AutoLiveDecisionShadow.js';
import ActiveHealth from '../public/js/studio/AutoLiveActiveHealth.js';
import {AUTO_LIVE_ENTRY_STABILITY_MS} from '../public/js/studio/AutoLiveEntryPolicy.js';
import {AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS} from '../public/js/studio/AutoLivePostTakePolicy.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';

const fp = 'a'.repeat(64);
function envelope(revision = 1) {
    const at = '2026-01-01T00:00:00.000Z';
    return createProgramOutputEnvelope({version: 1, publisherSessionId: 'publisher', revision, publishedAt: at, committedAt: at,
        scene: {id: 'LIVE', name: 'Live', type: 'LIVE'}, source: {id: 'live', kind: 'hls', url: 'https://example.test/live.m3u8'},
        playback: {initialTime: 0, duration: 120, playing: true, ended: false, state: 'playing', startedAt: at},
        graphics: {items: []}, transition: {type: 'cut', durationMs: 0}});
}
function binding(change = {}) {
    return bindTransferState({authorityEpoch: 1, authorityProcessSession: 'process', ownershipRevision: 1,
        durableGeneration: 1, configRevision: 1, manualIntentRevision: 0, recoveryRevision: 0, actionRevision: 0,
        programStatus: 'PRESENT', acceptedProgram: envelope(), authorizedSourceId: 'live', sourceFingerprint: fp,
        schedulerExecution: 'SUSPENDED', ...change});
}
function prepared() {
    const b = binding(), model = new Transfer({ownerInstanceId: 'tab-a', binding: b});
    const result = model.prepare({transferId: 'transfer', operatorAuthorized: true, ownerInstanceId: 'tab-a',
        leaseValid: true, current: b, now: 0, expiresAt: 60000});
    assert.equal(result.state, 'TRANSFER_PREPARING');
    return {b, model, released: {...b, ownershipRevision: 2}};
}
function fenced() {
    const h = prepared();
    assert.equal(h.model.fence({current: h.released, now: 1, ownerInstanceId: 'tab-a', ownerPresent: false,
        oldGrantRejected: true, pendingRequestsFenced: true, exclusiveAuthority: true}).state, 'NO_OWNER_FENCED');
    return h;
}
function observation(kind, changes = {}) {
    return {kind, sourceId: 'live', sourceFingerprint: fp, authorityEpoch: 1, authorityProcessSession: 'process',
        observedAt: 0, validUntil: 10000, state: 'ONLINE', playlistProgress: true, segmentReachable: true,
        playbackProgressing: true, programIdentity: binding().programIdentity, ownershipRevision: 1, ...changes};
}
function record(changes = {}) {
    const b = binding();
    return recoveryRecord({actionId: 'action', actionType: 'TAKE', origin: b, phase: 'AFTER_RESERVATION', commitStatus: 'RESERVED',
        authorizedSourceId: b.authorizedSourceId, sourceFingerprint: fp, configRevision: b.configRevision,
        manualIntentRevision: 0, authorityEpoch: 1, ownershipRevision: 1, actionRevision: 0,
        decisionEvidenceDigest: fp, decisionEvidence: {kind: 'ACTIVE_PROGRAM', state: 'ONLINE', observedAt: 0, validUntil: 10000, decoderProgress: true},
        returnEligibility: 'CAPTURED',
        interruptedTarget: {sceneId: 'media-scene', sourceId: 'media', programIdentity: fp, cue: 27, playbackState: 'PLAYING'}, ...changes});
}

test('explicit transfer has a fenced intermediate state and never a server executor', () => {
    const {model, released} = fenced();
    const r = model.evaluate({current: released, now: 2, ownerPresent: false, exclusiveAuthority: true,
        readiness: {executionAllowed: true, transferReady: true, blockers: []}});
    assert.equal(r.state, 'SERVER_CANDIDATE'); assert.equal(r.executionAllowed, false); assert.equal(r.transferReady, false);
    assert.equal(r.serverTake, false); assert.ok(Object.isFrozen(r.candidate.expected));
    assert.ok(!STATES.includes('SERVER_OWNER')); assert.equal(model.binding.ownershipRevision, 1);
});
test('no direct browser to candidate transition', () => {
    const model = new Transfer({ownerInstanceId: 'tab-a', binding: binding()});
    assert.equal(model.evaluate({}).state, 'TRANSFER_BLOCKED');
});
for (const changes of [{operatorAuthorized: false}, {operatorAuthorized: 'true'}, {leaseValid: false}, {ownerInstanceId: 'tab-b'}, {expiresAt: 60001}])
    test('preparation rejects missing authorization/owner/lease or unbounded lifetime ' + JSON.stringify(changes), () => {
        const b = binding(), model = new Transfer({ownerInstanceId: 'tab-a', binding: b});
        assert.equal(model.prepare({transferId: 'transfer', operatorAuthorized: true, ownerInstanceId: 'tab-a', leaseValid: true,
            current: b, now: 0, expiresAt: 60000, ...changes}).state, 'TRANSFER_BLOCKED');
    });
for (const field of ['authorityEpoch','authorityProcessSession','ownershipRevision','durableGeneration','programIdentity',
    'publisherSessionId','programRevision','configRevision','authorizedSourceId','sourceFingerprint','manualIntentRevision',
    'recoveryRevision','actionRevision','schedulerExecution']) test('CAS rejects changed ' + field, () => {
    const {model, released} = fenced(); const current = {...released, [field]: typeof released[field] === 'number' ? released[field] + 1 : 'changed'};
    assert.equal(compareTransferCAS(released, current).matches, false);
    assert.equal(model.evaluate({current, now: 2, ownerPresent: false, exclusiveAuthority: true}).state, 'TRANSFER_BLOCKED');
});
test('projection advances without CAS drift but accepted envelope/metadata revision invalidates', () => {
    const a = binding(), b = binding({projectedCurrentTime: 32}); assert.deepEqual(a, b);
    assert.equal(compareTransferCAS(a, binding({acceptedProgram: envelope(2), durableGeneration: 2})).matches, false);
    const newer = structuredClone(envelope()); newer.snapshot.playback.initialTime = 42;
    assert.notEqual(acceptedProgramIdentity(newer), a.programIdentity);
});
for (const status of ['UNAVAILABLE','UNRESOLVED','CORRUPT']) test('missing authority is not empty: ' + status, () => {
    assert.throws(() => binding({programStatus: status}));
});
test('explicit accepted empty is distinct and safe to bind', () => {
    const e = structuredClone(envelope()); e.snapshot.scene = null; e.snapshot.source = null;
    assert.equal(binding({acceptedProgram: e, programStatus: 'EXPLICIT_EMPTY'}).programStatus, 'EXPLICIT_EMPTY');
    assert.throws(() => binding({acceptedProgram: e}));
});
for (const proof of ['oldGrantRejected','pendingRequestsFenced','exclusiveAuthority']) test('fencing requires ' + proof, () => {
    const {model, released} = prepared();
    assert.equal(model.fence({current: released, now: 1, ownerInstanceId: 'tab-a', ownerPresent: false,
        oldGrantRejected: true, pendingRequestsFenced: true, exclusiveAuthority: true, [proof]: false}).state, 'TRANSFER_BLOCKED');
});
test('lost acknowledgement repeats observation without another grant or lease extension', () => {
    const {model, released} = fenced(), args = {current: released, now: 2, ownerPresent: false, exclusiveAuthority: true};
    const first = model.evaluate(args); assert.deepEqual(model.evaluate(args), first);
    assert.equal(first.candidate.expiresAt, 60000);
    assert.equal(model.evaluate({...args, now: 60000}).state, 'TRANSFER_BLOCKED');
});
test('reconnecting browser/competing executor invalidates candidate', () => {
    const {model, released} = fenced();
    assert.equal(model.evaluate({current: released, now: 2, ownerPresent: true, exclusiveAuthority: true}).state, 'TRANSFER_BLOCKED');
});
for (const kind of Object.keys(CAPABILITIES)) test(kind + ' can never establish headless decoder equivalence', () => {
    const b = binding(), r = evaluateReadiness({expected: b, current: b, observations: [observation(kind)], now: 1});
    assert.equal(r.executionAllowed, false); assert.equal(r.transferReady, false); assert.equal(r.serverTake, false);
    assert.equal(r.evidence[0].headlessEquivalent, false);
    assert.ok(r.blockers.includes('HEADLESS_DECODER_EQUIVALENCE_UNPROVEN'));
    assert.equal(r.evidence[0].decoderProgress, ['BROWSER_DECODER','ACTIVE_PROGRAM'].includes(kind));
});
for (const change of [{validUntil: 1}, {observedAt: 2}, {authorityEpoch: 2}, {authorityProcessSession: 'old'}])
    test('freshness rejects stale/future/old process evidence ' + JSON.stringify(change), () => {
        const b = binding(), r = evaluateReadiness({expected: b, current: b, observations: [observation('ACTIVE_PROGRAM', change)], now: 1});
        assert.ok(r.blockers.includes('STALE_EVIDENCE')); assert.equal(r.evidence[0].decoderProgress, false);
    });
test('fingerprint/source changes and forged capabilities cannot promote HTTP evidence', () => {
    const b = binding(), r = evaluateReadiness({expected: b, current: b, now: 1,
        observations: [observation('EXTERNAL_HLS', {sourceFingerprint: 'b'.repeat(64), decoderEquivalent: true, token: 'secret'})]});
    assert.ok(r.blockers.includes('SOURCE_IDENTITY_MISMATCH')); assert.equal(r.evidence[0].decoderProgress, false);
    assert.doesNotMatch(JSON.stringify(r), /secret|https:/);
});
for (const point of CRASH_POINTS) test('recovery inspection never replays at ' + point, () => {
    const r = inspectRecovery(record(), binding(), point);
    assert.equal(r.replayAllowed, false); assert.equal(r.returnAllowed, false); assert.equal(r.executionAllowed, false);
});
test('committed action with lost ACK observes commit, never repeats TAKE or RETURN', () => {
    const committed = binding({acceptedProgram: envelope(2), durableGeneration: 2});
    for (const actionType of ['TAKE', 'RETURN']) {
        const r = inspectRecovery(record({actionType, commitStatus: 'COMMITTED', committedProgramIdentity: committed.programIdentity}), committed, 'AFTER_PROGRAM_COMMIT');
        assert.equal(r.disposition, 'OBSERVE_COMMIT_DO_NOT_REPLAY'); assert.equal(r.replayAllowed, false);
    }
});
test('new manual intent invalidates pending transfer, readiness, action and RETURN', () => {
    const {model, released} = fenced(), current = {...released, manualIntentRevision: 1};
    assert.equal(model.evaluate({current, now: 2, ownerPresent: false, exclusiveAuthority: true}).state, 'TRANSFER_BLOCKED');
    assert.ok(evaluateReadiness({expected: released, current, now: 2}).blockers.includes('STALE_CAS'));
    for (const actionType of ['ENTRY','TAKE','RETURN']) assert.equal(inspectRecovery(record({actionType}), current, 'BEFORE_RETURN').disposition, 'INVALIDATED_BY_MANUAL_INTENT');
});
test('no fabricated return target or unproved committed action', () => {
    assert.throws(() => record({interruptedTarget: null}));
    assert.throws(() => record({commitStatus: 'COMMITTED'}));
    assert.equal(record({returnEligibility: 'NONE', interruptedTarget: null}).interruptedTarget, null);
});
for (const event of ['BROWSER_RELOAD','OWNER_TRANSFER','SERVER_RESTART','PROCESS_CRASH']) test('timing boundary resets unproven timers: ' + event, () => {
    const r = timingContinuity(event); assert.equal(r.inheritEntryAccumulation, false); assert.equal(r.inheritLossDeadline, false);
    assert.equal(r.retainedLiveIdentityMayBeAdopted, true); assert.equal(r.executionAllowed, false);
});
test('timing constants match browser policies without making shadow executable', () => {
    assert.equal(TIMING.entryMs, AUTO_LIVE_ENTRY_STABILITY_MS); assert.equal(TIMING.confirmedLossMs, AUTOLIVE_POST_TAKE_CONFIRMED_LOSS_MS);
    assert.equal(TIMING.shadowExecutable, false);
});
test('scheduler proposed priority respects manual, ownership, AutoLive and captured return', () => {
    for (const [input, expected] of [[{manualPending: true}, 'MANUAL'], [{}, 'FENCED'],
        [{ownerValid: true, autoLiveActive: true}, 'AUTOLIVE'], [{ownerValid: true, interruptionActive: true}, 'NO_MANUFACTURED_RETURN'],
        [{ownerValid: true, interruptionActive: true, returnTargetValid: true}, 'VALIDATE_RETURN_CAS'], [{ownerValid: true}, 'SCHEDULER_CANDIDATE']]) {
        const r = futurePriority(input); assert.equal(r.proposedPriority, expected); assert.equal(r.schedulerExecution, 'SUSPENDED'); assert.equal(r.executionAllowed, false);
    }
});

test('bindings reject malformed revisions, unknown fields and secret-bearing identities', () => {
    for (const change of [{authorityEpoch: 0}, {actionRevision: -1}, {sourceFingerprint: 'https://secret.invalid'},
        {schedulerExecution: 'RUNNING'}, {durableGeneration: NaN}]) assert.throws(() => binding(change));
    assert.throws(() => new Transfer({ownerInstanceId: 'tab', binding: {...binding(), leaseSecret: 'secret'}}));
    assert.throws(() => record({origin: {...binding(), token: 'secret'}}));
});
test('evidence diagnostics are bounded, immutable and reject unknown producer', () => {
    const b = binding(), r = evaluateReadiness({expected: b, current: b, now: 1,
        observations: Array.from({length: 20}, () => observation('untrusted', {url: 'https://secret.invalid', token: 'secret'}))});
    assert.equal(r.evidence.length, 8); assert.ok(Object.isFrozen(r.evidence[0]));
    assert.ok(r.blockers.includes('EVIDENCE_BOUNDS')); assert.ok(r.blockers.includes('UNKNOWN_PRODUCER'));
    assert.doesNotMatch(JSON.stringify(r), /secret|https:/);
});
test('active playback must bind current Program and ownership revision', () => {
    const b = binding();
    for (const change of [{programIdentity: 'b'.repeat(64)}, {ownershipRevision: 2}]) {
        const r = evaluateReadiness({expected: b, current: b, now: 1, observations: [observation('ACTIVE_PROGRAM', change)]});
        assert.ok(r.blockers.includes('PROGRAM_BINDING_MISMATCH')); assert.equal(r.transferReady, false);
    }
});
test('pre-reservation, ambiguous commit and no-return recovery stay distinct', () => {
    assert.equal(inspectRecovery(record({commitStatus: 'NOT_RESERVED'}), binding(), 'BEFORE_RESERVATION').disposition, 'NO_ACTION_RESERVED');
    assert.equal(inspectRecovery(record({commitStatus: 'UNKNOWN'}), binding(), 'AFTER_PROGRAM_COMMIT').disposition, 'RECONCILE_REQUIRED');
    assert.equal(inspectRecovery(record({interruptedTarget: null, returnEligibility: 'NONE'}), binding(), 'BEFORE_RETURN').returnAllowed, false);
});

test('real ownership: two tabs, duplicate process, delayed grant, release and new restart epoch', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'lz-transfer-')), path = join(dir, 'authority');
    const all = []; t.after(async () => { for (const a of all.reverse()) await a.close(); await rm(dir, {recursive: true, force: true}); });
    let now = 0; const first = new Ownership({path, clock: () => now}); all.push(first); await first.ready;
    const a = await first.operate({operation: 'acquire', ownerInstanceId: 'a', publisherSessionId: 'pub-a'}, 'operator');
    const b = await first.operate({operation: 'acquire', ownerInstanceId: 'b', publisherSessionId: 'pub-b'}, 'operator');
    assert.ok(a.grant); assert.equal(b.grant, null);
    const duplicate = new Ownership({path, clock: () => now}); all.push(duplicate); await duplicate.ready;
    assert.equal(duplicate.available, false); assert.equal(duplicate.matches(a.grant, 'operator'), false);
    await duplicate.close();
    now = 15000; assert.equal(Boolean(first.matches(a.grant, 'operator')), false);
    const newOwner = await first.operate({operation: 'acquire', ownerInstanceId: 'b', publisherSessionId: 'pub-b'}, 'operator');
    assert.ok(newOwner.grant);
    first.revokeForManual('manual-publisher');
    assert.equal(Boolean(first.matches(newOwner.grant, 'operator')), false);
    assert.equal(first.snapshot().reason, 'MANUAL_OVERRIDE');
    await first.operate({operation: 'release', grant: newOwner.grant}, 'operator');
    assert.equal(Boolean(first.matches(newOwner.grant, 'operator')), false);
    await first.close();
    const restart = new Ownership({path, clock: () => now}); all.push(restart); await restart.ready;
    assert.equal(restart.authorityEpoch, 2); assert.equal(restart.snapshot().reason, 'RESTART_RECONCILIATION_REQUIRED');
    assert.equal(Boolean(restart.matches(a.grant, 'operator')), false);
    assert.equal((await restart.operate({operation: 'acquire', ownerInstanceId: 'c', publisherSessionId: 'pub-c'}, 'operator')).grant, null);
});

function activeFixture() {
    let now = 0;
    const video = Object.assign(new EventTarget(), {currentTime: 0, readyState: 4, paused: false, ended: false});
    const c = {started: true, generation: 1, session: {sessionId: 'retained', sourceId: 'live', sceneId: 'LIVE', phase: 'LIVE', retained: true},
        clock: () => now, clearTimer() {}, executionOwnership: {valid: () => true}, lossTimer: null, lossGraceMs: 5000,
        renderer: {program: {renderer: {sourceId: 'live', video}}}, command: {stateManager: {getProgramSceneId: () => 'LIVE'}},
        externalObservation: {state: 'ONLINE'}, health: {state: 'CHECKING'},
        acceptActiveHealth(owner, state) { this.health = {state}; }};
    const owner = c.activeHealth = new ActiveHealth(c); owner.observe();
    return {c, owner, video, advance(ms, progress = false) { now += ms; if (progress) { video.currentTime += ms / 1000; video.dispatchEvent(new Event('timeupdate')); } owner.check(); }, now: () => now};
}
for (const transportState of ['ONLINE','OFFLINE','UNCERTAIN']) test('real active browser versus shadow: transport ' + transportState, () => {
    const h = activeFixture(), shadow = new Shadow({clock: h.now}), b = binding();
    h.c.externalObservation.state = transportState;
    h.advance(250, true);
    const out = shadow.update({enabled: true, armed: true, sourceId: 'live', sourceFingerprint: fp, browserStage: 'LIVE',
        health: {state: transportState, freshness: 'FRESH', validUntil: h.now() + 10000}});
    const readiness = evaluateReadiness({expected: b, current: b, now: h.now(), observations: [observation('EXTERNAL_HLS', {state: transportState}), observation('ACTIVE_PROGRAM')]});
    assert.equal(h.c.health.state, 'ONLINE'); assert.equal(h.owner.projected, true); assert.equal(h.owner.canClose(), false);
    const report = compareDecisionPaths({browser: {sourceIdentityMatches: true, healthState: h.c.health.state, entryEligible: false,
        lossEligible: h.owner.canClose(), uncertain: false, programIdentity: b.programIdentity},
        shadow: {sourceIdentityMatches: true, healthState: transportState, entryEligible: out.entryEligible, lossEligible: out.lossEligible, uncertain: out.state === 'LIVE_UNCERTAIN'}, readiness, programIdentity: b.programIdentity});
    if (transportState !== 'ONLINE') assert.ok(report.differences.includes('DECODER_PROGRESS_WITH_NONONLINE_TRANSPORT'));
    assert.equal(readiness.transferReady, false); h.owner.destroy();
});
test('HTTP healthy but actual Program decoder stalled: uncertainty is not normalized to ONLINE', () => {
    const h = activeFixture(); h.advance(250, true); h.advance(30000, false);
    assert.equal(h.c.health.state, 'CHECKING'); assert.equal(h.owner.canClose(), false);
    const shadow = new Shadow({clock: h.now});
    assert.equal(shadow.update({enabled: true, armed: true, sourceId: 'live', sourceFingerprint: fp, browserStage: 'LIVE',
        health: {state: 'ONLINE', freshness: 'FRESH', validUntil: h.now() + 10000}}).state, 'LIVE_OBSERVED');
    const b = binding(), r = evaluateReadiness({expected: b, current: b, now: 1, observations: [observation('EXTERNAL_HLS')]});
    assert.ok(r.blockers.includes('NO_DECODER_PROGRESS')); h.owner.destroy();
});
test('actual confirmed loss reaches 15 seconds while shadow strict boundary remains diagnostic', () => {
    const h = activeFixture(), shadow = new Shadow({clock: h.now});
    h.c.externalObservation.state = 'OFFLINE'; h.advance(2000);
    const sample = () => shadow.update({enabled: true, armed: true, sourceId: 'live', sourceFingerprint: fp, browserStage: 'LIVE',
        health: {state: 'OFFLINE', freshness: 'FRESH', validUntil: h.now() + 10000}});
    sample(); h.advance(14999); assert.equal(h.owner.canClose(), false); assert.equal(sample().lossEligible, false);
    h.advance(1); assert.equal(h.owner.canClose(), true); assert.equal(sample().lossEligible, false);
    h.advance(1); assert.equal(sample().lossEligible, true);
    h.advance(250, true); assert.equal(h.owner.canClose(), false); assert.equal(h.owner.confirmedSince, null);
    h.owner.destroy();
});
test('new contracts are not wired into production bootstrap or authority', async () => {
    for (const path of ['server/program-output-server.js','server/autolive/AutoLiveAuthority.js','public/js/entries/control-room-app.js'])
        assert.doesNotMatch(await readFile(path, 'utf8'), /ExecutionTransferContract|ExecutionReadinessModel|ExecutionRecoveryContract/);
});
