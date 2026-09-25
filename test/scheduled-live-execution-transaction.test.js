import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createProgramOutputEnvelope
} from '../public/js/program-output/ProgramOutputEnvelope.js';

import {
    createScheduledLiveTransaction,
    transitionScheduledLiveTransaction,
    inspectScheduledLiveTransaction,
    sameCapturedProgram,
    normalizeScheduledLiveTransaction,
    scheduledLiveTransactionEnvelope,
    validateScheduledLiveTransactionEnvelope,
    scheduledLiveTransactionChecksum
} from '../server/scheduler/ScheduledLiveExecutionTransaction.js';

/*
 * Canonical fixture derived from durable-program.test.js.
 */
function program({
    revision=7,
    publisherSessionId='publisher-a',
    sceneId='scene-a',
    sourceId='media-a',
    initialTime=27
}={}){
    const at='2026-09-25T06:00:00.000Z';

    const envelope=createProgramOutputEnvelope({
        version:1,
        publisherSessionId,
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
            initialTime,
            duration:120,
            playing:true,
            ended:false,
            state:'playing',
            startedAt:at
        },

        graphics:{
            items:[]
        },

        transition:{
            type:'cut',
            durationMs:0
        }
    });

    assert.ok(
        envelope,
        'canonical PROGRAM fixture required'
    );

    return envelope;
}

function captured(){
    return createScheduledLiveTransaction({
        eventId:'scheduled-live-1',
        sourceId:'primecast',
        program:program(),
        manualIntentRevision:11,
        capturedAt:590000
    });
}

test('canonical PROGRAM fixture is accepted before transaction testing',()=>{
    const envelope=program();

    assert.equal(
        envelope.snapshot.source.kind,
        'media'
    );

    assert.equal(
        envelope.snapshot.playback.initialTime,
        27
    );
});

test('T-10 capture stores immutable canonical PROGRAM envelope',()=>{
    const source=program();

    const tx=createScheduledLiveTransaction({
        eventId:'scheduled-live-1',
        sourceId:'primecast',
        program:source,
        manualIntentRevision:11,
        capturedAt:590000
    });

    assert.equal(tx.state,'CAPTURED');
    assert.equal(tx.executionAllowed,false);
    assert.equal(tx.serverTake,false);

    assert.ok(
        sameCapturedProgram(tx,source)
    );

    /*
     * createProgramOutputEnvelope already freezes canonical
     * content, so mutate a detached clone instead.
     */
    const detached=structuredClone(source);

    detached.snapshot.scene.name='MUTATED';

    assert.equal(
        tx.capturedProgram.snapshot.scene.name,
        'PROGRAM A'
    );
});

test('transaction remains bound to event and source',()=>{
    const tx=captured();

    const next=transitionScheduledLiveTransaction(
        tx,
        'begin-preroll',
        {manualIntentRevision:11}
    );

    assert.equal(next.eventId,'scheduled-live-1');
    assert.equal(next.sourceId,'primecast');

    assert.ok(
        sameCapturedProgram(
            next,
            tx.capturedProgram
        )
    );
});

test('normal advisory sequence reaches RETURN_PENDING and COMPLETED',()=>{
    let tx=captured();

    tx=transitionScheduledLiveTransaction(
        tx,'begin-preroll',
        {manualIntentRevision:11}
    );

    assert.equal(tx.state,'PREROLL');

    tx=transitionScheduledLiveTransaction(
        tx,'begin-live',
        {manualIntentRevision:11}
    );

    assert.equal(tx.state,'LIVE');

    tx=transitionScheduledLiveTransaction(
        tx,'begin-postroll',
        {manualIntentRevision:11}
    );

    assert.equal(tx.state,'POSTROLL');

    tx=transitionScheduledLiveTransaction(
        tx,
        'prepare-return',
        {
            manualIntentRevision:11,
            currentProgram:program({
                revision:20,
                publisherSessionId:'automation',
                sceneId:'automation-scene',
                sourceId:'automation-source',
                initialTime:0
            })
        }
    );

    assert.equal(
        tx.state,
        'RETURN_PENDING'
    );

    const inspection=
        inspectScheduledLiveTransaction(
            tx,
            {manualIntentRevision:11}
        );

    assert.ok(
        sameCapturedProgram(
            tx,
            inspection.returnProgram
        )
    );

    tx=transitionScheduledLiveTransaction(
        tx,
        'complete',
        {manualIntentRevision:11}
    );

    assert.equal(tx.state,'COMPLETED');
    assert.equal(tx.executionAllowed,false);
    assert.equal(tx.serverTake,false);
});

