import test from 'node:test';
import assert from 'node:assert/strict';
import {DecoderEvidence, DecoderEvidenceReceiver, validSample, provenance, sameEvidenceGeneration, sha256}
    from '../server/autolive/decoder/DecoderEvidenceContract.js';
import {BoundedLines, decodedLine, decoderArguments, spawnOptions, parseVersion}
    from '../server/autolive/decoder/FFmpegHealthWorker.js';
import {restartDelay} from '../server/autolive/decoder/DecoderSupervisor.js';
import {compareDecoderShadow, DecoderHypotheticalTiming} from '../server/autolive/decoder/DecoderShadowComparison.js';
import {evidence} from '../server/autolive/HeadlessHealthEvidence.js';
import {evaluateReadiness} from '../server/autolive/ExecutionReadinessModel.js';
import {binding} from '../test-support/Phase2ActionFixture.js';

function harness(profile = 'VIDEO_ONLY') {
    let now = 0;
    const model = new DecoderEvidence({sourceId: 'live', sourceFingerprint: 'a'.repeat(64),
        backend: {version: 'verified-fixture-backend', digest: 'b'.repeat(64)}, workerId: 'worker',
        workerGeneration: 1, profile, clock: () => now, wallClock: () => now});
    return {model, clock: () => now, time: n => { now = n; },
        frame: (pts, fields = {}) => model.ingest({kind: 'video', signature: 'yuv420p:96x64', pts,
            workerGeneration: 1, restartGeneration: 0, ...fields})};
}
function signed(sample, changes) {
    const {evidenceDigest, ...body} = {...sample, ...changes};
    return {...body, evidenceDigest: sha256(JSON.stringify(body))};
}

