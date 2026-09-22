import test from 'node:test';
import assert from 'node:assert/strict';
import {HeadlessHlsProbe, evidence, compareHealth, AdvisoryHealthTiming, CAPABILITY_CLASSES} from '../server/autolive/HeadlessHealthEvidence.js';
import {binding, fp, program} from '../test-support/Phase2ActionFixture.js';
import ActiveHealth from '../public/js/studio/AutoLiveActiveHealth.js';

const sample = (kind, state = 'ONLINE', extra = {}) => evidence({kind, state, sourceId: 'live', sourceFingerprint: fp,
    authorityEpoch: 1, authorityProcessSession: 'process', observedAt: 0, validUntil: 10000,
    programIdentity: binding().programIdentity, ownershipRevision: 1,
    presence: true, playlistProgress: true, segmentReachable: true, playbackProgressing: true, ...extra});
const playlist = (seq, extra = '') => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${seq}\n${extra}\n#EXTINF:2,\nsegment-${seq}.ts\n`;
function probeFixture() {
    let now = 0, seq = 1, extra = '', url = 'https://example.test/live.m3u8', failure = false, malformed = false, master = false;
    const calls = [];
    const http = {async read(request, options) {
        calls.push(options);
        if (failure) throw Error('private-secret-url');
        if (options.segment) return {bytes: 1};
        if (master && options.stage === 'manifest') return {url, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nvariant.m3u8'};
        return {url, body: malformed ? 'bad' : playlist(seq, extra)};
    }};
    const probe = new HeadlessHlsProbe({http, clock: () => now});
    return {probe, calls, take: () => probe.sample({id: 'live', endpoint: 'https://example.test/live.m3u8'}, binding()),
        set(v) { if (v.now !== undefined) now = v.now; if (v.seq !== undefined) seq = v.seq; if (v.extra !== undefined) extra = v.extra;
            if (v.url) url = v.url; if (v.failure !== undefined) failure = v.failure; if (v.malformed !== undefined) malformed = v.malformed; if (v.master !== undefined) master = v.master; }};
}
for (const kind of ['EXTERNAL_HLS','MANAGED_INGEST','RETAINED_LIVE','BROWSER_PROGRAM','NONLIVE_MEDIA']) test('actual capability limit: ' + kind, () => {
    const e = sample(kind); assert.deepEqual(Object.keys(e.capabilities), CAPABILITY_CLASSES);
    assert.equal(e.capabilities.MEDIA_DECODE_PROGRESS, kind === 'BROWSER_PROGRAM');
    assert.equal(e.headlessDecoderEquivalent, false); assert.equal(e.executionAllowed, false); assert.equal(e.serverTake, false);
    if (kind === 'RETAINED_LIVE' || kind === 'NONLIVE_MEDIA') assert.ok(Object.values(e.capabilities).every(v => !v));
});
for (const [ss, bs, expected] of [['ONLINE','ONLINE','MATCH_HEALTHY'], ['OFFLINE','OFFLINE','MATCH_LOSS'],
    ['UNCERTAIN','ONLINE','SERVER_WEAKER'], ['ONLINE','CHECKING','BROWSER_WEAKER'], ['OFFLINE','ONLINE','DISAGREEMENT'],
    ['ONLINE','OFFLINE','DISAGREEMENT'], ['UNCERTAIN','CHECKING','INSUFFICIENT_EVIDENCE']]) test('comparison ' + expected + ' ' + ss + '/' + bs, () => {
    const r = compareHealth({server: sample('EXTERNAL_HLS', ss), browser: sample('BROWSER_PROGRAM', bs, {confirmedLoss: bs === 'OFFLINE'}), binding: binding(), now: 1});
    assert.equal(r.classification, expected); assert.equal(r.decoderEquivalent, false); assert.equal(r.executionAllowed, false); assert.equal(r.serverTake, false);
});
test('browser closed, retained identity and stale/fingerprint/epoch evidence never provide decoder proof', () => {
    for (const [browser, current, now] of [[null, binding(), 1], [sample('BROWSER_PROGRAM'), binding(), 10000],
        [sample('BROWSER_PROGRAM'), binding(undefined, 1, {sourceFingerprint: 'b'.repeat(64)}), 1],
        [sample('BROWSER_PROGRAM'), binding(undefined, 1, {authorityEpoch: 2}), 1]])
        assert.equal(compareHealth({server: sample('EXTERNAL_HLS'), browser, binding: current, now}).classification, 'INSUFFICIENT_EVIDENCE');
});
test('bounded observer proves playlist/segment identity and declared timestamp progression, never decode', async () => {
    const h = probeFixture(); h.set({master: true, extra: '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00Z'});
    assert.equal((await h.take()).state, 'UNCERTAIN');
    h.set({seq: 2, now: 3000, extra: '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:02Z'});
    const e = await h.take(); assert.equal(e.state, 'ONLINE');
    for (const k of ['TRANSPORT_PRESENCE','PLAYLIST_PROGRESS','SEGMENT_PROGRESS','TIMESTAMP_PROGRESS']) assert.equal(e.capabilities[k], true);
    assert.equal(e.timestampBasis, 'MANIFEST_DECLARED'); assert.equal(e.capabilities.MEDIA_DECODE_PROGRESS, false);
    assert.ok(h.calls.some(c => c.stage === 'variant')); assert.ok(h.calls.some(c => c.segment));
    assert.doesNotMatch(JSON.stringify(e), /https?:|secret/);
});
for (const [name, change, state] of [
    ['HTTP 200 stale playlist', {now: 20000}, 'UNCERTAIN'],
    ['discontinuity forward', {seq: 2, extra: '#EXT-X-DISCONTINUITY-SEQUENCE:1'}, 'ONLINE'],
    ['rotating effective media URL', {seq: 2, url: 'https://example.test/rotated.m3u8'}, 'ONLINE'],
    ['malformed playlist', {malformed: true}, 'ERROR'],
    ['ENDLIST', {seq: 2, extra: '#EXT-X-ENDLIST'}, 'UNCERTAIN'],
    ['VOD', {seq: 2, extra: '#EXT-X-PLAYLIST-TYPE:VOD'}, 'UNCERTAIN'],
    ['timeout', {failure: true}, 'ERROR']]) test('HLS matrix ' + name, async () => {
    const h = probeFixture(); await h.take(); h.set(change); const e = await h.take();
    assert.equal(e.state, state); assert.equal(e.capabilities.MEDIA_DECODE_PROGRESS, false); assert.equal(e.executionAllowed, false);
    if (name === 'timeout') { h.set({failure: false, seq: 3, now: 3000}); assert.equal((await h.take()).state, 'ONLINE'); }
});
test('advancing segments with decode failure and stalled playlist with progressing decoder remain disagreement', async () => {
    const h = probeFixture(); await h.take(); h.set({seq: 2, now: 1000}); let s = await h.take();
    assert.equal(compareHealth({server: s, browser: sample('BROWSER_PROGRAM','OFFLINE',{confirmedLoss: true}), binding: binding(), now: 1000}).classification, 'DISAGREEMENT');
    h.set({now: 20000}); s = await h.take();
    assert.equal(compareHealth({server: s, browser: sample('BROWSER_PROGRAM','ONLINE',{observedAt: 20000, validUntil: 30000}), binding: binding(), now: 20000}).classification, 'SERVER_WEAKER');
});
test('superseded probe completion and source fingerprint change cannot reuse old evidence', async () => {
    let finish;
    const probe = new HeadlessHlsProbe({clock: () => 0, http: {read: () => new Promise(r => { finish = r; })}});
    const pending = probe.sample({id: 'live', endpoint: 'https://example.test/live'}, binding());
    probe.close(); finish({url: 'https://example.test/live', body: 'bad'}); assert.equal(await pending, null);
    const h = probeFixture(); await h.take(); h.set({seq: 2}); assert.equal((await h.take()).state, 'ONLINE');
    const e = await h.probe.sample({id: 'live', endpoint: 'https://example.test/live.m3u8'}, binding(undefined, 1, {sourceFingerprint: 'b'.repeat(64)}));
    assert.equal(e.state, 'UNCERTAIN');
});
test('capability-qualified 30s/15s advisory timing never becomes execution readiness', () => {
    let now = 0; const timing = new AdvisoryHealthTiming({clock: () => now}), b = binding();
    const step = (state, liveObserved = false) => timing.update(sample('EXTERNAL_HLS', state, {observedAt: now, validUntil: now + 10000}), b,
        {enabled: true, armed: true, liveObserved});
    step('ONLINE'); now = 29999; assert.equal(step('ONLINE').entryEligible, false); now = 30000;
    assert.equal(step('ONLINE').entryEligible, true); assert.equal(step('ONLINE').executionAllowed, false);
    step('OFFLINE', true); now += 15000; assert.equal(step('OFFLINE', true).lossEligible, false);
    now++; assert.equal(step('OFFLINE', true).lossEligible, true); assert.equal(step('OFFLINE', true).serverTake, false);
    const managed = new AdvisoryHealthTiming({clock: () => now});
    assert.equal(managed.update(sample('MANAGED_INGEST','ONLINE',{observedAt: now, validUntil: now + 10000}), b, {enabled: true, armed: true}).entryEligible, false);
});

test('real active Program observer progresses despite weaker server evidence; decoder stall is not hidden', async () => {
    const b = binding(program('hls')), h = probeFixture(); let now = 0;
    const video = Object.assign(new EventTarget(), {currentTime: 0, readyState: 4, paused: false, ended: false});
    const c = {started: true, generation: 1, session: {sessionId: 'retained', sourceId: 'live', sceneId: 'LIVE', phase: 'LIVE', retained: true},
        clock: () => now, clearTimer() {}, executionOwnership: {valid: () => true}, lossTimer: null, lossGraceMs: 5000,
        renderer: {program: {renderer: {sourceId: 'live', video}}}, command: {stateManager: {getProgramSceneId: () => 'LIVE'}},
        externalObservation: {state: 'ONLINE'}, health: {state: 'CHECKING'}, acceptActiveHealth(owner, state) { this.health = {state}; }};
    const owner = c.activeHealth = new ActiveHealth(c); owner.observe();
    try {
        let s = await h.take(); now = 250; video.currentTime = .25; video.dispatchEvent(new Event('timeupdate'));
        const browser = () => sample('BROWSER_PROGRAM', c.health.state, {programIdentity: b.programIdentity,
            playbackProgressing: owner.projected && owner.state === 'ONLINE', observedAt: now, validUntil: now + 10000});
        assert.equal(compareHealth({server: s, browser: browser(), binding: b, now}).classification, 'SERVER_WEAKER');
        h.set({seq: 2, now: 250}); s = await h.take();
        assert.equal(compareHealth({server: s, browser: browser(), binding: b, now}).classification, 'MATCH_HEALTHY');
        now = 3000; owner.check(); assert.equal(c.health.state, 'CHECKING');
        assert.equal(compareHealth({server: s, browser: browser(), binding: b, now}).classification, 'BROWSER_WEAKER');
        assert.equal(owner.canClose(), false);
    } finally { owner.destroy(); }
});
test('owner/process restart resets advisory healthy-time credit; missing observations fail closed', () => {
    let now = 0; const t = new AdvisoryHealthTiming({clock: () => now});
    const step = (b = binding()) => t.update(sample('EXTERNAL_HLS','ONLINE',{observedAt: now, validUntil: now + 10000,
        authorityEpoch: b.authorityEpoch}), b, {enabled: true, armed: true});
    step(); now = 30000; assert.equal(step().entryEligible, true);
    assert.equal(step(binding(undefined, 1, {authorityEpoch: 2})).entryHealthyMs, 0);
    assert.equal(compareHealth({server: {}, browser: {}, binding: binding(), now}).classification, 'INSUFFICIENT_EVIDENCE');
});
