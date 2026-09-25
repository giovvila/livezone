import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createProgramOutputEnvelope
} from '../public/js/program-output/ProgramOutputEnvelope.js';

import {
    createScheduledLiveTransaction
} from '../server/scheduler/ScheduledLiveExecutionTransaction.js';

import {
    reconcileScheduledLiveRecovery
} from '../server/scheduler/ScheduledLiveRecovery.js';

const START=600000;
const END=1200000;
const PREROLL=590000;
const RETURN=1203000;

function program({
    revision=7,
    sceneId='scene-a',
    sourceId='media-a'
}={}){
    const at='2026-09-25T06:00:00.000Z';

    const value=createProgramOutputEnvelope({
        version:1,
        publisherSessionId:'publisher-a',
        revision,
        publishedAt:at,
        committedAt:at,

        scene:{
            id:sceneId,
            name:'PROGRAM A',
            type:'MEDIA'
        },

        source:{
            id:sourceId,
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

    assert.ok(value);
    return value;
}

function event(change={}){
    return {
        id:'scheduled-live-1',
        version:1,
        type:'source.live',
        enabled:true,
        startAt:new Date(START).toISOString(),
        endAt:new Date(END).toISOString(),
        priority:10,

        payload:{
            sourceId:'primecast',
            precheckSeconds:180,
            unavailableAction:'KEEP_PROGRAM',
            unavailableSceneId:null,
            endAction:'RETURN',
            endSceneId:null
        },

        createdAt:new Date(0).toISOString(),
        updatedAt:new Date(0).toISOString(),

        ...change
    };
}

function transaction(){
    return createScheduledLiveTransaction({
        eventId:'scheduled-live-1',
        sourceId:'primecast',
        program:program(),
        manualIntentRevision:11,
        capturedAt:PREROLL
    });
}

function reconcile(change={}){
    return reconcileScheduledLiveRecovery({
        transaction:transaction(),
        event:event(),
        currentProgram:program(),
        manualIntentRevision:11,
        now:PREROLL,
        ...change
    });
}

test('no persisted transaction requires no recovery',()=>{
    const result=
        reconcileScheduledLiveRecovery({
            transaction:null,
            event:null,
            currentProgram:null,
            manualIntentRevision:11,
            now:PREROLL
        });

    assert.equal(
        result.disposition,
        'NO_TRANSACTION'
    );

    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);
});

test('manual intent change dominates hydrated transaction',()=>{
    const result=reconcile({
        manualIntentRevision:12
    });

    assert.equal(
        result.disposition,
        'MANUAL_INTENT_DOMINATES'
    );

    assert.equal(result.executionAllowed,false);
});

test('missing scheduled event fails closed',()=>{
    const result=reconcile({
        event:null
    });

    assert.equal(
        result.disposition,
        'EVENT_MISSING'
    );

    assert.equal(result.serverTake,false);
});

test('changed source invalidates hydrated transaction',()=>{
    const changed=event({
        payload:{
            ...event().payload,
            sourceId:'other-live'
        }
    });

    const result=reconcile({
        event:changed
    });

    assert.equal(
        result.disposition,
        'EVENT_CHANGED'
    );
});

test('changed start time invalidates captured T-10 boundary',()=>{
    const changed=event({
        startAt:new Date(START+60000).toISOString()
    });

    const result=reconcile({
        event:changed
    });

    assert.equal(
        result.disposition,
        'EVENT_CHANGED'
    );
});

test('invalid current PROGRAM fails closed',()=>{
    const result=reconcile({
        currentProgram:{bad:true}
    });

    assert.equal(
        result.disposition,
        'PROGRAM_INVALID'
    );
});

test('recovery before pre-roll never advances sequence',()=>{
    const result=reconcile({
        now:PREROLL-1
    });

    assert.equal(result.disposition,'TOO_EARLY');
    assert.equal(result.phase,'BEFORE_PREROLL');
    assert.equal(result.executionAllowed,false);
});

test('hydration during pre-roll requires reconciliation only',()=>{
    const result=reconcile({
        now:PREROLL
    });

    assert.equal(
        result.disposition,
        'RECONCILIATION_REQUIRED'
    );

    assert.equal(
        result.phase,
        'PREROLL_WINDOW'
    );

    assert.equal(
        result.capturedProgramMatchesCurrent,
        true
    );

    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);
});

test('hydration during LIVE window cannot replay TAKE',()=>{
    const result=reconcile({
        now:START+1000,
        currentProgram:program({
            revision:20,
            sceneId:'live-scene',
            sourceId:'live-source'
        })
    });

    assert.equal(
        result.disposition,
        'RECONCILIATION_REQUIRED'
    );

    assert.equal(
        result.phase,
        'LIVE_WINDOW'
    );

    assert.equal(
        result.capturedProgramMatchesCurrent,
        false
    );

    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);
});

test('hydration during post-roll cannot replay BLACK',()=>{
    const result=reconcile({
        now:END+2000
    });

    assert.equal(
        result.disposition,
        'RECONCILIATION_REQUIRED'
    );

    assert.equal(
        result.phase,
        'POSTROLL_WINDOW'
    );

    assert.equal(result.executionAllowed,false);
});

test('return boundary is diagnostic and cannot restore PROGRAM',()=>{
    const result=reconcile({
        now:RETURN
    });

    assert.equal(
        result.disposition,
        'RECONCILIATION_REQUIRED'
    );

    assert.equal(
        result.phase,
        'RETURN_WINDOW'
    );

    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);
});

test('expired sequence never resumes automatically',()=>{
    const result=reconcile({
        now:RETURN+1
    });

    assert.equal(
        result.disposition,
        'SEQUENCE_EXPIRED'
    );

    assert.equal(
        result.phase,
        'AFTER_SEQUENCE'
    );

    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);
});
