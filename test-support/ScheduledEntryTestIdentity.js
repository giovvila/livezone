import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';
import {scheduledLiveProgramIdentity} from '../server/scheduler/ScheduledLiveProgramIdentity.js';
export function scheduledPublisher(owner,eventId){
    return scheduledLiveProgramIdentity({eventId,entryKey:identityForScheduledEvent(owner.scheduler.store.getEvent(eventId)).entryKey,revision:1}).publisherSessionId;
}
