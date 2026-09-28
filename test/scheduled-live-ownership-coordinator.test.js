import test from 'node:test';
import assert from 'node:assert/strict';

import ScheduledLiveOwnershipCoordinator
    from '../server/scheduler/ScheduledLiveOwnershipCoordinator.js';

import {
    createProgramOutputEnvelope
} from '../public/js/program-output/ProgramOutputEnvelope.js';

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
function harness(change={}){
    const calls=[];

    const ownership={
        available:true,
        closed:false,
        restartBlocked:false,
        suppressForScheduled(eventId){
            calls.push(['suppress',eventId]);
            return true;
        },
        releaseScheduled(eventId){
            calls.push(['release',eventId]);
            return true;
        },
        ...change.ownership
    };

    const reconciliation={
        manualIntentRevision:11,
        manualPending:0,
        ...change.reconciliation
    };

    let now=590000;

    const coordinator=
        new ScheduledLiveOwnershipCoordinator({
            ownership,
            reconciliation,
            program,
            clock:()=>now
        });

    return {
        coordinator,
        ownership,
        reconciliation,
        calls,
        advance:value=>now+=value
    };
}

test('healthy scheduled sequence suppresses browser without execution authority',()=>{
    const h=harness();

    const result=h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    assert.equal(result.accepted,true);
    assert.equal(result.active,true);
    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);

    assert.deepEqual(
        h.calls,
        [['suppress','scheduled-live-1']]
    );
});

test('manual pending prevents scheduled suppression',()=>{
    const h=harness({
        reconciliation:{manualPending:1}
    });

    const result=h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    assert.equal(result.accepted,false);
    assert.equal(
        result.reason,
        'MANUAL_INTENT_DOMINATES'
    );

    assert.deepEqual(h.calls,[]);
});

test('restart reconciliation requirement prevents scheduled suppression',()=>{
    const h=harness({
        ownership:{restartBlocked:true}
    });

    const result=h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    assert.equal(result.accepted,false);
    assert.equal(
        result.reason,
        'RECONCILIATION_REQUIRED'
    );

    assert.deepEqual(h.calls,[]);
});

test('suppression refusal fails closed',()=>{
    const h=harness({
        ownership:{
            suppressForScheduled(eventId){
                h.calls.push(['suppress',eventId]);
                return false;
            }
        }
    });

    const result=h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    assert.equal(result.accepted,false);
    assert.equal(
        result.reason,
        'SCHEDULED_SUPPRESSION_REJECTED'
    );

    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);
});

test('same event capture is idempotent',()=>{
    const h=harness();

    h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    const again=h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    assert.equal(again.active,true);

    assert.deepEqual(
        h.calls,
        [['suppress','scheduled-live-1']]
    );
});

test('different event cannot steal active scheduled ownership',()=>{
    const h=harness();

    h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    const result=h.coordinator.capture({
        eventId:'scheduled-live-2',
        sourceId:'backup'
    });

    assert.equal(result.accepted,false);
    assert.equal(
        result.reason,
        'SCHEDULED_SEQUENCE_ALREADY_ACTIVE'
    );

    assert.deepEqual(
        h.calls,
        [['suppress','scheduled-live-1']]
    );
});

test('only active event releases scheduled suppression',()=>{
    const h=harness();

    h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    assert.equal(
        h.coordinator.release('scheduled-live-2'),
        false
    );

    assert.equal(
        h.coordinator.release('scheduled-live-1'),
        true
    );

    assert.deepEqual(
        h.calls,
        [
            ['suppress','scheduled-live-1'],
            ['release','scheduled-live-1']
        ]
    );

    assert.equal(
        h.coordinator.snapshot().active,
        false
    );
});

test('close releases active scheduled suppression',()=>{
    const h=harness();

    h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    h.coordinator.close();

    assert.deepEqual(
        h.calls,
        [
            ['suppress','scheduled-live-1'],
            ['release','scheduled-live-1']
        ]
    );

    assert.equal(
        h.coordinator.snapshot().active,
        false
    );
});
test('ownership transition advances only the active canonical transaction',()=>{
    const h=harness();

    h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    assert.equal(
        h.coordinator.transaction().state,
        'CAPTURED'
    );

    const preroll=
        h.coordinator.transition(
            'begin-preroll'
        );

    assert.equal(
        preroll.state,
        'PREROLL'
    );

    assert.equal(
        h.coordinator.transaction().state,
        'PREROLL'
    );

    const live=
        h.coordinator.transition(
            'begin-live'
        );

    assert.equal(
        live.state,
        'LIVE'
    );

    assert.equal(
        h.coordinator.transaction().state,
        'LIVE'
    );

    const postroll=
        h.coordinator.transition(
            'begin-postroll'
        );

    assert.equal(
        postroll.state,
        'POSTROLL'
    );

    assert.equal(
        h.coordinator.transaction().state,
        'POSTROLL'
    );

    assert.equal(
        postroll.executionAllowed,
        false
    );

    assert.equal(
        postroll.serverTake,
        false
    );
});

test('ownership transition cannot skip canonical Scheduled phases',()=>{
    const h=harness();

    h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    assert.throws(
        ()=>h.coordinator.transition(
            'begin-live'
        ),
        /INVALID_TRANSACTION_TRANSITION/
    );

    assert.equal(
        h.coordinator.transaction().state,
        'CAPTURED'
    );
});

test('manual revision change aborts ownership during transition',()=>{
    const h=harness();

    h.coordinator.capture({
        eventId:'scheduled-live-1',
        sourceId:'primecast'
    });

    h.reconciliation.manualIntentRevision=12;

    const result=
        h.coordinator.transition(
            'begin-preroll'
        );

    assert.equal(
        result.state,
        'ABORTED'
    );

    assert.equal(
        result.reason,
        'MANUAL_INTENT_DOMINATES'
    );

    assert.equal(
        h.coordinator.transaction(),
        null
    );

    assert.equal(
        h.coordinator.snapshot().active,
        false
    );
});

test('ownership transition without active transaction is inert',()=>{
    const h=harness();

    assert.equal(
        h.coordinator.transition(
            'begin-preroll'
        ),
        null
    );

    assert.equal(
        h.coordinator.snapshot().active,
        false
    );
});
