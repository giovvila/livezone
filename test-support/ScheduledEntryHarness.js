import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {createProgramOutputServer} from '../server/program-output-server.js';
import {createInitializedState} from '../server/studio/AuthoritativeStateContract.js';
import {createScheduledLiveProgram} from '../server/scheduler/ScheduledLiveProgramFactory.js';

// STEP 8C-2C6A: desired entry contract. Late-entry failures must remain RED
// until a separately reviewed production change implements the contract.
const epoch = Date.parse('2026-09-29T00:00:00.000Z');
export const START = 300000;
export const END = 420000;
const stamp = offset => new Date(epoch + offset).toISOString();
export const event = {
    id:'late-entry', version:1, type:'source.live', enabled:true,
    startAt:stamp(START), endAt:stamp(END), priority:10,
    payload:{sourceId:'source', precheckSeconds:180,
        unavailableAction:'KEEP_PROGRAM', unavailableSceneId:null,
        endAction:'RETURN', endSceneId:null},
    createdAt:stamp(0), updatedAt:stamp(0)
};
const program = (publisherSessionId,sourceUrl='https://example.test/live.m3u8') => createScheduledLiveProgram({
    eventId:event.id, sourceId:'source', sourceUrl,
    publisherSessionId, revision:1, now:epoch
});
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
};

