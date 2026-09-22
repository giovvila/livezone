import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, writeFile, rm, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import FFmpegHealthWorker, {localFixture, verifyBackend} from '../server/autolive/decoder/FFmpegHealthWorker.js';
import DecoderSupervisor from '../server/autolive/decoder/DecoderSupervisor.js';
import {validSample} from '../server/autolive/decoder/DecoderEvidenceContract.js';
import {LOCAL_BACKEND, fixtures, alive} from '../test-support/DecoderLocalFixture.js';
import {compareDecoderShadow} from '../server/autolive/decoder/DecoderShadowComparison.js';
import {evidence} from '../server/autolive/HeadlessHealthEvidence.js';
import {evaluateReadiness} from '../server/autolive/ExecutionReadinessModel.js';
import {binding} from '../test-support/Phase2ActionFixture.js';

let fixture;
before(async () => { fixture = await fixtures(); });
after(async () => { await fixture?.close(); });

async function start(t, name, profile) {
    const worker = new FFmpegHealthWorker({backend: LOCAL_BACKEND, fixtureRoot: fixture.root,
        fixturePath: fixture.paths[name], profile, maxRuntimeMs: 20000});
    const samples = []; worker.on('observation', sample => samples.push(sample));
    t.after(() => worker.stop()); await worker.start(); return {worker, samples};
}
async function until(predicate, timeout = 12000) {
    const end = Date.now() + timeout;
    while (!predicate()) { if (Date.now() >= end) throw Error('OBSERVATION_TIMEOUT'); await delay(50); }
}

