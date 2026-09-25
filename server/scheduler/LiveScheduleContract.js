const ID = /^[a-zA-Z0-9_-]{1,128}$/;

export const LIVE_END_ACTIONS = Object.freeze([
    'RETURN',
    'TAKE_SCENE',
    'RADIO',
    'HOLD'
]);

export const LIVE_UNAVAILABLE_ACTIONS = Object.freeze([
    'KEEP_PROGRAM',
    'TAKE_SCENE',
    'RADIO'
]);

export const LIVE_EVENT_STATES = Object.freeze([
    'SCHEDULED',
    'PRECHECK',
    'ACTIVE',
    'COMPLETED',
    'FAILED',
    'CANCELLED'
]);

const fail = code => {
    throw Object.assign(new Error(code), { code });
};

const id = value =>
    typeof value === 'string' && ID.test(value)
        ? value
        : null;

function timestamp(value) {
    if (typeof value !== 'string') return null;

    const ms = Date.parse(value);

    if (!Number.isFinite(ms)) return null;

    /*
     * Require an explicit timezone. Scheduler persistence must never depend
     * on the server machine's local timezone.
     */
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;

    return new Date(ms).toISOString();
}

export function normalizeLiveSchedule(value) {
    if (!value || typeof value !== 'object')
        fail('LIVE_SCHEDULE_INVALID');

    const eventId = id(value.eventId);
    const sourceId = id(value.sourceId);
    const startAt = timestamp(value.startAt);

    if (!eventId) fail('EVENT_ID_INVALID');
    if (!sourceId) fail('SOURCE_ID_INVALID');
    if (!startAt) fail('START_AT_INVALID');

    if (
        !Number.isSafeInteger(value.durationMs) ||
        value.durationMs < 1000 ||
        value.durationMs > 24 * 60 * 60 * 1000
    ) {
        fail('DURATION_INVALID');
    }

    const endAction = LIVE_END_ACTIONS.includes(value.endAction)
        ? value.endAction
        : 'RETURN';

    const unavailableAction =
        LIVE_UNAVAILABLE_ACTIONS.includes(value.unavailableAction)
            ? value.unavailableAction
            : 'KEEP_PROGRAM';

    const endSceneId =
        endAction === 'TAKE_SCENE'
            ? id(value.endSceneId)
            : null;

    const unavailableSceneId =
        unavailableAction === 'TAKE_SCENE'
            ? id(value.unavailableSceneId)
            : null;

    if (endAction === 'TAKE_SCENE' && !endSceneId)
        fail('END_SCENE_REQUIRED');

    if (
        unavailableAction === 'TAKE_SCENE' &&
        !unavailableSceneId
    ) {
        fail('UNAVAILABLE_SCENE_REQUIRED');
    }

    return Object.freeze({
        eventId,
        sourceId,
        startAt,
        durationMs: value.durationMs,
        precheckMs:
            Number.isSafeInteger(value.precheckMs) &&
            value.precheckMs >= 0 &&
            value.precheckMs <= 15 * 60 * 1000
                ? value.precheckMs
                : 3 * 60 * 1000,

        endAction,
        endSceneId,
        unavailableAction,
        unavailableSceneId,

        state: LIVE_EVENT_STATES.includes(value.state)
            ? value.state
            : 'SCHEDULED',

        /*
         * Scheduling data can describe an intended TAKE but cannot authorize
         * one. Authority will be introduced behind a separate server gate.
         */
        automaticTakeAuthority: false
    });
}

export function liveScheduleWindow(value) {
    const event = normalizeLiveSchedule(value);
    const start = Date.parse(event.startAt);

    return Object.freeze({
        precheckAt: new Date(start - event.precheckMs).toISOString(),
        startAt: event.startAt,
        endAt: new Date(start + event.durationMs).toISOString()
    });
}
