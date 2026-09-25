import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeEvent,
    normalizeSchedule,
    resolveSchedule
} from '../server/scheduler/ScheduleContract.js';

const iso = ms => new Date(ms).toISOString();

function live({
    id = 'live-a',
    sourceId = 'live-camera-a',
    start = 10000,
    end = 20000,
    priority = 0,
    enabled = true,
    precheckSeconds = 180,
    unavailableAction = 'KEEP_PROGRAM',
    unavailableSceneId = null,
    endAction = 'RETURN',
    endSceneId = null
} = {}) {
    return {
        id,
        version: 1,
        type: 'source.live',
        enabled,
        startAt: iso(start),
        endAt: iso(end),
        priority,
        payload: {
            sourceId,
            precheckSeconds,
            unavailableAction,
            unavailableSceneId,
            endAction,
            endSceneId
        },
        createdAt: iso(1000),
        updatedAt: iso(1000)
    };
}

test('source.live canonicalizes scheduling policy without execution authority', () => {
    const event = normalizeEvent(live());

    assert.equal(event.type, 'source.live');
    assert.equal(event.payload.sourceId, 'live-camera-a');
    assert.equal(event.payload.precheckSeconds, 180);
    assert.equal(event.payload.unavailableAction, 'KEEP_PROGRAM');
    assert.equal(event.payload.unavailableSceneId, null);
    assert.equal(event.payload.endAction, 'RETURN');
    assert.equal(event.payload.endSceneId, null);

    assert.equal(Object.hasOwn(event, 'automaticTakeAuthority'), false);
    assert.equal(Object.hasOwn(event.payload, 'automaticTakeAuthority'), false);
});

test('source.live accepts explicit scene fallback and end scene', () => {
    const event = normalizeEvent(live({
        unavailableAction: 'TAKE_SCENE',
        unavailableSceneId: 'scene-break',
        endAction: 'TAKE_SCENE',
        endSceneId: 'scene-after'
    }));

    assert.equal(event.payload.unavailableSceneId, 'scene-break');
    assert.equal(event.payload.endSceneId, 'scene-after');
});

test('source.live rejects inconsistent scene actions', () => {
    assert.throws(
        () => normalizeEvent(live({
            unavailableAction: 'KEEP_PROGRAM',
            unavailableSceneId: 'scene-break'
        })),
        /INVALID_PAYLOAD/
    );

    assert.throws(
        () => normalizeEvent(live({
            endAction: 'RETURN',
            endSceneId: 'scene-after'
        })),
        /INVALID_PAYLOAD/
    );
});

test('source.live precheck is bounded to fifteen minutes', () => {
    assert.throws(
        () => normalizeEvent(live({ precheckSeconds: 901 })),
        /INVALID_PAYLOAD/
    );

    assert.doesNotThrow(
        () => normalizeEvent(live({ precheckSeconds: 900 }))
    );
});

test('overlapping LIVE events resolve to exactly one winner by priority', () => {
    const schedule = normalizeSchedule({
        version: 1,
        revision: 1,
        events: [
            live({
                id: 'live-low',
                sourceId: 'camera-low',
                priority: 1
            }),
            live({
                id: 'live-high',
                sourceId: 'camera-high',
                priority: 20
            })
        ]
    });

    const resolved = resolveSchedule(schedule, 15000);
    const lives = resolved.activeEvents.filter(
        event => event.type === 'source.live'
    );

    assert.equal(lives.length, 1);
    assert.equal(lives[0].id, 'live-high');
    assert.equal(lives[0].payload.sourceId, 'camera-high');
});

test('same-priority overlapping LIVE uses later start deterministically', () => {
    const schedule = normalizeSchedule({
        version: 1,
        revision: 1,
        events: [
            live({
                id: 'live-early',
                sourceId: 'camera-early',
                start: 9000,
                end: 20000,
                priority: 10
            }),
            live({
                id: 'live-late',
                sourceId: 'camera-late',
                start: 12000,
                end: 20000,
                priority: 10
            })
        ]
    });

    const resolved = resolveSchedule(schedule, 15000);
    const winner = resolved.activeEvents.find(
        event => event.type === 'source.live'
    );

    assert.equal(winner.id, 'live-late');
});

