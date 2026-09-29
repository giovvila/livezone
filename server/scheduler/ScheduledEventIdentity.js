import {randomUUID} from 'node:crypto';
import {scheduledEntryIdentity} from './ScheduledEntryIdentity.js';

export const ENTRY_METADATA = Object.freeze(['incarnationId','entryRevision','entryMigration']);
export function identityForScheduledEvent(event) {
    return scheduledEntryIdentity({eventId:event.id, incarnationId:event.incarnationId,
        entryRevision:event.entryRevision, type:event.type, sourceId:event.payload?.sourceId,
        startAt:event.startAt, endAt:event.endAt});
}

export function newEntryMetadata() {
    return {incarnationId:randomUUID(), entryRevision:1, entryMigration:null};
}

// Classification belongs to the original legacy incarnation, not the mutable
// current timestamps. Edits cannot erase legacy exclusion. No ledger access.
export function migrateLiveIdentities(schedule, cutoffAt) {
    if (schedule.version === 3 || !schedule.events.some(e=>e.type === 'source.live')) return schedule;
    if (!Number.isSafeInteger(schedule.revision+1)) throw Error('REVISION_EXHAUSTED');
    return {...schedule, version:3, revision:schedule.revision+1,
        liveIdentityMigration:{version:1,cutoffAt},
        events:schedule.events.map(event=>event.type !== 'source.live' ? event : {
            ...event, ...newEntryMetadata(), entryMigration:{cutoffAt,
                originalStartAt:event.startAt, originalEndAt:event.endAt,
                disposition:event.startAt <= cutoffAt ? 'EXCLUDED' : 'FUTURE'}
        })};
}
