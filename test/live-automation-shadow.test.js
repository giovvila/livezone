import test from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateLiveAutomation
} from '../server/scheduler/LiveAutomationShadow.js';

const iso = ms => new Date(ms).toISOString();

const event = (overrides = {}) => ({
    id: 'event-live-1',
    version: 1,
    type: 'source.live',
    enabled: true,
    startAt: iso(600000),
    endAt: iso(1200000),
    priority: 0,
    payload: {
        sourceId: 'live-camera-1',
        precheckSeconds: 180,
        unavailableAction: 'KEEP_PROGRAM',
        unavailableSceneId: null,
        endAction: 'RETURN',
        endSceneId: null
    },
    createdAt: iso(1000),
    updatedAt: iso(1000),
    ...overrides
});

const health = ({
    now,
    state = 'ONLINE',
    playlistProgressing = true,
    segmentReachable = true,
    freshness = 'FRESH',
    sourceId = 'live-camera-1'
}) => ({
    sourceId,
    state,
    playlistProgressing,
    segmentReachable,
    freshness,
    validUntil: now + 10000
});

test('future LIVE remains scheduled before precheck window', () => {
    const result = evaluateLiveAutomation({
        event: event(),
        now: 100000
    });

    assert.equal(result.state, 'SCHEDULED');
    assert.equal(result.intent, null);
});

test('precheck reports transport-ready without granting TAKE', () => {
    const now = 500000;

    const result = evaluateLiveAutomation({
        event: event(),
        health: health({now}),
        now
    });

    assert.equal(result.state, 'TRANSPORT_READY');
    assert.equal(result.healthStatus, 'TRANSPORT_READY');
    assert.equal(result.intent, null);
    assert.equal(result.automaticTakeAuthority, false);
    assert.equal(result.executionAllowed, false);
    assert.equal(result.serverTake, false);
});

test('precheck preserves explicit offline state', () => {
    const now = 500000;

    const result = evaluateLiveAutomation({
        event: event(),
        health: health({now,state:'OFFLINE'}),
        now
    });

    assert.equal(result.state, 'UNAVAILABLE');
    assert.equal(result.intent, null);
});

test('start boundary creates TAKE intent but cannot execute it', () => {
    const now = 600000;

    const result = evaluateLiveAutomation({
        event: event(),
        health: health({now}),
        now
    });

    assert.equal(result.state, 'TAKE_REQUESTED');
    assert.deepEqual(result.intent,{
        kind:'TAKE_LIVE',
        sourceId:'live-camera-1'
    });

    assert.equal(result.automaticTakeAuthority,false);
    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);
});

test('offline source at start produces safe fallback intent', () => {
    const now = 600000;

    const result = evaluateLiveAutomation({
        event: event(),
        health: health({now,state:'OFFLINE'}),
        now
    });

    assert.equal(result.state,'FALLBACK_REQUESTED');
    assert.deepEqual(result.intent,{
        kind:'LIVE_UNAVAILABLE',
        action:'KEEP_PROGRAM',
        sceneId:null
    });
    assert.equal(result.serverTake,false);
});

test('missing evidence at start fails closed to fallback intent', () => {
    const result = evaluateLiveAutomation({
        event:event(),
        health:null,
        now:600000
    });

    assert.equal(result.state,'FALLBACK_REQUESTED');
    assert.equal(
        result.reason,
        'START_DUE_INSUFFICIENT_EVIDENCE'
    );
    assert.equal(result.executionAllowed,false);
});

test('ONLINE alone is insufficient without playlist and segment progression', () => {
    const now=600000;

    const result=evaluateLiveAutomation({
        event:event(),
        health:health({
            now,
            playlistProgressing:false,
            segmentReachable:true
        }),
        now
    });

    assert.equal(result.state,'FALLBACK_REQUESTED');
    assert.equal(result.healthStatus,'UNCERTAIN');
});

