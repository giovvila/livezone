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
    entryKey,
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

    const legacyPublisher=scheduledLivePublisherSessionId(eventId);
    if(entryKey!==undefined && (typeof entryKey!=='string' || !/^[a-f0-9]{64}$/.test(entryKey)))throw new TypeError('INVALID_SCHEDULED_ENTRY_KEY');
    return Object.freeze({
        publisherSessionId:
            entryKey===undefined?legacyPublisher:`scheduled-entry:${entryKey}`,

        revision
    });
}