export async function harness(t, {enabled=true, ready=true, sourceUrl='https://example.test/live.m3u8', serverOptions={}, beforeBoot=async()=>{}} = {}) {
    const tempRoot = resolve(tmpdir());
    const dir = await mkdtemp(join(tempRoot, 'lz-c6a-late-entry-'));
    const studioStatePath = join(dir, 'studio.json');
    const timers = new Map();
    const jobs = new Set();
    const releases = [];
    const captures = [];
    const commits = [];
    const states = [];
    const leases = [];
    let now = epoch;
    let timerId = 0;
    let owner;
    let holdPersistence;
    const track = pending => {
        jobs.add(pending);
        pending.then(() => jobs.delete(pending), () => jobs.delete(pending));
        return pending;
    };
    const close = () => new Promise(done => owner.server.close(() => done()));
    const settle = async () => {
        await owner.scheduledEntry.idle();
        // Drain actual persistence/commit promises and the mutation queue.
        // No wall-clock sleeps, production timers, or live HTTP endpoints.
        do {
            await Promise.resolve();
            await Promise.all([...jobs]);
            await owner.assetMutations.run(() => {});
        } while (jobs.size);
    };
    t.after(async () => {
        for (const release of releases) release();
        if (owner) { await settle(); await close(); }
        // Validate the exact cleanup target before recursive removal on Windows.
        const child = relative(tempRoot, resolve(dir));
        assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
        assert.ok(child.startsWith('lz-c6a-late-entry-'));
        await rm(dir, {recursive:true, force:true});
    });
    const studio = createInitializedState({
        sources:[{id:'source', name:'Live', kind:'hls', enabled:true,
            url:sourceUrl}], scenes:[],
        scheduler:{version:1, timezone:'Europe/Rome', items:[], enabled:false},
        globalOverlays:{textCrawl:null}, dominantLive:{armed:false, authorizedSourceId:null}
    }, {stateId:'late-entry-studio', updatedAt:stamp(0)});
    await writeFile(studioStatePath, JSON.stringify(studio));
    const options = {
        publisherToken:'c6a-isolated-late-entry-token', studioStatePath,
        schedulePath:join(dir, 'schedule.json'), mediaLibraryRoot:join(dir, 'media'),
        mediaAssetRepository:{initialize:async()=>{}, list:()=>[], get:()=>null},
        scheduleClock:()=>now, executionClock:()=>now,
        scheduleSetTimer:(callback, delay)=>{
            const id = ++timerId;
            timers.set(id, {callback, at:now + delay});
            return id;
        },
        scheduleClearTimer:id=>timers.delete(id),
        autoLiveHealthRegistry:{acquire(descriptor,listener) {
            const observation = {
                sourceId:descriptor.sourceId, sourceFingerprint:descriptor.fingerprint,
                state:ready ? 'ONLINE' : 'CHECKING', reason:'TEST_TRANSPORT_EVIDENCE',
                freshness:'FRESH', validUntil:epoch + END + 60000,
                playlistProgressing:ready, segmentReachable:ready
            };
            leases.push({observation,listener});
            return {getSnapshot:()=>observation, release(){}};
        }}
    };
    async function boot() {
        owner = createProgramOutputServer(options);
        // Wrappers observe/defer real methods; they never manufacture an intent,
        // ownership grant, fence decision or PROGRAM acceptance.
        const capture = owner.scheduledLiveOwnership.capture.bind(owner.scheduledLiveOwnership);
        owner.scheduledLiveOwnership.capture = input => {
            const result = capture(input);
            captures.push({input, result});
            return result;
        };
        const persist = owner.scheduledLivePersistence.persist.bind(owner.scheduledLivePersistence);
        owner.scheduledLivePersistence.persist = tx => track((async()=>{
            const result = await persist(tx);
            if (holdPersistence) await holdPersistence(tx);
            return result;
        })());
        const commit = owner.scheduledLiveExecution.commit.bind(owner.scheduledLiveExecution);
        owner.scheduledLiveExecution.commit = input => track(commit(input).then(result => {
            commits.push({input, result});
            return result;
        }));
        owner.liveAutomation.subscribe(snapshot => states.push(snapshot));
        await Promise.all([owner.scheduler.ready, owner.studioStateCoordinator.ready,
            owner.autoLive.ready, owner.programReady, owner.scheduledLiveHydrationReady,owner.scheduledEntryReady]);
        await settle();
        assert.equal(owner.scheduler.available(), true);
        assert.equal(owner.scheduledLiveExecutionRepository.status, 'READY');
    }
    Object.assign(options,{scheduledEntryLogger:()=>{}},serverOptions);
    await beforeBoot({dir,studioStatePath,schedulePath:options.schedulePath});
    await boot();
    assert.equal(owner.executionOwnership.available, true);
    // Bootstrap/restart-fence tests may intentionally seed an earlier epoch.
    const retained = program('manual-retained',sourceUrl);
    assert.equal((await owner.programCommits.accept(retained, {check:()=>true})).accepted, true);
    if(!owner.scheduler.store.getEvent(event.id))assert.equal((await owner.scheduler.store.insert({...event, enabled}, owner.scheduler.store.getSnapshot().revision)).ok, true);

    function fire(offset) {
        assert.ok(epoch + offset >= now, 'test clock must never rewind');
        now = epoch + offset;
        assert.equal(timers.size, 1, 'real ScheduleAuthority must own one pending timer');
        const [id, timer] = [...timers][0];
        assert.ok(timer.at <= now, 'only deliver a due scheduler callback');
        timers.delete(id);
        timer.callback();
    }
    // A disabled event has no START deadline: align its ordinary 1s tick
    // instead of attempting to fire a callback before its due time.
    fire(enabled ? START - 1 : START - 1000);
    await settle();
    assert.equal(captures.length, 0, 'no pre-START capture');
    if (enabled && ready) {
        assert.equal(owner.liveAutomation.getSnapshot().healthStatus, 'TRANSPORT_READY');
        if(owner.scheduler.store.getEvent(event.id).startAt===event.startAt)assert.equal([...timers.values()][0].at, epoch + START);
    }
    const path = studioStatePath + '.program-output.json';
    const acceptedLive = () => commits.filter(c => c.input.expectedState === 'LIVE' && c.result.accepted);
    return {
        get owner(){return owner;}, captures, commits, states, retained, path,
        fire, settle, acceptedLive,
        advance(offset){now=epoch+offset;},
        health(patch){const lease=leases.at(-1);Object.assign(lease.observation,patch);lease.listener(lease.observation);},
        async clearRestart(){owner.executionOwnership.restartBlocked=false;},
        async unchanged(expected=retained, bytes) {
            assert.deepEqual(owner.store.getCurrent(), expected);
            if (bytes !== undefined) assert.equal(await readFile(path, 'utf8'), bytes);
        },
        holdPreroll() {
            const entered = deferred(), resume = deferred();
            releases.push(resume.resolve);
            holdPersistence = async tx => {
                if (tx.state === 'PREROLL') { entered.resolve(); await resume.promise; }
            };
            return {entered:entered.promise, release:resume.resolve};
        },
        async manual() {
            const finish = owner.scheduledLiveExecution.reconciliation.beginManualIntent();
            const payload = program('manual-newer',sourceUrl);
            try {
                const result = await owner.assetMutations.run(()=>owner.programCommits.accept(payload,
                    {check:()=>true, afterInstall:()=>owner.executionOwnership.revokeForManual('manual-newer')}));
                assert.equal(result.accepted, true);
                return owner.store.getCurrent();
            } finally { finish(); }
        },
        async restart(offset) {
            await settle();
            await close();
            now = epoch + offset;
            await boot();
        }
    };
}
