import {createHash} from 'node:crypto';

import {validateProgramOutputEnvelope}
    from '../../public/js/program-output/ProgramOutputEnvelope.js';

const STATES=Object.freeze([
    'NONE',
    'CAPTURED',
    'PREROLL',
    'LIVE',
    'POSTROLL',
    'RETURN_PENDING',
    'COMPLETED',
    'ABORTED',
    'RECOVERY_BLOCKED'
]);

const terminal=state =>
    ['COMPLETED','ABORTED','RECOVERY_BLOCKED'].includes(state);

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

const validId=value =>
    typeof value==='string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value);

const validRevision=value =>
    Number.isSafeInteger(value) && value>=0;

function canonicalEnvelope(value){
    const envelope=validateProgramOutputEnvelope(value);

    if(!envelope)
        fail('INVALID_PROGRAM_ENVELOPE');

    return envelope;
}

function sameEnvelope(a,b){
    return JSON.stringify(a)===JSON.stringify(b);
}

export function createScheduledLiveTransaction({
    eventId,
    sourceId,
    program,
    manualIntentRevision,
    capturedAt
}={}){
    if(
        !validId(eventId) ||
        !validId(sourceId) ||
        !validRevision(manualIntentRevision) ||
        !validRevision(capturedAt)
    ){
        fail('INVALID_SCHEDULED_LIVE_TRANSACTION');
    }

    const capturedProgram=
        structuredClone(canonicalEnvelope(program));

    return freeze({
        version:1,
        eventId,
        sourceId,
        state:'CAPTURED',
        capturedAt,
        manualIntentRevision,
        capturedProgram,
        reason:null,

        executionAllowed:false,
        serverTake:false
    });
}

export function transitionScheduledLiveTransaction(
    transaction,
    operation,
    {
        manualIntentRevision,
        currentProgram=null
    }={}
){
    if(
        !transaction ||
        transaction.version!==1 ||
        !STATES.includes(transaction.state) ||
        transaction.state==='NONE'
    ){
        fail('INVALID_SCHEDULED_LIVE_TRANSACTION');
    }

    if(terminal(transaction.state))
        fail('TRANSACTION_TERMINAL');

    if(!validRevision(manualIntentRevision))
        fail('INVALID_MANUAL_INTENT_REVISION');

    /*
     * Manual always dominates scheduled automation.
     */
    if(manualIntentRevision!==transaction.manualIntentRevision){
        return freeze({
            ...transaction,
            state:'ABORTED',
            reason:'MANUAL_INTENT_DOMINATES',
            executionAllowed:false,
            serverTake:false
        });
    }

    let state;

    switch(operation){

        case 'begin-preroll':
            if(transaction.state!=='CAPTURED')
                fail('INVALID_TRANSACTION_TRANSITION');

            state='PREROLL';
            break;

        case 'begin-live':
            if(transaction.state!=='PREROLL')
                fail('INVALID_TRANSACTION_TRANSITION');

            state='LIVE';
            break;

        case 'begin-postroll':
            if(transaction.state!=='LIVE')
                fail('INVALID_TRANSACTION_TRANSITION');

            state='POSTROLL';
            break;

        case 'prepare-return':
            if(transaction.state!=='POSTROLL')
                fail('INVALID_TRANSACTION_TRANSITION');

            /*
             * Validate the current PROGRAM if supplied,
             * but never adopt it as the return target.
             */
            if(currentProgram!==null)
                canonicalEnvelope(currentProgram);

            state='RETURN_PENDING';
            break;

        case 'complete':
            if(transaction.state!=='RETURN_PENDING')
                fail('INVALID_TRANSACTION_TRANSITION');

            state='COMPLETED';
            break;

        default:
            fail('INVALID_TRANSACTION_OPERATION');
    }

    return freeze({
        ...transaction,
        state,
        reason:
            state==='COMPLETED'
                ? 'SEQUENCE_COMPLETED'
                : null,
        executionAllowed:false,
        serverTake:false
    });
}