test('stale evidence cannot request TAKE', () => {
    const now=600000;

    const sample=health({now});
    sample.validUntil=now;

    const result=evaluateLiveAutomation({
        event:event(),
        health:sample,
        now
    });

    assert.equal(result.state,'FALLBACK_REQUESTED');
    assert.equal(result.healthStatus,'STALE');
    assert.equal(result.serverTake,false);
});

test('health from another source cannot request TAKE', () => {
    const now=600000;

    const result=evaluateLiveAutomation({
        event:event(),
        health:health({
            now,
            sourceId:'other-live'
        }),
        now
    });

    assert.equal(result.state,'FALLBACK_REQUESTED');
    assert.equal(result.healthStatus,'SOURCE_MISMATCH');
});

test('LIVE end enters post-roll rather than completing immediately', () => {
    const result=evaluateLiveAutomation({
        event:event(),
        now:1200000
    });

    assert.equal(result.state,'POSTROLL_REQUESTED');
    assert.deepEqual(result.intent,{
        kind:'SHOW_BLACK',
        durationMs:3000
    });
    assert.equal(result.serverTake,false);
});

test('T-10 healthy LIVE requests advisory pre-roll only', () => {
    const now=590000;

    const result=evaluateLiveAutomation({
        event:event(),
        health:health({now}),
        now
    });

    assert.equal(result.state,'PREROLL_REQUESTED');

    assert.deepEqual(result.intent,{
        kind:'SHOW_LIVE_PREROLL',
        durationMs:10000,
        sourceId:'live-camera-1'
    });

    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);
});

test('T-10 unhealthy LIVE never requests misleading pre-roll', () => {
    const now=590000;

    const result=evaluateLiveAutomation({
        event:event(),
        health:health({
            now,
            state:'OFFLINE'
        }),
        now
    });

    assert.equal(result.state,'FALLBACK_REQUESTED');
    assert.equal(result.intent.kind,'LIVE_UNAVAILABLE');
    assert.equal(result.serverTake,false);
});

test('after START the shadow sequence describes active LIVE without repeating TAKE', () => {
    const now=700000;

    const result=evaluateLiveAutomation({
        event:event(),
        health:health({now}),
        now
    });

    assert.equal(
        result.state,
        'LIVE_ACTIVE_REQUESTED'
    );

    assert.deepEqual(result.intent,{
        kind:'KEEP_LIVE',
        sourceId:'live-camera-1'
    });

    assert.equal(result.serverTake,false);
});

test('LIVE END requests three-second black post-roll', () => {
    const now=1200000;

    const result=evaluateLiveAutomation({
        event:event(),
        now
    });

    assert.equal(
        result.state,
        'POSTROLL_REQUESTED'
    );

    assert.deepEqual(result.intent,{
        kind:'SHOW_BLACK',
        durationMs:3000
    });

    assert.equal(result.executionAllowed,false);
});

test('inside post-roll remains black without health evidence', () => {
    const now=1202000;

    const result=evaluateLiveAutomation({
        event:event(),
        now
    });

    assert.equal(
        result.state,
        'POSTROLL_REQUESTED'
    );

    assert.equal(
        result.intent.kind,
        'SHOW_BLACK'
    );
});

test('post-roll boundary requests restoration of interrupted PROGRAM', () => {
    const now=1203000;

    const result=evaluateLiveAutomation({
        event:event(),
        now
    });

    assert.equal(
        result.state,
        'RETURN_REQUESTED'
    );

    assert.deepEqual(result.intent,{
        kind:'RESTORE_PROGRAM',
        action:'RETURN',
        sceneId:null
    });

    assert.equal(result.serverTake,false);
});

test('LIVE sequence completes only after post-roll restoration boundary', () => {
    const result=evaluateLiveAutomation({
        event:event(),
        now:1203001
    });

    assert.equal(result.state,'COMPLETED');
    assert.equal(result.intent,null);
    assert.equal(result.serverTake,false);
});