test('installed backend identity matches reviewed hash and exposes full configuration', () => {
    assert.equal(fixture.backend.digest, LOCAL_BACKEND.digest);
    assert.match(fixture.backend.version, /^n4\.4\.1-50-ga4e1dd6940-20220302/);
    assert.match(fixture.backend.configuration, /--enable-gpl/);
});
test('wrong binary digest is rejected before invocation', async () => {
    await assert.rejects(verifyBackend({...LOCAL_BACKEND, digest: '0'.repeat(64)}), /DIGEST_MISMATCH/);
});
for (const [name, profile, tracks] of [['av', 'AUDIO_VIDEO', ['audio', 'video']],
    ['audio', 'AUDIO_ONLY', ['audio']], ['video', 'VIDEO_ONLY', ['video']]]) {
    test(`real ${profile} decode progresses and naturally ends without an orphan`, async t => {
        const {worker, samples} = await start(t, name, profile);
        await until(() => samples.some(s => s.state === 'DECODER_PROGRESS'));
        const decoded = samples.find(s => s.state === 'DECODER_PROGRESS'), now = Date.now();
        const current = binding(undefined, 1, {authorizedSourceId: decoded.sourceId, sourceFingerprint: decoded.sourceFingerprint});
        const browser = evidence({kind: 'BROWSER_PROGRAM', sourceId: decoded.sourceId, sourceFingerprint: decoded.sourceFingerprint,
            authorityEpoch: current.authorityEpoch, authorityProcessSession: current.authorityProcessSession,
            programIdentity: current.programIdentity, ownershipRevision: current.ownershipRevision,
            observedAt: now, validUntil: now + 2000, state: 'ONLINE', playbackProgressing: true});
        const comparison = compareDecoderShadow({decoder: decoded, browser, binding: current, now});
        assert.equal(comparison.classification, 'MATCH_HEALTHY');
        const readiness = evaluateReadiness({expected: current, current, observations: [decoded], now});
        for (const result of [comparison, readiness]) for (const flag of ['executionAllowed', 'serverTake', 'transferReady']) assert.equal(result[flag], false);
        if (name === 'av' && process.platform === 'win32') {
            assert.ok(Number.isInteger(worker.pid));
            const command = `Get-Process -Id ${worker.pid} | Select-Object Id,CPU,WorkingSet64,PeakWorkingSet64 | ConvertTo-Json -Compress`;
            const {stdout} = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
                {windowsHide: true, timeout: 5000, maxBuffer: 8192});
            const measurement = JSON.parse(stdout.trim());
            assert.equal(measurement.Id, worker.pid); assert.ok(measurement.WorkingSet64 > 0);
            t.diagnostic(`Windows process observation (not a production benchmark): ${JSON.stringify(measurement)}`);
        }
        const result = await worker.closed;
        const progress = samples.find(s => s.state === 'DECODER_PROGRESS');
        assert.deepEqual(Object.keys(progress.tracks).sort(), tracks);
        for (const track of tracks) { assert.ok(progress.tracks[track].frames >= 2); assert.ok(progress.tracks[track].count >= 2); }
        assert.equal(validSample(progress), true); assert.equal(progress.executionAllowed, false);
        assert.equal(result.sample.state, 'DECODER_ENDED'); assert.equal(result.sample.reason, 'NATURAL_END');
        assert.equal(alive(worker.pid), false);
    });
}
test('real malformed media errors and never qualifies', async t => {
    const {worker, samples} = await start(t, 'malformed', 'AUDIO_VIDEO'); const result = await worker.closed;
    assert.equal(result.sample.state, 'DECODER_ERROR');
    assert.equal(samples.some(s => s.state === 'DECODER_PROGRESS'), false); assert.equal(alive(worker.pid), false);
});
test('real unsupported required profile is unavailable, not silently audio-only', async t => {
    const {worker, samples} = await start(t, 'audio', 'AUDIO_VIDEO'); const result = await worker.closed;
    assert.equal(result.sample.state, 'DECODER_UNAVAILABLE');
    assert.equal(result.sample.reason, 'REQUIRED_PROFILE_UNAVAILABLE');
    assert.equal(samples.some(s => s.state === 'DECODER_PROGRESS'), false);
});
test('real timestamp-gap fixture stalls, invalidates timestamp generation, then ends', async t => {
    const {worker, samples} = await start(t, 'stall', 'VIDEO_ONLY'); await worker.closed;
    assert.ok(samples.some(s => s.state === 'DECODER_STALLED'), JSON.stringify(samples.map(s => [s.state, s.tracks.video?.pts])));
    assert.ok(samples.some(s => s.timestampGeneration > 0));
    assert.equal(samples.at(-1).state, 'DECODER_ENDED'); assert.equal(alive(worker.pid), false);
});
test('unexpected real worker termination is an error and leaves no tested orphan', async t => {
    const {worker, samples} = await start(t, 'video', 'VIDEO_ONLY');
    await until(() => samples.some(s => s.state === 'DECODER_PROGRESS'));
    assert.equal(worker.child.kill('SIGKILL'), true); const result = await worker.closed;
    assert.equal(result.sample.state, 'DECODER_ERROR'); assert.equal(alive(worker.pid), false);
});
test('graceful FFmpeg stop closes within 5s and leaves no tested orphan', async t => {
    const {worker, samples} = await start(t, 'video', 'VIDEO_ONLY');
    await until(() => samples.some(s => s.state === 'DECODER_PROGRESS'));
    const at = Date.now(), result = await worker.stop();
    assert.ok(Date.now() - at < 5000); assert.equal(result.code, 0);
    assert.equal(result.sample.state, 'DECODER_UNCERTAIN'); assert.equal(alive(worker.pid), false);
});
test('forced FFmpeg stop closes within 5s and leaves no tested orphan', async t => {
    const {worker} = await start(t, 'video', 'VIDEO_ONLY'); const at = Date.now();
    await worker.stop(true); assert.ok(Date.now() - at < 5000); assert.equal(alive(worker.pid), false);
});
test('graceful stop escalates when the FFmpeg command pipe is unavailable', async t => {
    const {worker, samples} = await start(t, 'video', 'VIDEO_ONLY');
    await until(() => samples.some(s => s.state === 'DECODER_PROGRESS'));
    worker.child.stdin.end(); await delay(50);
    const at = Date.now(), result = await worker.stop();
    assert.ok(Date.now() - at >= 1900); assert.ok(Date.now() - at < 5000);
    assert.equal(result.signal, 'SIGKILL'); assert.equal(alive(worker.pid), false);
    assert.equal(result.sample.state, 'DECODER_UNCERTAIN');
});
test('experiment runtime is bounded and budget expiry cannot revive progress', async t => {
    const worker = new FFmpegHealthWorker({backend: LOCAL_BACKEND, fixtureRoot: fixture.root,
        fixturePath: fixture.paths.video, profile: 'VIDEO_ONLY', maxRuntimeMs: 1000});
    t.after(() => worker.stop()); await worker.start(); const result = await worker.closed;
    assert.equal(result.sample.state, 'DECODER_UNAVAILABLE'); assert.equal(result.sample.reason, 'EXPERIMENT_TIME_LIMIT');
    assert.equal(alive(worker.pid), false);
});
test('independent worker objects share a process-local single-worker fence', async t => {
    const {worker} = await start(t, 'video', 'VIDEO_ONLY');
    const second = new FFmpegHealthWorker({backend: LOCAL_BACKEND, fixtureRoot: fixture.root,
        fixturePath: fixture.paths.video, profile: 'VIDEO_ONLY'});
    await assert.rejects(second.start(), /ONE_WORKER_LIMIT/); await worker.stop();
});
test('cancellation during verified startup never launches a decode worker', async () => {
    const worker = new FFmpegHealthWorker({backend: LOCAL_BACKEND, fixtureRoot: fixture.root,
        fixturePath: fixture.paths.video, profile: 'VIDEO_ONLY'});
    const starting = worker.start(); await worker.stop(); await assert.rejects(starting, /WORKER_CANCELLED/);
    assert.equal(worker.pid, undefined);
});
test('private diagnostics ring is bounded and contains no raw stderr', async t => {
    const {worker} = await start(t, 'malformed', 'VIDEO_ONLY'); await worker.closed;
    for (let n = 0; n < 100; n++) worker.diagnostic('TEST_BOUNDED');
    assert.equal(worker.diagnostics.length, 64);
    assert.ok(worker.diagnostics.every(d => Object.keys(d).join(',') === 'code,at'));
});
test('supervisor permits only one worker and fences restart generations', async t => {
    const supervisor = new DecoderSupervisor({backend: LOCAL_BACKEND, fixtureRoot: fixture.root,
        fixturePath: fixture.paths.video, profile: 'VIDEO_ONLY', maxRuntimeMs: 20000});
    t.after(() => supervisor.stop());
    const firstStart = supervisor.start(); await assert.rejects(supervisor.start(), /ONE_WORKER_LIMIT/);
    const first = await firstStart; await supervisor.stop(); assert.equal(alive(first.pid), false);
    await assert.rejects(supervisor.start(), /RESTART_BACKOFF/); await delay(1050);
    const second = await supervisor.start();
    assert.equal(second.workerGeneration, 2); assert.equal(second.restartGeneration, 1);
    assert.notEqual(first.evidence.identity.workerId, second.evidence.identity.workerId);
    await supervisor.stop(); assert.equal(alive(second.pid), false);
});
test('local boundary rejects remote URLs, UNC, file URLs, ADS and traversal', async () => {
    for (const path of ['http://example.invalid/a.mkv', 'https://example.invalid/a.mkv', 'ftp://example.invalid/a.mkv',
        'file:///C:/fixture.mkv', '\\\\server\\share\\fixture.mkv', '//server/share/fixture.mkv',
        `${fixture.root}\\..\\outside.mkv`, `${fixture.paths.av}:stream`]) {
        await assert.rejects(localFixture(fixture.root, path), /LOCAL_FIXTURE_REQUIRED/);
    }
});
test('root escape and symlink/junction escape are rejected', async () => {
    const other = await mkdtemp(join(tmpdir(), 'lz-decoder-outside-'));
    try {
        const path = join(other, 'outside.mkv'); await writeFile(path, 'bounded fixture');
        await assert.rejects(localFixture(fixture.root, path), /OUTSIDE_ROOT/);
        const link = join(fixture.root, 'outside-link'); await symlink(other, link, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(localFixture(fixture.root, join(link, 'outside.mkv')), /OUTSIDE_ROOT/);
        await rm(link, {recursive: true, force: true});
    } finally { await rm(other, {recursive: true, force: true}); }
});
test('playlist named as container cannot trigger nested network input', async t => {
    const path = join(fixture.root, 'playlist.mkv'); await writeFile(path, '#EXTM3U\nhttp://127.0.0.1:9/never-fetch\n');
    const worker = new FFmpegHealthWorker({backend: LOCAL_BACKEND, fixtureRoot: fixture.root, fixturePath: path,
        profile: 'VIDEO_ONLY', maxRuntimeMs: 10000}); t.after(() => worker.stop());
    await worker.start(); assert.equal((await worker.closed).sample.state, 'DECODER_ERROR');
});
