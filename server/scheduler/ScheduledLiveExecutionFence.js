const fail=code=>{
    throw Object.assign(new Error(code),{code});
};

const freeze=value=>Object.freeze(value);

function revision(value){
    return Number.isSafeInteger(value) && value>=0;
}

function validTransaction(tx){
    return Boolean(
        tx &&
        tx.version===1 &&
        typeof tx.eventId==='string' &&
        typeof tx.sourceId==='string' &&
        [
            'CAPTURED',
            'PREROLL',
            'LIVE',
            'POSTROLL',
            'RETURN_PENDING'
        ].includes(tx.state) &&
        tx.executionAllowed===false &&
        tx.serverTake===false
    );
}

function result({
    allowed,
    reason,
    scheduledOwnsSequence=false,
    suppressBrowser=false
}){
    return freeze({
        version:1,
        allowed,
        reason,
        scheduledOwnsSequence,
        suppressBrowser,

        /*
         * STEP 8C-2A is a decision fence only.
         * It grants no authority to mutate PROGRAM.
         */
        executionAllowed:false,
        serverTake:false
    });
}

export function evaluateScheduledLiveExecutionFence({
    transaction,
    manualIntentRevision,
    currentManualIntentRevision,
    authorityAvailable,
    authorityClosed=false,
    restartBlocked,
    manualPending=false
}={}){
    if(
        !validTransaction(transaction) ||
        !revision(manualIntentRevision) ||
        !revision(currentManualIntentRevision) ||
        typeof authorityAvailable!=='boolean' ||
        typeof authorityClosed!=='boolean' ||
        typeof restartBlocked!=='boolean' ||
        typeof manualPending!=='boolean'
    ){
        fail('INVALID_SCHEDULED_LIVE_EXECUTION_FENCE');
    }

    /*
     * A server restart or unavailable execution authority
     * always fails closed.
     */
    if(
        !authorityAvailable ||
        authorityClosed ||
        restartBlocked
    ){
        return result({
            allowed:false,
            reason:'RECONCILIATION_REQUIRED'
        });
    }

    /*
     * Manual intent has absolute precedence.
     * Both an active manual operation and any revision change
     * invalidate the scheduled request.
     */
    if(
        manualPending ||
        manualIntentRevision!==currentManualIntentRevision
    ){
        return result({
            allowed:false,
            reason:'MANUAL_INTENT_DOMINATES'
        });
    }

    return result({
        allowed:true,
        reason:'SCHEDULED_SEQUENCE_OWNS',
        scheduledOwnsSequence:true,
        suppressBrowser:true
    });
}

export function scheduledLiveCommitCheck({
    fence,
    transaction,
    eventId,
    sourceId,
    manualIntentRevision,
    currentManualIntentRevision,
    authorityAvailable,
    authorityClosed=false,
    restartBlocked,
    manualPending=false
}={}){
    if(
        !fence ||
        fence.version!==1 ||
        fence.allowed!==true ||
        fence.scheduledOwnsSequence!==true ||
        fence.suppressBrowser!==true ||
        fence.executionAllowed!==false ||
        fence.serverTake!==false
    ){
        return false;
    }

    if(
        !transaction ||
        transaction.eventId!==eventId ||
        transaction.sourceId!==sourceId
    ){
        return false;
    }

    const current=
        evaluateScheduledLiveExecutionFence({
            transaction,
            manualIntentRevision,
            currentManualIntentRevision,
            authorityAvailable,
            authorityClosed,
            restartBlocked,
            manualPending
        });

    return (
        current.allowed===true &&
        current.reason==='SCHEDULED_SEQUENCE_OWNS'
    );
}
