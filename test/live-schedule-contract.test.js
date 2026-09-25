import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeLiveSchedule,
    liveScheduleWindow
} from '../server/scheduler/LiveScheduleContract.js';

test('LIVE event has explicit start duration precheck and safe defaults', () => {
    const event = normalizeLiveSchedule({
        eventId: 'event-1',
        sourceId: 'live-camera-1',
        startAt: '2026-09-28T20:30:00+02:00',
        durationMs: 2 * 60 * 60 * 1000
    });

    assert.equal(event.endAction, 'RETURN');
    assert.equal(event.unavailableAction, 'KEEP_PROGRAM');
    assert.equal(event.precheckMs, 180000);
    assert.equal(event.automaticTakeAuthority, false);

    const window = liveScheduleWindow(event);

    assert.equal(window.startAt, '2026-09-28T18:30:00.000Z');
    assert.equal(window.precheckAt, '2026-09-28T18:27:00.000Z');
    assert.equal(window.endAt, '2026-09-28T20:30:00.000Z');
});

test('scheduled TAKE_SCENE requires an explicit target scene', () => {
    assert.throws(
        () => normalizeLiveSchedule({
            eventId: 'event-2',
            sourceId: 'live-camera-1',
            startAt: '2026-09-28T20:30:00+02:00',
            durationMs: 60000,
            endAction: 'TAKE_SCENE'
        }),
        /END_SCENE_REQUIRED/
    );
});

test('schedule rejects local-time timestamps without timezone', () => {
    assert.throws(
        () => normalizeLiveSchedule({
            eventId: 'event-3',
            sourceId: 'live-camera-1',
            startAt: '2026-09-28T20:30:00',
            durationMs: 60000
        }),
        /START_AT_INVALID/
    );
});

test('schedule data never grants automatic TAKE authority', () => {
    const event = normalizeLiveSchedule({
        eventId: 'event-4',
        sourceId: 'live-camera-1',
        startAt: '2026-09-28T20:30:00+02:00',
        durationMs: 60000,
        automaticTakeAuthority: true
    });

    assert.equal(event.automaticTakeAuthority, false);
});