test('disabled and expired LIVE events cannot become active', () => {
    const schedule = normalizeSchedule({
        version: 1,
        revision: 1,
        events: [
            live({
                id: 'disabled',
                enabled: false,
                start: 10000,
                end: 20000
            }),
            live({
                id: 'expired',
                start: 1000,
                end: 5000
            })
        ]
    });

    const resolved = resolveSchedule(schedule, 15000);

    assert.equal(
        resolved.activeEvents.some(event => event.type === 'source.live'),
        false
    );
});

test('scheduler data cannot smuggle automatic TAKE authority', () => {
    const value = live();

    value.payload.automaticTakeAuthority = true;

    assert.throws(
        () => normalizeEvent(value),
        /INVALID_PAYLOAD/
    );
});

test('source.live precheck boundary is an authoritative scheduler deadline', () => {
    const schedule = normalizeSchedule({
        version:1,
        revision:1,
        events:[
            live({
                id:'deadline-live',
                sourceId:'camera-deadline',
                start:600000,
                end:1200000,
                priority:10,
                precheckSeconds:180
            })
        ]
    });

    const before=resolveSchedule(schedule,100000);

    assert.equal(
        before.nextDeadline,
        420000,
        'scheduler must wake exactly at startAt - precheck'
    );

    const atPrecheck=resolveSchedule(schedule,420000);

    assert.equal(
        atPrecheck.nextDeadline,
        590000,
        'after precheck boundary the next deadline must be PRE_ROLL'
    );

    const atPreRoll=resolveSchedule(schedule,590000);

    assert.equal(
        atPreRoll.nextDeadline,
        600000,
        'after PRE_ROLL the next deadline must be startAt'
    );

    const atStart=resolveSchedule(schedule,600000);

    assert.equal(
        atStart.nextDeadline,
        1200000,
        'after startAt the next deadline must be endAt'
    );
});

test('source.live zero-second precheck does not invent an earlier deadline', () => {
    const schedule=normalizeSchedule({
        version:1,
        revision:1,
        events:[
            live({
                id:'deadline-zero',
                start:600000,
                end:1200000,
                precheckSeconds:0
            })
        ]
    });

    assert.equal(
        resolveSchedule(schedule,100000).nextDeadline,
        590000,
        'PRE_ROLL remains authoritative even with zero-second health precheck'
    );

    assert.equal(
        resolveSchedule(schedule,590000).nextDeadline,
        600000
    );
});

test('disabled source.live contributes no precheck deadline', () => {
    const value=live({
        id:'deadline-disabled',
        start:600000,
        end:1200000,
        precheckSeconds:180
    });

    value.enabled=false;

    const schedule=normalizeSchedule({
        version:1,
        revision:1,
        events:[value]
    });

    assert.equal(
        resolveSchedule(schedule,100000).nextDeadline,
        null
    );
});

test('source.live exposes PRECHECK PRE_ROLL START END and POST_ROLL_END deadlines', () => {
    const schedule=normalizeSchedule({
        version:1,
        revision:1,
        events:[
            live({
                id:'live-sequence-deadlines',
                start:600000,
                end:1200000,
                precheckSeconds:180
            })
        ]
    });

    assert.equal(resolveSchedule(schedule,100000).nextDeadline,420000);
    assert.equal(resolveSchedule(schedule,420000).nextDeadline,590000);
    assert.equal(resolveSchedule(schedule,590000).nextDeadline,600000);
    assert.equal(resolveSchedule(schedule,600000).nextDeadline,1200000);
    assert.equal(resolveSchedule(schedule,1200000).nextDeadline,1203000);
    assert.equal(resolveSchedule(schedule,1203000).nextDeadline,null);
});
