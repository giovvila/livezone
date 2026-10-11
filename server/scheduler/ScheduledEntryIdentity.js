import {createHash} from 'node:crypto';

const fail = () => { throw new TypeError('INVALID_SCHEDULED_ENTRY_IDENTITY'); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export function entryTimestamp(value) {
    // Require an explicit offset, reject local-time parsing and normalized invalid dates.
    const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) fail();
    const [,year,month,day,hour,minute,second,,zone] = match;
    const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== `${year}-${month}-${day}` ||
        +hour > 23 || +minute > 59 || +second > 59 ||
        (zone !== 'Z' && (+zone.slice(1,3) > 23 || +zone.slice(4) > 59))) fail();
    const time = Date.parse(value);
    if (!Number.isFinite(time)) fail();
    return new Date(time).toISOString();
}

// Select only executable identity fields. Editorial/global schedule revisions
// are intentionally irrelevant. No ScheduleContract production format change.
export function scheduledEntryIdentity(value) {
    const era=value?.executionEraId!==undefined;
    if (!value || (value.identitySchema !== undefined && value.identitySchema !== (era?2:1)) ||
        (era&&(!uuid(value.executionEraId)||typeof value.entryGrantHash!=='string'||!/^[a-f0-9]{64}$/.test(value.entryGrantHash))) ||
        (!era&&value.entryGrantHash!==undefined) || !id(value.eventId) || !uuid(value.incarnationId) ||
        !Number.isSafeInteger(value.entryRevision) || value.entryRevision < 1 ||
        value.type !== 'source.live' || !id(value.sourceId)) fail();
    const identity = {
        identitySchema:era?2:1,...(era?{executionEraId:value.executionEraId.toLowerCase(),entryGrantHash:value.entryGrantHash}:{}), eventId:value.eventId,
        incarnationId:value.incarnationId.toLowerCase(), entryRevision:value.entryRevision,
        type:'source.live', sourceId:value.sourceId,
        startAt:entryTimestamp(value.startAt), endAt:entryTimestamp(value.endAt)
    };
    if (identity.endAt <= identity.startAt) fail();
    const entryKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    if (value.entryKey !== undefined && value.entryKey !== entryKey) fail();
    return Object.freeze({...identity, entryKey});
}
