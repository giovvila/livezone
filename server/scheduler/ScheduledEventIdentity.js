import {randomUUID} from 'node:crypto';
import {scheduledEntryIdentity} from './ScheduledEntryIdentity.js';

export const ENTRY_METADATA = Object.freeze(['incarnationId','entryRevision','entryMigration']);
export const ERA_ENTRY_METADATA = Object.freeze(['executionEraId','entryGrantHash']);
export function identityForScheduledEvent(event) {
    return scheduledEntryIdentity({eventId:event.id, incarnationId:event.incarnationId,
        entryRevision:event.entryRevision, type:event.type, sourceId:event.payload?.sourceId,
        startAt:event.startAt, endAt:event.endAt,...(event.executionEraId?{executionEraId:event.executionEraId,entryGrantHash:event.entryGrantHash}:{})});
}

// Use the canonical entryKey, including all era/grant identity fields. Removing
// LIVE is protective; enabling it adds executability without changing the key.
export function requiresLiveExecutionAuthority(previous,next) {
    if(next?.type!=='source.live')return false;
    return previous?.type!=='source.live'||
        identityForScheduledEvent(previous).entryKey!==identityForScheduledEvent(next).entryKey||
        (!previous.enabled&&next.enabled);
}

export function newEntryMetadata() {
    return {incarnationId:randomUUID(), entryRevision:1, entryMigration:null};
}

// Classification belongs to the original legacy incarnation, not the mutable
// current timestamps. Edits cannot erase legacy exclusion. No ledger access.
export function requiresLiveIdentityMigration(schedule) {
    return schedule.version !== 3 && schedule.events.some(e=>e.type === 'source.live');
}
export function migrateLiveIdentities(schedule, cutoffAt) {
    if (!requiresLiveIdentityMigration(schedule)) return schedule;
    if (!Number.isSafeInteger(schedule.revision+1)) throw Error('REVISION_EXHAUSTED');
    return {...schedule, version:3, revision:schedule.revision+1,
        liveIdentityMigration:{version:1,cutoffAt},
        events:schedule.events.map(event=>event.type !== 'source.live' ? event : {
            ...event, ...newEntryMetadata(), entryMigration:{cutoffAt,
                originalStartAt:event.startAt, originalEndAt:event.endAt,
                disposition:event.startAt <= cutoffAt ? 'EXCLUDED' : 'FUTURE'}
        })};
}