test('current PROGRAM can never replace captured return PROGRAM',()=>{
    let tx=captured();

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

    const unrelated=program({
        revision:99,
        publisherSessionId:'other',
        sceneId:'other-scene',
        sourceId:'other-media',
        initialTime:80
    });

    tx=transitionScheduledLiveTransaction(
        tx,
        'prepare-return',
        {
            manualIntentRevision:11,
            currentProgram:unrelated
        }
    );

    const result=
        inspectScheduledLiveTransaction(
            tx,
            {manualIntentRevision:11}
        );

    assert.equal(
        result.returnProgram.snapshot.scene.id,
        'scene-a'
    );

    assert.equal(
        result.returnProgram.snapshot.source.id,
        'media-a'
    );

    assert.equal(
        result.returnProgram.snapshot.playback.initialTime,
        27
    );

    assert.notEqual(
        result.returnProgram.snapshot.scene.id,
        unrelated.snapshot.scene.id
    );
});

test('manual intent change aborts scheduled sequence immediately',()=>{
    const tx=captured();

    const result=
        transitionScheduledLiveTransaction(
            tx,
            'begin-preroll',
            {manualIntentRevision:12}
        );

    assert.equal(result.state,'ABORTED');

    assert.equal(
        result.reason,
        'MANUAL_INTENT_DOMINATES'
    );

    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);
});

test('inspection refuses return after manual intent change',()=>{
    let tx=captured();

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

    const result=
        inspectScheduledLiveTransaction(
            tx,
            {manualIntentRevision:12}
        );

    assert.equal(
        result.disposition,
        'MANUAL_INTENT_DOMINATES'
    );

    assert.equal(
        result.returnProgram,
        null
    );
});

test('illegal phase skipping is rejected',()=>{
    const tx=captured();

    assert.throws(
        ()=>transitionScheduledLiveTransaction(
            tx,
            'begin-live',
            {manualIntentRevision:11}
        ),
        /INVALID_TRANSACTION_TRANSITION/
    );
});

test('malformed PROGRAM cannot be captured',()=>{
    assert.throws(
        ()=>createScheduledLiveTransaction({
            eventId:'scheduled-live-1',
            sourceId:'primecast',
            program:{bad:true},
            manualIntentRevision:11,
            capturedAt:590000
        }),
        /INVALID_PROGRAM_ENVELOPE/
    );
});

test('scheduled LIVE transaction round-trips through canonical envelope',()=>{
    const tx=captured();

    const envelope=
        scheduledLiveTransactionEnvelope(tx);

    assert.equal(envelope.schemaVersion,1);
    assert.equal(
        envelope.mode,
        'NON_EXECUTING_SCHEDULED_LIVE'
    );

    assert.match(
        envelope.checksum,
        /^[a-f0-9]{64}$/
    );

    const restored=
        validateScheduledLiveTransactionEnvelope(
            structuredClone(envelope)
        );

    assert.deepEqual(
        restored,
        envelope
    );

    assert.equal(
        restored.record.executionAllowed,
        false
    );

    assert.equal(
        restored.record.serverTake,
        false
    );
});

test('checksum is deterministic for identical transaction',()=>{
    const tx=captured();

    assert.equal(
        scheduledLiveTransactionChecksum(tx),
        scheduledLiveTransactionChecksum(
            structuredClone(tx)
        )
    );
});

test('persisted transaction rejects captured PROGRAM tampering',()=>{
    const envelope=
        structuredClone(
            scheduledLiveTransactionEnvelope(
                captured()
            )
        );

    envelope.record.capturedProgram.snapshot.scene.name=
        'TAMPERED';

    assert.throws(
        ()=>validateScheduledLiveTransactionEnvelope(
            envelope
        ),
        /SCHEDULED_LIVE_TRANSACTION_CORRUPT/
    );
});

test('persisted transaction rejects state tampering',()=>{
    const envelope=
        structuredClone(
            scheduledLiveTransactionEnvelope(
                captured()
            )
        );

    envelope.record.state='LIVE';

    assert.throws(
        ()=>validateScheduledLiveTransactionEnvelope(
            envelope
        ),
        /SCHEDULED_LIVE_TRANSACTION_CORRUPT/
    );
});

test('persisted transaction can never grant execution authority',()=>{
    const tx=structuredClone(captured());

    tx.executionAllowed=true;

    assert.throws(
        ()=>normalizeScheduledLiveTransaction(tx),
        /EXECUTION_AUTHORITY_FORBIDDEN/
    );

    const other=structuredClone(captured());

    other.serverTake=true;

    assert.throws(
        ()=>normalizeScheduledLiveTransaction(other),
        /EXECUTION_AUTHORITY_FORBIDDEN/
    );
});

test('completed transaction persists only canonical terminal reason',()=>{
    let tx=captured();

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

    const restored=
        validateScheduledLiveTransactionEnvelope(
            structuredClone(
                scheduledLiveTransactionEnvelope(tx)
            )
        );

    assert.equal(
        restored.record.state,
        'COMPLETED'
    );

    assert.equal(
        restored.record.reason,
        'SEQUENCE_COMPLETED'
    );
});