export function inspectScheduledLiveTransaction(
    transaction,
    {
        manualIntentRevision,
        currentProgram=null
    }={}
){
    if(!transaction){
        return freeze({
            state:'NONE',
            disposition:'NO_TRANSACTION',
            returnProgram:null,
            executionAllowed:false,
            serverTake:false
        });
    }

    if(!validRevision(manualIntentRevision))
        fail('INVALID_MANUAL_INTENT_REVISION');

    if(manualIntentRevision!==transaction.manualIntentRevision){
        return freeze({
            state:transaction.state,
            disposition:'MANUAL_INTENT_DOMINATES',
            returnProgram:null,
            executionAllowed:false,
            serverTake:false
        });
    }

    if(currentProgram!==null)
        canonicalEnvelope(currentProgram);

    return freeze({
        state:transaction.state,
        disposition:
            terminal(transaction.state)
                ? transaction.state
                : 'SEQUENCE_OWNED',

        returnProgram:
            ['POSTROLL','RETURN_PENDING'].includes(transaction.state)
                ? structuredClone(transaction.capturedProgram)
                : null,

        executionAllowed:false,
        serverTake:false
    });
}

export function sameCapturedProgram(transaction,envelope){
    return sameEnvelope(
        transaction.capturedProgram,
        canonicalEnvelope(envelope)
    );
}

function canonical(value){
    if(value===null || typeof value!=='object')
        return JSON.stringify(value);

    if(Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';

    return '{' +
        Object.keys(value)
            .sort()
            .map(key =>
                JSON.stringify(key) + ':' + canonical(value[key])
            )
            .join(',') +
        '}';
}

function digest(value){
    return createHash('sha256')
        .update(canonical(value))
        .digest('hex');
}

export function normalizeScheduledLiveTransaction(value){
    if(
        !value ||
        value.version!==1 ||
        !validId(value.eventId) ||
        !validId(value.sourceId) ||
        !STATES.includes(value.state) ||
        value.state==='NONE' ||
        !validRevision(value.capturedAt) ||
        !validRevision(value.manualIntentRevision) ||
        typeof value.executionAllowed!=='boolean' ||
        typeof value.serverTake!=='boolean'
    ){
        fail('INVALID_SCHEDULED_LIVE_TRANSACTION');
    }

    /*
     * Persisted STEP 8 transactions remain non-executing.
     */
    if(
        value.executionAllowed!==false ||
        value.serverTake!==false
    ){
        fail('EXECUTION_AUTHORITY_FORBIDDEN');
    }

    const capturedProgram=
        structuredClone(
            canonicalEnvelope(value.capturedProgram)
        );

    const expectedReason =
        value.state==='COMPLETED'
            ? 'SEQUENCE_COMPLETED'
            : value.state==='ABORTED'
                ? 'MANUAL_INTENT_DOMINATES'
                : value.state==='RECOVERY_BLOCKED'
                    ? 'RECOVERY_RECONCILIATION_REQUIRED'
                    : null;

    if(value.reason!==expectedReason)
        fail('INVALID_TRANSACTION_REASON');

    return freeze({
        version:1,
        eventId:value.eventId,
        sourceId:value.sourceId,
        state:value.state,
        capturedAt:value.capturedAt,
        manualIntentRevision:value.manualIntentRevision,
        capturedProgram,
        reason:expectedReason,
        executionAllowed:false,
        serverTake:false
    });
}

export function scheduledLiveTransactionEnvelope(transaction){
    const record=
        normalizeScheduledLiveTransaction(transaction);

    const payload={
        schemaVersion:1,
        mode:'NON_EXECUTING_SCHEDULED_LIVE',
        record
    };

    return freeze({
        ...payload,
        checksum:digest(payload)
    });
}

export function validateScheduledLiveTransactionEnvelope(value){
    if(
        !value ||
        value.schemaVersion!==1 ||
        value.mode!=='NON_EXECUTING_SCHEDULED_LIVE' ||
        typeof value.checksum!=='string' ||
        !/^[a-f0-9]{64}$/.test(value.checksum)
    ){
        fail('SCHEDULED_LIVE_TRANSACTION_CORRUPT');
    }

    const normalized=
        scheduledLiveTransactionEnvelope(value.record);

    if(canonical(normalized)!==canonical(value))
        fail('SCHEDULED_LIVE_TRANSACTION_CORRUPT');

    return normalized;
}

export function scheduledLiveTransactionChecksum(transaction){
    return scheduledLiveTransactionEnvelope(transaction).checksum;
}

export {
    STATES as SCHEDULED_LIVE_TRANSACTION_STATES
};