test('version identity requires configure provenance', () => {
    assert.deepEqual(parseVersion('ffmpeg version 4.4\nconfiguration: --enable-gpl\n'), {version: '4.4', configuration: '--enable-gpl'});
    assert.throws(() => parseVersion('ffmpeg version 7.1\nconfiguration: \n'), /PROVENANCE/);
});
test('fixed invocation decodes required streams locally without shell or copy', () => {
    const args = decoderArguments({path: 'C:\\isolated\\a.mkv', format: 'matroska'}, 'AUDIO_VIDEO');
    assert.equal(spawnOptions().shell, false); assert.equal(spawnOptions().windowsHide, true);
    assert.deepEqual(Object.keys(spawnOptions().env), process.platform === 'win32' ? ['SystemRoot'] : ['LANG']);
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
    assert.equal(args[args.indexOf('-format_whitelist') + 1], 'matroska');
    assert.ok(args.includes('showinfo=checksum=0')); assert.ok(args.includes('ashowinfo'));
    assert.ok(args.includes('0:a:0')); assert.ok(args.includes('0:v:0')); assert.ok(args.includes('-re'));
    assert.ok(!args.includes('copy')); assert.ok(!args.some(a => a.endsWith('?')));
});
test('parser accepts actual decoded frame and PCM telemetry, never packets/process liveness', () => {
    assert.deepEqual(decodedLine('[Parsed_ashowinfo_0 @ 0] n:1 pts:1024 pts_time:0.064 fmt:s16 channels:1 chlayout:mono rate:16000 nb_samples:1024'),
        {kind: 'audio', pts: 0.064, count: 1024, signature: 's16:1:mono:16000'});
    assert.equal(decodedLine('frame=10 speed=1.0x total_size=2048'), null);
    assert.equal(decodedLine('[Parsed_showinfo_0 @ 0] config in time_base: 1/1000'), null);
});
test('one decoded frame cannot qualify', () => {
    const h = harness(); h.frame(0); h.time(1000); assert.notEqual(h.model.snapshot().state, 'DECODER_PROGRESS');
});
test('a short decoded burst cannot qualify by waiting after the burst', () => {
    const h = harness(); h.frame(0); h.time(50); h.frame(0.05); h.time(600);
    assert.notEqual(h.model.snapshot().state, 'DECODER_PROGRESS');
});
test('buffered fast decode cannot acquire sustained wall-clock health', () => {
    const h = harness(); h.frame(0); h.time(50); h.frame(1); h.time(100); h.frame(2); h.time(600);
    assert.notEqual(h.model.snapshot().state, 'DECODER_PROGRESS');
});
test('realistic progression qualifies then freshness expires and stalls', () => {
    const h = harness(); h.frame(0); h.time(600); h.frame(0.6);
    assert.equal(h.model.snapshot().state, 'DECODER_PROGRESS');
    h.time(2700); assert.equal(h.model.snapshot().state, 'DECODER_UNCERTAIN');
    h.time(5700); assert.equal(h.model.snapshot().state, 'DECODER_STALLED');
});
test('audio samples are mandatory for A/V; disappearance cannot downgrade profile', () => {
    const h = harness('AUDIO_VIDEO'); h.frame(0); h.time(600); h.frame(0.6);
    assert.notEqual(h.model.snapshot().state, 'DECODER_PROGRESS');
    h.frame(0.6, {kind: 'audio', count: 1024, signature: 'pcm:16000'});
    h.time(1200); h.frame(1.2); h.frame(1.2, {kind: 'audio', count: 1024, signature: 'pcm:16000'});
    assert.equal(h.model.snapshot().state, 'DECODER_PROGRESS');
    for (let n = 2; n < 7; n++) { h.time(n * 600); h.frame(n * 0.6); }
    assert.notEqual(h.model.snapshot().state, 'DECODER_PROGRESS');
    assert.equal(h.model.snapshot().profile, 'AUDIO_VIDEO');
});
test('track-set changes invalidate qualification and advance generation', () => {
    const h = harness(); h.frame(0); h.time(600); h.frame(0.6); const before = h.model.snapshot();
    h.time(1200); h.frame(1.2, {signature: 'yuv420p:192x128'}); const after = h.model.snapshot();
    assert.equal(after.trackSetGeneration, 1); assert.notEqual(after.state, 'DECODER_PROGRESS');
    assert.equal(sameEvidenceGeneration(before, after), false);
});
test('timestamp discontinuity changes provenance, healthy samples do not', () => {
    const h = harness(); h.frame(0); h.time(600); h.frame(0.6); const before = h.model.snapshot();
    h.time(1200); h.frame(1.2); const advancing = h.model.snapshot();
    assert.equal(sameEvidenceGeneration(before, advancing), true);
    assert.notEqual(before.evidenceDigest, advancing.evidenceDigest);
    h.time(1800); h.frame(-1); const discontinuity = h.model.snapshot();
    assert.equal(discontinuity.timestampGeneration, 1); assert.equal(sameEvidenceGeneration(before, discontinuity), false);
});
test('restart/worker generation rejects delayed decoder events', () => {
    const h = harness(); assert.equal(h.frame(0, {workerGeneration: 0}), false);
    assert.equal(h.frame(0, {restartGeneration: 1}), false);
    assert.deepEqual(h.model.snapshot().tracks, {});
});
test('receiver rejects stale, replayed, tampered and old-worker observations', () => {
    const h = harness(), receiver = new DecoderEvidenceReceiver({clock: h.clock});
    receiver.bind({workerId: 'worker', workerGeneration: 1}); const sample = h.model.snapshot();
    assert.equal(receiver.accept(sample), true); assert.equal(receiver.accept(sample), false);
    assert.equal(receiver.accept({...sample, state: 'DECODER_PROGRESS'}), false);
    assert.equal(receiver.accept(signed(sample, {workerGeneration: 2, sequence: 2})), false);
    h.time(2100); assert.equal(receiver.current(), null);
    assert.equal(receiver.accept(signed(sample, {sequence: 3})), false);
});
test('terminal unavailable/error/end cannot become healthy through later telemetry', () => {
    for (const state of ['DECODER_UNAVAILABLE', 'DECODER_ERROR', 'DECODER_ENDED']) {
        const h = harness(); h.model.fail(state, 'TEST_TERMINAL');
        assert.equal(h.frame(0), false); h.time(600); assert.equal(h.frame(0.6), false);
        assert.equal(h.model.snapshot().state, state);
    }
});
test('closed worker evidence cannot revive from cached frames or late telemetry', () => {
    const h = harness(); h.frame(0); h.time(600); h.frame(0.6); assert.equal(h.model.snapshot().state, 'DECODER_PROGRESS');
    h.model.close('DECODER_UNCERTAIN', 'WORKER_STOPPED');
    assert.equal(h.frame(0.7), false); assert.equal(h.model.snapshot().state, 'DECODER_UNCERTAIN');
});
test('bounded parser caps partial lines, cumulative volume and output rate', () => {
    for (const options of [{maxLine: 8}, {maxBytes: 8}, {maxRate: 8}]) {
        let limits = 0; const lines = new BoundedLines(() => {}, () => limits++, options);
        lines.push(Buffer.from('0123456789012345')); lines.push(Buffer.alloc(1000));
        assert.equal(limits, 1); assert.equal(lines.pending, '');
    }
});
test('bounded parser handles chunks split inside a telemetry line', () => {
    const got = []; const lines = new BoundedLines(s => got.push(s), () => assert.fail());
    lines.push(Buffer.from('abc')); lines.push(Buffer.from('def\r\nxyz\n'));
    assert.deepEqual(got, ['abcdef', 'xyz']);
});
test('backoff is explicit, exponential and capped', () => {
    assert.deepEqual([0,1,2,3,4,5,6].map(restartDelay), [1000,2000,4000,8000,16000,30000,30000]);
    assert.throws(() => restartDelay(-1));
});
test('provenance is immutable and cannot be recovered from tampered evidence', () => {
    const h = harness(), sample = h.model.snapshot(), p = provenance(sample);
    assert.equal(validSample(sample), true); assert.equal(Object.isFrozen(p), true);
    assert.throws(() => provenance({...sample, restartGeneration: 99}));
});

