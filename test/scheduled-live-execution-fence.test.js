import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createProgramOutputEnvelope
} from '../public/js/program-output/ProgramOutputEnvelope.js';

import {
    createScheduledLiveTransaction,
    transitionScheduledLiveTransaction
} from '../server/scheduler/ScheduledLiveExecutionTransaction.js';

import {
    evaluateScheduledLiveExecutionFence,
    scheduledLiveCommitCheck
} from '../server/scheduler/ScheduledLiveExecutionFence.js';

function program(){
    const at='2026-09-25T06:00:00.000Z';

    const envelope=createProgramOutputEnvelope({
        version:1,
        publisherSessionId:'publisher-a',
        revision:7,
        publishedAt:at,
        committedAt:at,
        scene:{
            id:'scene-a',
            name:'PROGRAM A',
            type:'MEDIA'
        },
        source:{
            id:'media-a',
            kind:'media',
            url:'https://example.test/source.mp4'
        },
        playback:{
            initialTime:27,
            duration:120,
            playing:true,
            ended:false,
            state:'playing',
            startedAt:at
        },
        graphics:{items:[]},
        transition:{
            type:'cut',
            durationMs:0
        }
    });

    assert.ok(envelope);
    return envelope;
}

function transaction(){
    return createScheduledLiveTransaction({
        eventId:'scheduled-live-1',
        sourceId:'primecast',
        program:program(),
        manualIntentRevision:11,
        capturedAt:590000
    });
}

function args(change={}){
    const tx=transaction();

    return {
        transaction:tx,
        manualIntentRevision:tx.manualIntentRevision,
        currentManualIntentRevision:11,
        authorityAvailable:true,
        authorityClosed:false,
        restartBlocked:false,
        manualPending:false,
        ...change
    };
}

test('healthy authority permits scheduled sequence ownership decision',()=>{
    const fence=
        evaluateScheduledLiveExecutionFence(args());

    assert.equal(fence.allowed,true);

    assert.equal(
        fence.reason,
        'SCHEDULED_SEQUENCE_OWNS'
    );

    assert.equal(
        fence.scheduledOwnsSequence,
        true
    );

    assert.equal(
        fence.suppressBrowser,
        true
    );

    assert.equal(fence.executionAllowed,false);
    assert.equal(fence.serverTake,false);
});

test('manual revision change always dominates scheduled sequence',()=>{
    const fence=
        evaluateScheduledLiveExecutionFence(
            args({
                currentManualIntentRevision:12
            })
        );

    assert.equal(fence.allowed,false);

    assert.equal(
        fence.reason,
        'MANUAL_INTENT_DOMINATES'
    );

    assert.equal(
        fence.scheduledOwnsSequence,
        false
    );
});

test('manual operation in progress dominates even before revision comparison changes',()=>{
    const fence=
        evaluateScheduledLiveExecutionFence(
            args({
                manualPending:true
            })
        );

    assert.equal(fence.allowed,false);

    assert.equal(
        fence.reason,
        'MANUAL_INTENT_DOMINATES'
    );
});

test('restart blocked authority can never grant scheduled decision',()=>{
    const fence=
        evaluateScheduledLiveExecutionFence(
            args({
                restartBlocked:true
            })
        );

    assert.equal(fence.allowed,false);

    assert.equal(
        fence.reason,
        'RECONCILIATION_REQUIRED'
    );
});

test('unavailable or closed authority fails closed',()=>{
    for(const change of [
        {authorityAvailable:false},
        {authorityClosed:true}
    ]){
        const fence=
            evaluateScheduledLiveExecutionFence(
                args(change)
            );

        assert.equal(fence.allowed,false);

        assert.equal(
            fence.reason,
            'RECONCILIATION_REQUIRED'
        );
    }
});

test('all active scheduled transaction phases can own decision fence',()=>{
    let tx=transaction();

    const values=[tx];

    tx=transitionScheduledLiveTransaction(
        tx,'begin-preroll',
        {manualIntentRevision:11}
    );
    values.push(tx);

    tx=transitionScheduledLiveTransaction(
        tx,'begin-live',
        {manualIntentRevision:11}
    );
    values.push(tx);

    tx=transitionScheduledLiveTransaction(
        tx,'begin-postroll',
        {manualIntentRevision:11}
    );
    values.push(tx);

    tx=transitionScheduledLiveTransaction(
        tx,'prepare-return',
        {manualIntentRevision:11}
    );
    values.push(tx);

    for(const transaction of values){
        const fence=
            evaluateScheduledLiveExecutionFence(
                args({transaction})
            );

        assert.equal(
            fence.allowed,
            true,
            transaction.state
        );
    }
});

test('terminal transaction cannot acquire scheduled fence',()=>{
    let tx=transaction();

    tx=transitionScheduledLiveTransaction(
        tx,'begin-preroll',
        {manualIntentRevision:11}
    );

    tx=transitionScheduledLiveTransaction(
        tx,'begin-live',
        {manualIntentRevision:11}
    );

    tx=transitionScheduledLiveTransaction(
        tx,'begin-postroll',
        {manualIntentRevision:11}
    );

    tx=transitionScheduledLiveTransaction(
        tx,'prepare-return',
        {manualIntentRevision:11}
    );

    tx=transitionScheduledLiveTransaction(
        tx,'complete',
        {manualIntentRevision:11}
    );

    assert.throws(
        ()=>evaluateScheduledLiveExecutionFence(
            args({transaction:tx})
        ),
        /INVALID_SCHEDULED_LIVE_EXECUTION_FENCE/
    );
});

test('commit fence requires same event and source identity',()=>{
    const options=args();

    const fence=
        evaluateScheduledLiveExecutionFence(options);

    assert.equal(
        scheduledLiveCommitCheck({
            fence,
            ...options,
            eventId:'scheduled-live-1',
            sourceId:'primecast'
        }),
        true
    );

    assert.equal(
        scheduledLiveCommitCheck({
            fence,
            ...options,
            eventId:'other-event',
            sourceId:'primecast'
        }),
        false
    );

    assert.equal(
        scheduledLiveCommitCheck({
            fence,
            ...options,
            eventId:'scheduled-live-1',
            sourceId:'other-source'
        }),
        false
    );
});

test('manual intent arriving after first fence invalidates final commit check',()=>{
    const options=args();

    const fence=
        evaluateScheduledLiveExecutionFence(options);

    assert.equal(fence.allowed,true);

    assert.equal(
        scheduledLiveCommitCheck({
            fence,
            ...options,
            eventId:'scheduled-live-1',
            sourceId:'primecast',
            currentManualIntentRevision:12
        }),
        false
    );
});

test('restart arriving after first fence invalidates final commit check',()=>{
    const options=args();

    const fence=
        evaluateScheduledLiveExecutionFence(options);

    assert.equal(fence.allowed,true);

    assert.equal(
        scheduledLiveCommitCheck({
            fence,
            ...options,
            eventId:'scheduled-live-1',
            sourceId:'primecast',
            restartBlocked:true
        }),
        false
    );
});

test('fence has no Program writer or execution grant',()=>{
    const fence=
        evaluateScheduledLiveExecutionFence(args());

    assert.deepEqual(
        Object.keys(fence).sort(),
        [
            'version',
            'allowed',
            'reason',
            'scheduledOwnsSequence',
            'suppressBrowser',
            'executionAllowed',
            'serverTake'
        ].sort()
    );

    assert.equal(fence.executionAllowed,false);
    assert.equal(fence.serverTake,false);
});
