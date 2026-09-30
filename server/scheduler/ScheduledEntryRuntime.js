import {open,lstat,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import ScheduledEntryLedgerRepository from './ScheduledEntryLedgerRepository.js';
import {identityForScheduledEvent} from './ScheduledEventIdentity.js';
import {resolveSchedule} from './ScheduleContract.js';
import {evaluateLiveAutomation} from './LiveAutomationShadow.js';

// Marker is a bootstrap reservation, never a recovery authorization. A crash
// between marker and ledger creation deliberately requires explicit maintenance.
export async function initializeEntryLedger({path,ownership,startupSchedule,executionRepository,bootstrap=false,options={}}){
    let create=false;
    try{
        if(!ownership.available)throw Error('AUTHORITY_UNAVAILABLE');
        if(executionRepository.status!=='READY')throw Error('EXECUTION_JOURNAL_UNAVAILABLE');
        if(!startupSchedule)throw Error('MIGRATION_INCOMPLETE');
        for(const event of startupSchedule.events){
            if(event.type==='source.live')identityForScheduledEvent(event);
        }
        try{await lstat(path);}catch(error){
            if(error.code!=='ENOENT')throw error;
            const safeSchedule=startupSchedule.events.every(e=>e.type!=='source.live' || Boolean(e.entryMigration));
            if(!safeSchedule || executionRepository.record || !(ownership.authorityEpoch===1 || bootstrap))throw Error('LEDGER_BOOTSTRAP_REQUIRED');
            await mkdir(dirname(path),{recursive:true});
            const marker=await open(path+'.bootstrap','wx',0o600);
            try{await marker.writeFile(JSON.stringify({version:1,authorityEpoch:ownership.authorityEpoch}));await marker.sync();}
            finally{await marker.close();}
            create=true;
        }
    }catch(error){
        const ledger=new ScheduledEntryLedgerRepository({...options,path,create:false});
        // Do not let a missing path be treated as an initial installation.
        ledger.error=error.code||error.message;
        ledger.initializing=Promise.resolve();
        return ledger;
    }
    const ledger=new ScheduledEntryLedgerRepository({...options,path,create});
    await ledger.initialize();return ledger;
}

export default class ScheduledEntryRuntime {
    constructor({scheduler,automation,ownership,reconciliation,scheduledOwnership,mutations,clock,ready,logger=()=>{}}){
        Object.assign(this,{scheduler,automation,ownership,reconciliation,scheduledOwnership,mutations,clock,logger});
        this.jobs=new Set();this.tickets=new Map();this.decisions=new Map();this.history=[];this.pending=false;this.closed=false;
        this.ready=ready.then(ledger=>{this.ledger=ledger;return ledger;});
        scheduler.store.validateEntryEdit=async(previous,next)=>{
            if(this.clock()<Date.parse(next.startAt)||this.clock()>=Date.parse(next.endAt))return;
            const ledger=await this.ready;
            const knowledge=await ledger.inspect(identityForScheduledEvent(previous));
            if(knowledge.status!=='UNCONSUMED')throw Object.assign(Error('ACTIVE_REARM_NOT_ALLOWED'),{code:'ACTIVE_REARM_NOT_ALLOWED'});
        };
    }
    record(event,decision,fields={}){
        if(decision==='HEALTH_BLOCKED'){
            const health=this.automation.health;
            const scheduled=this.scheduler.store.getEvent(event?.id??event?.eventId);
            const descriptor=scheduled&&this.automation.resolveSource(scheduled)?.descriptor;
            const healthStatus=!health?'NO_EVIDENCE':health.sourceFingerprint!==descriptor?.fingerprint?'FINGERPRINT_MISMATCH':
                evaluateLiveAutomation({event:scheduled,health,now:this.clock()}).healthStatus;
            // Only bounded enum-like values; never include endpoints or query strings.
            const safe=value=>typeof value==='string'&&/^[A-Z0-9_]{1,80}$/.test(value)?value:null;
            fields={...fields,healthStatus:safe(healthStatus),healthState:safe(health?.state),healthReason:safe(health?.reason)};
        }
        const eventId=event?.id??event?.eventId??null;
        const key=eventId??'startup';
        const signature=JSON.stringify([decision,fields]);
        if(this.decisions.get(key)===signature)return;
        this.decisions.delete(key);this.decisions.set(key,signature);
        if(this.decisions.size>500)this.decisions.delete(this.decisions.keys().next().value);
        const entry=Object.freeze({at:this.clock(),eventId,decision,...fields});
        this.history.push(entry);if(this.history.length>200)this.history.shift();
        try{this.logger(entry);}catch{/* diagnostics never change execution */}
    }
    diagnostics(){return [...this.history];}
    observe(){
        const schedule=this.scheduler.store.getSnapshot();
        if(!schedule)return;
        for(const [id,ticket] of this.tickets){
            const event=schedule.events.find(e=>e.id===id);
            const active=this.scheduledOwnership.transaction();
            const stale=!event || event.type!=='source.live' || identityForScheduledEvent(event).entryKey!==ticket.entryKey ||
                ticket.manualIntentRevision!==this.reconciliation.manualIntentRevision;
            if(stale && active?.eventId===id && active.capturedAt===ticket.capturedAt){
                this.scheduledOwnership.release(id);
                this.record(event??ticket,'ENTRY_REVOKED',{entryKey:ticket.entryKey});
            }
            if(stale || !active || active.eventId!==id)this.tickets.delete(id);
        }
        const now=this.clock();
        const winner=resolveSchedule(schedule,now).activeEvents.find(e=>e.type==='source.live');
        for(const event of schedule.events){
            if(event.type!=='source.live' || now<Date.parse(event.startAt))continue;
            const decision=!event.enabled?'DISABLED':now>=Date.parse(event.endAt)?'EXPIRED':
                event.entryMigration?.disposition==='EXCLUDED'?'EXCLUDED':winner?.id!==event.id?'SUPERSEDED':null;
            if(decision)this.record(event,decision,{entryKey:identityForScheduledEvent(event).entryKey});
        }
    }
    gate(ticket,{capture=false}={}){
        if(this.closed)return 'CLOSED';
        if(!this.ledger || this.ledger.status!=='READY')return 'LEDGER_UNAVAILABLE';
        if(!this.scheduler.available())return 'MIGRATION_INCOMPLETE';
        const schedule=this.scheduler.store.getSnapshot();
        const event=schedule?.events.find(e=>e.id===ticket.eventId);
        if(!event)return 'DELETED';
        if(!event.enabled)return 'DISABLED';
        if(event.entryMigration?.disposition==='EXCLUDED')return 'EXCLUDED';
        try{if(identityForScheduledEvent(event).entryKey!==ticket.entryKey)return 'STALE_VERSION';}catch{return 'STALE_VERSION';}
        const now=this.clock();
        if(now<Date.parse(event.startAt))return 'NOT_STARTED';
        if(now>=Date.parse(event.endAt))return 'EXPIRED';
        if(resolveSchedule(schedule,now).activeEvents.find(e=>e.type==='source.live')?.id!==event.id)return 'SUPERSEDED';
        const descriptor=this.automation.resolveSource(event)?.descriptor;
        if(!descriptor || descriptor.fingerprint!==ticket.sourceFingerprint)return 'SOURCE_CHANGED';
        const health=this.automation.health;
        if(health?.sourceFingerprint!==descriptor.fingerprint || evaluateLiveAutomation({event,health,now}).healthStatus!=='TRANSPORT_READY')return 'HEALTH_BLOCKED';
        if(!this.ownership.available || this.ownership.closed || this.ownership.restartBlocked ||
            this.ownership.authorityEpoch!==ticket.authorityEpoch || this.ownership.authorityProcessSession!==ticket.authorityProcessSession)return 'AUTHORITY_BLOCKED';
        if(this.reconciliation.manualPending || this.reconciliation.manualIntentRevision!==ticket.manualIntentRevision)return 'MANUAL_BLOCKED';
        const active=this.scheduledOwnership.transaction();
        if(capture && active)return 'OWNER_BUSY';
        if(!capture && (!active || active.eventId!==ticket.eventId || active.sourceId!==ticket.sourceId ||
            active.capturedAt!==ticket.capturedAt || active.manualIntentRevision!==ticket.manualIntentRevision))return 'OWNER_CHANGED';
        return null;
    }
    valid(ticket){
        const blocked=this.gate(ticket);
        if(blocked)this.record(ticket,blocked,{entryKey:ticket.entryKey,consumptionId:ticket.consumptionId});
        return !blocked;
    }
    checkCommit({eventId,expectedState}){
        if(expectedState!=='LIVE')return true; // Preserve the existing D10 contract.
        const ticket=this.tickets.get(eventId);
        return Boolean(ticket && this.valid(ticket));
    }
    request(snapshot,execute){
        if(this.closed || this.pending || !snapshot?.eventId)return;
        const event=this.scheduler.store.getEvent(snapshot.eventId);
        if(!event || this.clock()<Date.parse(event.startAt))return;
        let identity;
        try{identity=identityForScheduledEvent(event);}catch{this.record(event,'IDENTITY_UNAVAILABLE');return;}
        const descriptor=this.automation.resolveSource(event)?.descriptor;
        const ticket={...identity,eventId:event.id,sourceId:event.payload.sourceId,
            sourceFingerprint:descriptor?.fingerprint,authorityEpoch:this.ownership.authorityEpoch,
            authorityProcessSession:this.ownership.authorityProcessSession,manualIntentRevision:this.reconciliation.manualIntentRevision};
        this.pending=true;
        const job=(async()=>{
            await this.ready;
            await this.mutations.run(async()=>{
                let blocked=this.gate(ticket,{capture:true});
                if(blocked){this.record(event,blocked,{entryKey:ticket.entryKey});return;}
                const known=await this.ledger.inspect(identity);
                if(known.status!=='UNCONSUMED'){this.record(event,known.status,{entryKey:ticket.entryKey});return;}
                this.record(event,'CANDIDATE',{entryKey:ticket.entryKey});
                const consumed=await this.ledger.consume(identity,{consumedAt:new Date(this.clock()).toISOString(),
                    authorityEpoch:ticket.authorityEpoch,authorityProcessSession:ticket.authorityProcessSession},
                    {check:()=>!this.gate(ticket,{capture:true})});
                this.record(event,consumed.status,{entryKey:ticket.entryKey,...(consumed.record?{consumptionId:consumed.record.consumptionId}:{})});
                if(consumed.status!=='CONSUMED')return;
                ticket.consumptionId=consumed.record.consumptionId;
                blocked=this.gate(ticket,{capture:true});
                if(blocked){this.record(event,blocked,{entryKey:ticket.entryKey,consumptionId:ticket.consumptionId});return;}
                const captured=this.scheduledOwnership.capture({eventId:ticket.eventId,sourceId:ticket.sourceId});
                this.record(event,'CAPTURE',{entryKey:ticket.entryKey,accepted:captured.accepted===true,reason:captured.reason});
                if(captured.accepted!==true)return;
                ticket.capturedAt=this.scheduledOwnership.transaction().capturedAt;
                this.tickets.set(event.id,ticket);
            });
            if(this.tickets.get(event.id)===ticket)await execute(ticket);
        })().catch(error=>this.record(event,'ENTRY_ERROR',{entryKey:ticket.entryKey,reason:error.code||error.message}))
            .finally(()=>{this.pending=false;this.jobs.delete(job);});
        this.jobs.add(job);
    }
    async idle(){while(this.jobs.size)await Promise.all([...this.jobs]);}
    close(){this.closed=true;}
}
