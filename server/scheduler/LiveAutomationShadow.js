const STATES = Object.freeze([
    'SCHEDULED',
    'PRECHECK',
    'TRANSPORT_READY',
    'UNAVAILABLE',
    'UNCERTAIN',
    'PREROLL_REQUESTED',
    'TAKE_REQUESTED',
    'FALLBACK_REQUESTED',
    'LIVE_ACTIVE_REQUESTED',
    'POSTROLL_REQUESTED',
    'RETURN_REQUESTED',
    'COMPLETED'
]);

const PRE_ROLL_MS = 10000;
const POST_ROLL_MS = 3000;

const freeze = value => Object.freeze(value);

const fail = code => {
    throw Object.assign(new Error(code), {code});
};

function validEvent(event) {
    return Boolean(
        event &&
        event.type === 'source.live' &&
        event.enabled === true &&
        Number.isFinite(Date.parse(event.startAt)) &&
        Number.isFinite(Date.parse(event.endAt)) &&
        Date.parse(event.endAt) > Date.parse(event.startAt) &&
        event.payload &&
        typeof event.payload.sourceId === 'string' &&
        Number.isInteger(event.payload.precheckSeconds)
    );
}

function healthClass(health, sourceId, now) {
    if (!health)
        return 'NO_EVIDENCE';

    if (health.sourceId !== sourceId)
        return 'SOURCE_MISMATCH';

    if (
        health.freshness !== 'FRESH' ||
        !Number.isSafeInteger(health.validUntil) ||
        now >= health.validUntil
    ) {
        return 'STALE';
    }

    if (health.state === 'OFFLINE')
        return 'UNAVAILABLE';

    if (
        health.state === 'ONLINE' &&
        health.playlistProgressing === true &&
        health.segmentReachable === true
    ) {
        return 'TRANSPORT_READY';
    }

    return 'UNCERTAIN';
}

function unavailableIntent(event) {
    return freeze({
        kind:'LIVE_UNAVAILABLE',
        action:event.payload.unavailableAction,
        sceneId:event.payload.unavailableSceneId
    });
}

export function evaluateLiveAutomation({
    event,
    health = null,
    now
} = {}) {
    if (!validEvent(event))
        fail('LIVE_EVENT_INVALID');

    if (!Number.isSafeInteger(now) || now < 0)
        fail('CLOCK_INVALID');

    const start = Date.parse(event.startAt);
    const end = Date.parse(event.endAt);

    const precheckAt =
        start - event.payload.precheckSeconds * 1000;

    const preRollAt =
        start - PRE_ROLL_MS;

    const postRollEndAt =
        end + POST_ROLL_MS;

    const healthStatus =
        healthClass(health,event.payload.sourceId,now);

    let state;
    let intent=null;
    let reason;

    /*
     * Sequence after LIVE end no longer depends on transport
     * health. The LIVE has already completed.
     */
    if(now > postRollEndAt){
        state='COMPLETED';
        reason='SEQUENCE_COMPLETED';
    }
    else if(now === postRollEndAt){
        state='RETURN_REQUESTED';
        reason='POSTROLL_COMPLETE';

        intent=freeze({
            kind:'RESTORE_PROGRAM',
            action:event.payload.endAction,
            sceneId:event.payload.endSceneId
        });
    }
    else if(now >= end){
        state='POSTROLL_REQUESTED';
        reason='LIVE_ENDED';

        intent=freeze({
            kind:'SHOW_BLACK',
            durationMs:POST_ROLL_MS
        });
    }

    /*
     * LIVE interval.
     *
     * TAKE is emitted only on the exact START boundary.
     * Later evaluations describe the already-requested LIVE
     * interval rather than repeatedly issuing TAKE.
     */
    else if(now > start){
        state='LIVE_ACTIVE_REQUESTED';
        reason='LIVE_INTERVAL_ACTIVE';

        intent=freeze({
            kind:'KEEP_LIVE',
            sourceId:event.payload.sourceId
        });
    }
    else if(now === start){
        if(healthStatus==='TRANSPORT_READY'){
            state='TAKE_REQUESTED';
            reason='START_DUE_TRANSPORT_READY';

            intent=freeze({
                kind:'TAKE_LIVE',
                sourceId:event.payload.sourceId
            });
        }
        else{
            state='FALLBACK_REQUESTED';

            reason=healthStatus==='UNAVAILABLE'
                ? 'START_DUE_SOURCE_OFFLINE'
                : 'START_DUE_INSUFFICIENT_EVIDENCE';

            intent=unavailableIntent(event);
        }
    }

    /*
     * Visible ten-second pre-roll.
     * It is requested only when transport evidence is ready.
     * Otherwise no misleading "live is about to start" slate
     * is requested.
     */
    else if(now >= preRollAt){
        if(healthStatus==='TRANSPORT_READY'){
            state='PREROLL_REQUESTED';
            reason='PREROLL_DUE_TRANSPORT_READY';

            intent=freeze({
                kind:'SHOW_LIVE_PREROLL',
                durationMs:PRE_ROLL_MS,
                sourceId:event.payload.sourceId
            });
        }
        else{
            state='FALLBACK_REQUESTED';

            reason=healthStatus==='UNAVAILABLE'
                ? 'PREROLL_DUE_SOURCE_OFFLINE'
                : 'PREROLL_DUE_INSUFFICIENT_EVIDENCE';

            intent=unavailableIntent(event);
        }
    }

    /*
     * Health precheck.
     */
    else if(now < precheckAt){
        state='SCHEDULED';
        reason='WAITING_FOR_PRECHECK';
    }
    else if(healthStatus==='TRANSPORT_READY'){
        state='TRANSPORT_READY';
        reason='TRANSPORT_EVIDENCE_READY';
    }
    else if(healthStatus==='UNAVAILABLE'){
        state='UNAVAILABLE';
        reason='SOURCE_OFFLINE';
    }
    else{
        state='PRECHECK';
        reason=healthStatus;
    }

    return freeze({
        version:1,
        eventId:event.id,
        sourceId:event.payload.sourceId,
        state,
        reason,
        healthStatus,

        precheckAt:new Date(precheckAt).toISOString(),
        preRollAt:new Date(preRollAt).toISOString(),
        startAt:event.startAt,
        endAt:event.endAt,
        postRollEndAt:new Date(postRollEndAt).toISOString(),

        intent,

        /*
         * Advisory sequence only.
         * None of these intents may mutate PROGRAM yet.
         */
        automaticTakeAuthority:false,
        executionAllowed:false,
        serverTake:false
    });
}

export {
    STATES as LIVE_AUTOMATION_SHADOW_STATES,
    PRE_ROLL_MS,
    POST_ROLL_MS
};
