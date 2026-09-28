import test from 'node:test';
import {
    createProgramOutputEnvelope
} from '../public/js/program-output/ProgramOutputEnvelope.js';
import assert from 'node:assert/strict';

import {
    createScheduledLiveProgram,
    createScheduledLiveBlack
} from '../server/scheduler/ScheduledLiveProgramFactory.js';

import {
    scheduledLiveProgramIdentity
} from '../server/scheduler/ScheduledLiveProgramIdentity.js';
import {mkdtemp,rm,writeFile,
    readFile
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {createProgramOutputServer}
    from '../server/program-output-server.js';

import {createInitializedState}
    from '../server/studio/AuthoritativeStateContract.js';

const epoch=Date.parse('2026-09-28T18:00:00.000Z');
const stamp=ms=>new Date(epoch+ms).toISOString();

function liveEvent(){
    return {
        id:'scheduled-live-a',
        version:1,
        type:'source.live',
        enabled:true,
        startAt:stamp(300000),
        endAt:stamp(600000),
        priority:10,
        payload:{
            sourceId:'live-a',
            precheckSeconds:180,
            unavailableAction:'KEEP_PROGRAM',
            unavailableSceneId:null,
            endAction:'RETURN',
            endSceneId:null
        },
        createdAt:stamp(0),
        updatedAt:stamp(0)
    };
}

test('real server POSTROLL requests canonical Explicit Empty BLACK PROGRAM',async t=>{
    const dir=await mkdtemp(
        join(tmpdir(),'lz-live-automation-server-')
    );

    const studio=createInitializedState({
        sources:[
            {
                id:'live-a',
                name:'Scheduled LIVE',
                kind:'hls',
                enabled:true,
                url:'https://live.example/index.m3u8'
            }
        ],
        scenes:[],
        scheduler:{
            version:1,
            timezone:'Europe/Rome',
            items:[],
            enabled:false
        },
        globalOverlays:{textCrawl:null},
        dominantLive:{
            armed:false,
            authorizedSourceId:null
        }
    },{
        stateId:'studio',
        updatedAt:stamp(0)
    });

    assert.ok(studio);

    await writeFile(
        join(dir,'studio.json'),
        JSON.stringify(studio)
    );

    let now=epoch;
    const timers=new Map();
    let timerSequence=0;

    const leases=[];
    const releases=[];

    const healthRegistry={
        acquire(descriptor,listener){
            const lease={
                descriptor,
                listener,
                current:{
                    sourceId:descriptor.sourceId,
                    sourceFingerprint:descriptor.fingerprint,
                    state:'CHECKING',
                    reason:'INITIAL',
                    freshness:'FRESH',
                    validUntil:now+60000,
                    playlistProgressing:null,
                    segmentReachable:null
                },

                getSnapshot(){
                    return this.current;
                },

                release(){
                    releases.push(descriptor.sourceId);
                }
            };

            leases.push(lease);

            queueMicrotask(()=>listener(lease.current));

            return lease;
        }
    };

    const studioStatePath=
        join(dir,'studio.json');

    const scheduledLiveExecutionPath=
        studioStatePath + '.scheduled-live-execution.json';

    const owner=createProgramOutputServer({
        publisherToken:'separate-live-shadow-token',

        studioStatePath,
        schedulePath:join(dir,'schedule.json'),
        mediaLibraryRoot:join(dir,'media'),

        mediaAssetRepository:{
            initialize:async()=>{},
            list:()=>[],
            get:()=>null
        },

        autoLiveHealthRegistry:healthRegistry,

        scheduleClock:()=>now,

        scheduleSetTimer:(fn,delay)=>{
            const id=++timerSequence;
            timers.set(id,{fn,delay});
            return id;
        },

        scheduleClearTimer:id=>{
            timers.delete(id);
        }
    });

    t.after(async()=>{
        owner.server.closeAllConnections?.();

        // Drain repositories even though this fixture has no HTTP listener.
        await new Promise(resolve=>owner.server.close(()=>resolve()));
        assert.equal(owner.scheduledLiveExecutionRepository.closed,true);
        assert.equal(owner.scheduledLiveExecutionRepository.lock,null);

        await rm(dir,{
            recursive:true,
            force:true
        });
    });

    await Promise.all([
        owner.scheduler.ready,
        owner.studioStateCoordinator.ready
    ]);

    /*
     * No HTTP listener is required for this gate.
     * We are exercising the real server-owned authorities returned
     * by createProgramOutputServer().
     */

    const retainedAt='2026-09-25T06:00:00.000Z';

    const retainedProgram=createProgramOutputEnvelope({
        version:1,
        publisherSessionId:'retained-before-scheduled',
        revision:1,
        publishedAt:retainedAt,
        committedAt:retainedAt,
        scene:{
            id:'retained-scene',
            name:'Retained PROGRAM',
            type:'MEDIA'
        },
        source:{
            id:'retained-source',
            kind:'media',
            url:'https://example.test/retained.mp4'
        },
        playback:{
            initialTime:27,
            duration:120,
            playing:true,
            ended:false,
            state:'playing',
            startedAt:retainedAt
        },
        graphics:{items:[]},
        transition:{
            type:'cut',
            durationMs:0
        }
    });

    assert.ok(retainedProgram);
    assert.equal(
        owner.store.accept(retainedProgram).accepted,
        true
    );

    const browser=await owner.executionOwnership.operate({
        operation:'acquire',
        ownerInstanceId:'scheduled-gate-browser',
        publisherSessionId:'scheduled-gate-publisher'
    },'operator');

    assert.ok(browser.grant);
    const programBefore=owner.store.getCurrent();

    assert.deepEqual(programBefore,retainedProgram);
    assert.equal(owner.liveAutomation.getSnapshot().state,'IDLE');
    assert.equal(leases.length,0);

    /*
     * Persist through the real ScheduleStore.
     */
    const mutation=await owner.scheduler.store.insert(
        liveEvent(),
        0
    );

    assert.equal(mutation.schedule.revision,1);

    /*
     * At T=0 the authoritative next deadline must be PRECHECK:
     * start 300s - precheck 180s = T+120s.
     */
    let schedulerState=owner.scheduler.runtime.getSnapshot();

    assert.equal(
        schedulerState.nextDeadline,
        epoch+120000
    );

    assert.equal(leases.length,0);
    assert.equal(owner.liveAutomation.getSnapshot().state,'IDLE');

    function fireAt(offset){
        now=epoch+offset;

        const entries=[...timers.entries()];

        assert.ok(
            entries.length>0,
            'scheduler must own a pending timer'
        );

        /*
         * ScheduleAuthority caps wakeups at 1 second. Rather than
         * fast-forwarding one-second polling 120 times, reconcile
         * at the exact authoritative wall-clock boundary.
         *
         * This is still the real ScheduleAuthority path.
         */
        owner.scheduler.runtime.reconcile();
    }

    /*
     * PRECHECK
     */
    fireAt(120000);

    assert.equal(leases.length,1);
    assert.equal(
        leases[0].descriptor.sourceId,
        'live-a'
    );

    let automation=owner.liveAutomation.getSnapshot();

    assert.ok([
        'PRECHECK',
        'UNAVAILABLE'
    ].includes(automation.state));

    assert.equal(automation.serverTake,false);
    assert.equal(automation.executionAllowed,false);

    /*
     * Health becomes transport-ready.
     */
    leases[0].current={
        ...leases[0].current,
        state:'ONLINE',
        reason:'PLAYLIST_ADVANCING',
        freshness:'FRESH',
        validUntil:now+60000,
        playlistProgressing:true,
        segmentReachable:true
    };

    leases[0].listener(leases[0].current);

    automation=owner.liveAutomation.getSnapshot();

    assert.equal(
        automation.state,
        'TRANSPORT_READY'
    );

    assert.equal(automation.intent,null);
    assert.equal(automation.serverTake,false);

    /*
     * START
     *
     * A real HealthRegistry continues sampling during PRECHECK.
     * Refresh the controlled observation at the START boundary so
     * the decision is based on current evidence, not the sample
     * emitted three minutes earlier.
     */
    fireAt(300000);

    leases[0].current={
        ...leases[0].current,
        state:'ONLINE',
        reason:'PLAYLIST_ADVANCING',
        freshness:'FRESH',
        validUntil:now+60000,
        playlistProgressing:true,
        segmentReachable:true
    };

    leases[0].listener(leases[0].current);

    automation=owner.liveAutomation.getSnapshot();

    assert.equal(
        automation.state,
        'TAKE_REQUESTED'
    );

    assert.deepEqual(
        automation.intent,
        {
            kind:'TAKE_LIVE',
            sourceId:'live-a'
        }
    );

    assert.equal(
        automation.automaticTakeAuthority,
        false
    );

    assert.equal(
        automation.executionAllowed,
        false
    );

    assert.equal(
        automation.serverTake,
        false
    );
    /*
     * 8C-2B runtime gate:
     * the real server subscriber must have crossed into
     * ScheduledLiveOwnershipCoordinator.capture().
     */
    const scheduledOwnership=
        owner.scheduledLiveOwnership.snapshot();

    assert.equal(scheduledOwnership.active,true);
    assert.equal(scheduledOwnership.eventId,'scheduled-live-a');
    assert.equal(scheduledOwnership.sourceId,'live-a');
    assert.equal(scheduledOwnership.executionAllowed,false);
    assert.equal(scheduledOwnership.serverTake,false);

    const executionDuringTake=
        owner.executionOwnership.snapshot();

    assert.equal(executionDuringTake.scheduledSuppressed,true);
    assert.equal(
        executionDuringTake.scheduledEventId,
        'scheduled-live-a'
    );
    assert.equal(
        executionDuringTake.reason,
        'SCHEDULED_OVERRIDE'
    );

    assert.equal(
        Boolean(
            owner.executionOwnership.matches(
                browser.grant,
                'operator',
                'scheduled-gate-publisher'
            )
        ),
        false
    );

    const blockedBrowser=
        await owner.executionOwnership.operate({
            operation:'acquire',
            ownerInstanceId:'blocked-during-scheduled',
            publisherSessionId:'blocked-during-scheduled'
        },'operator');

    assert.equal(blockedBrowser.grant,null);

    assert.strictEqual(
        owner.store.getCurrent(),
        programBefore
    );
    /*
     * BUILD-1003.9A1 durable TAKE gate.
     *
     * TAKE now advances the canonical durable lifecycle through
     * CAPTURED -> PREROLL -> LIVE before PROGRAM execution.
     *
     * Do not stop at the first repository record: PREROLL is an
     * intentional intermediate durable write.
     */
    for(let attempt=0;attempt<100;attempt++){

        const current=
            owner.scheduledLiveExecutionRepository.record;

        if(current?.state==='LIVE')
            break;

        await new Promise(
            resolve=>setTimeout(resolve,5)
        );
    }

    const persisted=
        owner.scheduledLiveExecutionRepository.record;

    assert.ok(persisted);

    assert.equal(
        owner.scheduledLiveExecutionRepository.status,
        'READY'
    );

    assert.equal(
        persisted.eventId,
        'scheduled-live-a'
    );

    assert.equal(
        persisted.sourceId,
        'live-a'
    );

    assert.equal(
        persisted.state,
        'LIVE'
    );

    assert.equal(
        persisted.executionAllowed,
        false
    );

    assert.equal(
        persisted.serverTake,
        false
    );

    /*
     * The durable return target must be exactly the PROGRAM captured
     * before Scheduled LIVE ownership.
     */
    assert.deepEqual(
        persisted.capturedProgram,
        programBefore
    );

    assert.notStrictEqual(
        persisted.capturedProgram,
        programBefore
    );

    const journalDisk=
        JSON.parse(
            await readFile(
                scheduledLiveExecutionPath,
                'utf8'
            )
        );

    assert.equal(
        journalDisk.schemaVersion,
        1
    );

    assert.equal(
        journalDisk.mode,
        'NON_EXECUTING_SCHEDULED_LIVE'
    );

    assert.equal(
        journalDisk.record.eventId,
        'scheduled-live-a'
    );

    assert.equal(
        journalDisk.record.sourceId,
        'live-a'
    );

    assert.deepEqual(
        journalDisk.record.capturedProgram,
        programBefore
    );

    assert.equal(
        journalDisk.record.executionAllowed,
        false
    );

    assert.equal(
        journalDisk.record.serverTake,
        false
    );

    assert.match(
        journalDisk.checksum,
        /^[a-f0-9]{64}$/
    );

    assert.deepEqual(
        owner.scheduledLivePersistence.hydrate(),
        persisted
    );
    /*
     * BUILD-1003.9A1 / STEP 8C-2C4
     *
     * Durability is established above.
     *
     * Scheduled TAKE must now install the canonical LIVE PROGRAM
     * through ProgramCommitCoordinator while the captured retained
     * PROGRAM remains immutable inside the durable transaction.
     */

    const identity=
        scheduledLiveProgramIdentity({
            eventId:persisted.eventId,
            revision:1
        });

    assert.equal(
        persisted.sourceId,
        'live-a'
    );

    const expectedSourceUrl=
        'https://live.example/index.m3u8';

    const expectedLiveProgram=
        createScheduledLiveProgram({
            eventId:persisted.eventId,
            sourceId:persisted.sourceId,
            sourceUrl:expectedSourceUrl,

            publisherSessionId:
                identity.publisherSessionId,

            revision:
                identity.revision,

            now:Date.now()
        });

    /*
     * Persistence and PROGRAM commit are asynchronous relative
     * to the automation callback. Wait only for the exact
     * Scheduled PROGRAM identity.
     */
    for(
        let attempt=0;
        attempt<100;
        attempt++
    ){
        const current=
            owner.store.getCurrent();

        if(
            current?.publisherSessionId===
                identity.publisherSessionId &&
            current?.revision===1 &&
            current?.snapshot?.scene?.type==='LIVE' &&
            current?.snapshot?.source?.id===
                persisted.sourceId
        ){
            break;
        }

        await new Promise(
            resolve=>setTimeout(resolve,5)
        );
    }

    const programAfterTake=
        owner.store.getCurrent();

    assert.notStrictEqual(
        programAfterTake,
        programBefore
    );

    assert.equal(
        programAfterTake.publisherSessionId,
        identity.publisherSessionId
    );

    assert.equal(
        programAfterTake.revision,
        1
    );

    assert.equal(
        programAfterTake.snapshot.scene.type,
        'LIVE'
    );

    assert.equal(
        programAfterTake.snapshot.source.id,
        persisted.sourceId
    );

    assert.equal(
        programAfterTake.snapshot.source.kind,
        'hls'
    );

    assert.equal(
        programAfterTake.snapshot.source.url,
        expectedLiveProgram.snapshot.source.url
    );

    assert.equal(
        programAfterTake.snapshot.playback.playing,
        true
    );

    assert.equal(
        programAfterTake.snapshot.playback.state,
        'playing'
    );

    /*
     * TAKE must not rewrite the captured return PROGRAM.
     */
    assert.deepEqual(
        persisted.capturedProgram,
        programBefore
    );
    /*
     * STEP 8C-2C5C â€” BLACK RED contract.
     *
     * TAKE has already installed Scheduled LIVE revision 1.
     *
     * At END (offset 600000), LiveAutomation must enter
     * POSTROLL_REQUESTED / SHOW_BLACK.
     *
     * Execution authority is not wired yet, therefore this test
     * is expected to remain RED until production installs the
     * canonical Explicit Empty PROGRAM revision 2.
     */

    const expectedBlack=
        createScheduledLiveBlack({
            eventId:persisted.eventId,

            publisherSessionId:
                identity.publisherSessionId,

            revision:2,

            now:
                epoch + 600000
        });

    fireAt(600000);

    const postroll=
        owner.liveAutomation.getSnapshot();

    assert.equal(
        postroll.state,
        'POSTROLL_REQUESTED'
    );

    assert.equal(
        postroll.intent?.kind,
        'SHOW_BLACK'
    );

    /*
     * Give any asynchronous production execution path a chance
     * to commit BLACK.
     */
    for(let attempt=0;attempt<40;attempt++){

        const current=
            owner.store.getCurrent();

        if(
            current?.publisherSessionId===
                identity.publisherSessionId &&
            current?.revision===2 &&
            current?.snapshot?.scene===null &&
            current?.snapshot?.source===null
        ){
            break;
        }

        await new Promise(
            resolve=>setTimeout(resolve,5)
        );
    }

    const programAfterBlack=
        owner.store.getCurrent();

    /*
     * RED boundary:
     *
     * Today this should still be Scheduled LIVE revision 1.
     * After BLACK execution wiring it must become revision 2.
     */
    assert.equal(
        programAfterBlack.publisherSessionId,
        identity.publisherSessionId
    );

    assert.equal(
        programAfterBlack.revision,
        2
    );

    assert.equal(
        programAfterBlack.snapshot.scene,
        expectedBlack.snapshot.scene
    );

    assert.equal(
        programAfterBlack.snapshot.source,
        expectedBlack.snapshot.source
    );

    assert.equal(
        programAfterBlack.snapshot.playback.playing,
        false
    );

    assert.equal(
        programAfterBlack.snapshot.playback.state,
        'ready'
    );

    /*
     * BLACK must never rewrite the durable return payload.
     */
    assert.deepEqual(
        persisted.capturedProgram,
        programBefore
    );

});
