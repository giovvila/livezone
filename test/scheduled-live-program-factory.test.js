import test from 'node:test';
import assert from 'node:assert/strict';

import {
    validateProgramOutputEnvelope
} from '../public/js/program-output/ProgramOutputEnvelope.js';

import {
    createScheduledLivePreroll,
    SCHEDULED_LIVE_PREROLL
} from '../server/scheduler/ScheduledLiveProgramFactory.js';

const LOGO='http://127.0.0.1:8080/assets/logo/logo-lz.svg';

function preroll(change={}){
    return createScheduledLivePreroll({
        eventId:'scheduled-live-1',
        publisherSessionId:'scheduled-live-server',
        revision:1,
        now:590000,
        logoUrl:LOGO,
        ...change
    });
}

test('scheduled LIVE preroll is canonical PROGRAM envelope',()=>{
    const envelope=preroll();

    assert.ok(
        validateProgramOutputEnvelope(envelope)
    );

    assert.equal(envelope.protocolVersion,1);

    assert.equal(
        envelope.publisherSessionId,
        'scheduled-live-server'
    );

    assert.equal(envelope.revision,1);
});

test('scheduled LIVE preroll uses canonical SLATE break representation',()=>{
    const envelope=preroll();

    assert.equal(
        envelope.snapshot.scene.type,
        'SLATE'
    );

    assert.equal(
        envelope.snapshot.source.kind,
        'break'
    );

    assert.equal(
        envelope.snapshot.source.id,
        'scheduled-live-preroll'
    );
});

test('scheduled LIVE preroll displays requested broadcast-safe presentation',()=>{
    const envelope=preroll();

    assert.equal(
        envelope.snapshot.source.title,
        'LIVEZONE'
    );

    assert.equal(
        envelope.snapshot.source.message,
        'TRA POCO IN DIRETTA'
    );

    assert.equal(
        envelope.snapshot.source.logoUrl,
        LOGO
    );

    assert.deepEqual(
        SCHEDULED_LIVE_PREROLL,
        {
            title:'LIVEZONE',
            message:'TRA POCO IN DIRETTA'
        }
    );
});

test('scheduled LIVE preroll is uniquely bound to event identity',()=>{
    const first=preroll({
        eventId:'scheduled-live-1'
    });

    const second=preroll({
        eventId:'scheduled-live-2'
    });

    assert.equal(
        first.snapshot.scene.id,
        'scheduled-live-preroll-scheduled-live-1'
    );

    assert.equal(
        second.snapshot.scene.id,
        'scheduled-live-preroll-scheduled-live-2'
    );

    assert.notEqual(
        first.snapshot.scene.id,
        second.snapshot.scene.id
    );
});

test('scheduled LIVE preroll uses cut and non-playing slate playback',()=>{
    const envelope=preroll();

    assert.deepEqual(
        envelope.snapshot.transition,
        {
            type:'cut',
            durationMs:0
        }
    );

    assert.deepEqual(
        envelope.snapshot.playback,
        {
            initialTime:0,
            duration:null,
            playing:false,
            ended:false,
            state:'ready',
            startedAt:new Date(590000).toISOString()
        }
    );
});

test('revision and timestamps are supplied by execution context',()=>{
    const envelope=preroll({
        revision:17,
        now:123456789
    });

    const expected=
        new Date(123456789).toISOString();

    assert.equal(envelope.revision,17);
    assert.equal(envelope.snapshot.revision,17);
    assert.equal(envelope.publishedAt,expected);
    assert.equal(envelope.snapshot.committedAt,expected);
});

test('relative logo URL is rejected before PROGRAM construction',()=>{
    assert.throws(
        ()=>preroll({
            logoUrl:'../assets/logo/logo-lz.svg'
        }),
        /INVALID_SCHEDULED_LIVE_PREROLL/
    );
});

test('http and https absolute logo URLs are accepted',()=>{
    assert.ok(
        preroll({
            logoUrl:'http://localhost:8080/assets/logo/logo-lz.svg'
        })
    );

    assert.ok(
        preroll({
            logoUrl:'https://livezone.example/assets/logo/logo-lz.svg'
        })
    );
});

test('invalid identity and revision are rejected',()=>{
    assert.throws(
        ()=>preroll({eventId:'bad id'}),
        /INVALID_SCHEDULED_LIVE_PREROLL/
    );

    assert.throws(
        ()=>preroll({revision:0}),
        /INVALID_SCHEDULED_LIVE_PREROLL/
    );

    assert.throws(
        ()=>preroll({publisherSessionId:''}),
        /INVALID_SCHEDULED_LIVE_PREROLL/
    );
});

test('factory constructs candidate only and has no execution authority',()=>{
    const envelope=preroll();

    assert.equal(
        Object.hasOwn(envelope,'executionAllowed'),
        false
    );

    assert.equal(
        Object.hasOwn(envelope,'serverTake'),
        false
    );
});
