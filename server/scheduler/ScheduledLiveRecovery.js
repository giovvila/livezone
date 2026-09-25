import {
    normalizeScheduledLiveTransaction,
    sameCapturedProgram
} from './ScheduledLiveExecutionTransaction.js';

const PRE_ROLL_MS=10000;
const POST_ROLL_MS=3000;

const freeze=value=>{
    if(value && typeof value==='object'){
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};

const fail=code=>{
    throw Object.assign(new Error(code),{code});
};

function validRevision(value){
    return Number.isSafeInteger(value) && value>=0;
}

function validNow(value){
    return Number.isSafeInteger(value) && value>=0;
}

function validEvent(event){
    return Boolean(
        event &&
        event.type==='source.live' &&
        event.enabled===true &&
        typeof event.id==='string' &&
        typeof event.startAt==='string' &&
        typeof event.endAt==='string' &&
        Number.isFinite(Date.parse(event.startAt)) &&
        Number.isFinite(Date.parse(event.endAt)) &&
        Date.parse(event.endAt)>Date.parse(event.startAt) &&
        event.payload &&
        typeof event.payload.sourceId==='string'
    );
}

function result({
    disposition,
    phase=null,
    transactionState=null,
    eventId=null,
    sourceId=null,
    capturedProgramMatchesCurrent=false
}){
    return freeze({
        version:1,
        disposition,
        phase,
        transactionState,
        eventId,
        sourceId,
        capturedProgramMatchesCurrent,

        /*
         * STEP 8B recovery is diagnostic only.
         * Hydration/reconciliation can never execute PROGRAM.
         */
        executionAllowed:false,
        serverTake:false
    });
}

export function reconcileScheduledLiveRecovery({
    transaction=null,
    event=null,
    currentProgram=null,
    manualIntentRevision,
    now
}={}){
    if(!validRevision(manualIntentRevision))
        fail('INVALID_MANUAL_INTENT_REVISION');

    if(!validNow(now))
        fail('CLOCK_INVALID');

    if(transaction===null){
        return result({
            disposition:'NO_TRANSACTION'
        });
    }

    const tx=
        normalizeScheduledLiveTransaction(transaction);

    if(
        tx.state==='COMPLETED' ||
        tx.state==='ABORTED' ||
        tx.state==='RECOVERY_BLOCKED'
    ){
        return result({
            disposition:'SEQUENCE_TERMINAL',
            transactionState:tx.state,
            eventId:tx.eventId,
            sourceId:tx.sourceId
        });
    }

    /*
     * Manual operator always dominates recovery.
     */
    if(manualIntentRevision!==tx.manualIntentRevision){
        return result({
            disposition:'MANUAL_INTENT_DOMINATES',
            transactionState:tx.state,
            eventId:tx.eventId,
            sourceId:tx.sourceId
        });
    }

    if(!event){
        return result({
            disposition:'EVENT_MISSING',
            transactionState:tx.state,
            eventId:tx.eventId,
            sourceId:tx.sourceId
        });
    }

    if(!validEvent(event)){
        return result({
            disposition:'EVENT_CHANGED',
            transactionState:tx.state,
            eventId:tx.eventId,
            sourceId:tx.sourceId
        });
    }

    if(
        event.id!==tx.eventId ||
        event.payload.sourceId!==tx.sourceId
    ){
        return result({
            disposition:'EVENT_CHANGED',
            transactionState:tx.state,
            eventId:tx.eventId,
            sourceId:tx.sourceId
        });
    }

    const start=Date.parse(event.startAt);
    const end=Date.parse(event.endAt);
    const preRollAt=start-PRE_ROLL_MS;
    const postRollEndAt=end+POST_ROLL_MS;

    /*
     * capturedAt must belong to the expected T-10 boundary.
     * This also protects against editing startAt after capture.
     */
    if(tx.capturedAt!==preRollAt){
        return result({
            disposition:'EVENT_CHANGED',
            transactionState:tx.state,
            eventId:tx.eventId,
            sourceId:tx.sourceId
        });
    }

    let capturedProgramMatchesCurrent=false;

    if(currentProgram!==null){
        try{
            capturedProgramMatchesCurrent=
                sameCapturedProgram(
                    tx,
                    currentProgram
                );
        }
        catch{
            return result({
                disposition:'PROGRAM_INVALID',
                transactionState:tx.state,
                eventId:tx.eventId,
                sourceId:tx.sourceId
            });
        }
    }

    if(now<preRollAt){
        return result({
            disposition:'TOO_EARLY',
            phase:'BEFORE_PREROLL',
            transactionState:tx.state,
            eventId:tx.eventId,
            sourceId:tx.sourceId,
            capturedProgramMatchesCurrent
        });
    }

    if(now<start){
        return result({
            disposition:'RECONCILIATION_REQUIRED',
            phase:'PREROLL_WINDOW',
            transactionState:tx.state,
            eventId:tx.eventId,
            sourceId:tx.sourceId,
            capturedProgramMatchesCurrent
        });
    }

    if(now<end){
        return result({
            disposition:'RECONCILIATION_REQUIRED',
            phase:'LIVE_WINDOW',
            transactionState:tx.state,
            eventId:tx.eventId,
            sourceId:tx.sourceId,
            capturedProgramMatchesCurrent
        });
    }

    if(now<postRollEndAt){
        return result({
            disposition:'RECONCILIATION_REQUIRED',
            phase:'POSTROLL_WINDOW',
            transactionState:tx.state,
            eventId:tx.eventId,
            sourceId:tx.sourceId,
            capturedProgramMatchesCurrent
        });
    }

    if(now===postRollEndAt){
        return result({
            disposition:'RECONCILIATION_REQUIRED',
            phase:'RETURN_WINDOW',
            transactionState:tx.state,
            eventId:tx.eventId,
            sourceId:tx.sourceId,
            capturedProgramMatchesCurrent
        });
    }

    return result({
        disposition:'SEQUENCE_EXPIRED',
        phase:'AFTER_SEQUENCE',
        transactionState:tx.state,
        eventId:tx.eventId,
        sourceId:tx.sourceId,
        capturedProgramMatchesCurrent
    });
}
