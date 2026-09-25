const EVENT_ID =
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

export function scheduledLivePublisherSessionId(eventId){
    if(
        typeof eventId!=='string' ||
        !EVENT_ID.test(eventId)
    ){
        throw new TypeError(
            'INVALID_SCHEDULED_LIVE_EVENT_ID'
        );
    }

    return `scheduled:${eventId}`;
}

export function scheduledLiveProgramIdentity({
    eventId,
    revision
}={}){
    if(
        !Number.isSafeInteger(revision) ||
        revision < 1
    ){
        throw new TypeError(
            'INVALID_SCHEDULED_LIVE_PROGRAM_REVISION'
        );
    }

    return Object.freeze({
        publisherSessionId:
            scheduledLivePublisherSessionId(eventId),

        revision
    });
}