function browserSample(current, now, state = 'ONLINE') {
    return evidence({kind: 'BROWSER_PROGRAM', sourceId: current.authorizedSourceId, sourceFingerprint: current.sourceFingerprint,
        authorityEpoch: current.authorityEpoch, authorityProcessSession: current.authorityProcessSession,
        programIdentity: current.programIdentity, ownershipRevision: current.ownershipRevision,
        observedAt: now, validUntil: now + 2000, state, playbackProgressing: state === 'ONLINE', confirmedLoss: state === 'OFFLINE'});
}
test('matching decoded/browser evidence compares healthy but never grants readiness', () => {
    const h = harness(), current = binding(); h.frame(0); h.time(600); h.frame(0.6); const decoder = h.model.snapshot();
    const result = compareDecoderShadow({decoder, browser: browserSample(current, 600), binding: current, now: 600});
    assert.equal(result.classification, 'MATCH_HEALTHY');
    const readiness = evaluateReadiness({expected: current, current, observations: [decoder], now: 600});
    for (const value of [result, readiness]) for (const flag of ['executionAllowed', 'serverTake', 'transferReady']) assert.equal(value[flag], false);
});
test('transport ONLINE with failed decoder disagrees; unavailable decoder is never ready', () => {
    const h = harness(), current = binding(); h.model.fail('DECODER_ERROR', 'MALFORMED_MEDIA');
    const server = evidence({kind: 'EXTERNAL_HLS', sourceId: 'live', sourceFingerprint: current.sourceFingerprint,
        authorityEpoch: 1, authorityProcessSession: 'process', observedAt: 0, validUntil: 2000,
        state: 'ONLINE', presence: true, playlistProgress: true, segmentReachable: true});
    assert.equal(compareDecoderShadow({decoder: h.model.snapshot(), server, binding: current, now: 0}).classification, 'DISAGREEMENT');
    h.model.fail('DECODER_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE');
    const result = compareDecoderShadow({decoder: h.model.snapshot(), browser: browserSample(current, 0), binding: current, now: 0});
    assert.equal(result.classification, 'SERVER_WEAKER'); assert.equal(result.decoderProgress, false);
});
test('hypothetical entry requires full 30s, no fast-forward and no uncertainty carry', () => {
    const h = harness(), current = binding(), timing = new DecoderHypotheticalTiming({clock: h.clock});
    h.frame(0); let result;
    for (let n = 1; n <= 62; n++) {
        h.time(n * 500); h.frame(n * 0.5);
        result = timing.update({decoder: h.model.snapshot(), binding: current, enabled: true, armed: true});
        if (n < 61) assert.equal(result.entryEligible, false);
    }
    assert.equal(result.entryEligible, true); assert.equal(result.executionAllowed, false);
    h.time(40000); result = timing.update({decoder: h.model.snapshot(), binding: current, enabled: true, armed: true});
    assert.equal(result.entryEligible, false); assert.equal(result.entryHealthyMs, 0);
});
test('worker error alone never confirms loss; classified fresh loss preserves >15s boundary', () => {
    const h = harness(), current = binding(), timing = new DecoderHypotheticalTiming({clock: h.clock});
    h.model.fail('DECODER_ERROR', 'WORKER_CRASH'); let result;
    for (let n = 0; n <= 40; n++) {
        h.time(n * 500); result = timing.update({decoder: h.model.snapshot(), binding: current,
            enabled: true, armed: true, liveObserved: true});
        assert.equal(result.lossEligible, false);
    }
    for (let n = 0; n <= 31; n++) {
        h.time(21000 + n * 500); result = timing.update({decoder: h.model.snapshot(), binding: current,
            enabled: true, armed: true, liveObserved: true, lossEvidence: browserSample(current, h.clock(), 'OFFLINE')});
        if (n <= 30) assert.equal(result.lossEligible, false);
    }
    assert.equal(result.lossEligible, true); assert.equal(result.serverTake, false);
});
