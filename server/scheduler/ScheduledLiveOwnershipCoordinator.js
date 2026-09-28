import {
    createScheduledLiveTransaction,
    transitionScheduledLiveTransaction
} from './ScheduledLiveExecutionTransaction.js';

import {
    evaluateScheduledLiveExecutionFence
} from './ScheduledLiveExecutionFence.js';

const freeze=value=>Object.freeze(value);

export default class ScheduledLiveOwnershipCoordinator {
    constructor({
        ownership,
        reconciliation,
        program,
        clock=()=>Date.now()
    }={}){
        if(
            !ownership ||
            !reconciliation ||
            typeof program!=='function' ||
            typeof clock!=='function'
        ){
            throw new TypeError(
                'INVALID_SCHEDULED_LIVE_OWNERSHIP_COORDINATOR'
            );
        }

        Object.assign(this,{
            ownership,
            reconciliation,
            program,
            clock
        });

        this.active=null;
    }

    transaction(){
        return this.active?.transaction
            ? structuredClone(this.active.transaction)
            : null;
    }
    transition(operation,{currentProgram=null}={}){
        if(!this.active)
            return null;

        const transaction=
            transitionScheduledLiveTransaction(
                this.active.transaction,
                operation,
                {
                    manualIntentRevision:
                        this.reconciliation.manualIntentRevision,

                    currentProgram
                }
            );

        /*
         * The transaction transition may itself encode manual
         * dominance as ABORTED. Never retain Scheduled ownership
         * after that terminal decision.
         */
        if(transaction.state==='ABORTED'){
            this.ownership.releaseScheduled(
                transaction.eventId
            );

            this.active=null;

            return structuredClone(transaction);
        }

        const fence=
            evaluateScheduledLiveExecutionFence({
                transaction,

                manualIntentRevision:
                    transaction.manualIntentRevision,

                currentManualIntentRevision:
                    this.reconciliation.manualIntentRevision,

                authorityAvailable:
                    this.ownership.available===true,

                authorityClosed:
                    this.ownership.closed===true,

                restartBlocked:
                    this.ownership.restartBlocked===true,

                manualPending:
                    Boolean(this.reconciliation.manualPending)
            });

        /*
         * A phase transition never manufactures execution
         * authority. It only advances the transaction owned by
         * this coordinator and refreshes its decision fence.
         */
        this.active={
            transaction,
            fence
        };

        return structuredClone(transaction);
    }
    snapshot(){
        return this.active
            ? freeze({
                active:true,
                eventId:this.active.transaction.eventId,
                sourceId:this.active.transaction.sourceId,
                fence:this.active.fence,
                executionAllowed:false,
                serverTake:false
            })
            : freeze({
                active:false,
                eventId:null,
                sourceId:null,
                fence:null,
                executionAllowed:false,
                serverTake:false
            });
    }

    capture({eventId,sourceId}={}){
        if(this.active){
            if(
                this.active.transaction.eventId===eventId &&
                this.active.transaction.sourceId===sourceId
            ){
                return this.snapshot();
            }

            return freeze({
                ...this.snapshot(),
                accepted:false,
                reason:'SCHEDULED_SEQUENCE_ALREADY_ACTIVE'
            });
        }

        const manualIntentRevision=
            this.reconciliation.manualIntentRevision;

        const transaction=createScheduledLiveTransaction({
            eventId,
            sourceId,
            program:this.program(),
            manualIntentRevision,
            capturedAt:this.clock()
        });

        const fence=evaluateScheduledLiveExecutionFence({
            transaction,
            manualIntentRevision,
            currentManualIntentRevision:
                this.reconciliation.manualIntentRevision,
            authorityAvailable:
                this.ownership.available===true,
            authorityClosed:
                this.ownership.closed===true,
            restartBlocked:
                this.ownership.restartBlocked===true,
            manualPending:
                Boolean(this.reconciliation.manualPending)
        });

        if(
            !fence.allowed ||
            !fence.scheduledOwnsSequence ||
            !fence.suppressBrowser
        ){
            return freeze({
                active:false,
                accepted:false,
                reason:fence.reason,
                fence,
                executionAllowed:false,
                serverTake:false
            });
        }

        if(!this.ownership.suppressForScheduled(eventId)){
            return freeze({
                active:false,
                accepted:false,
                reason:'SCHEDULED_SUPPRESSION_REJECTED',
                fence,
                executionAllowed:false,
                serverTake:false
            });
        }

        this.active={transaction,fence};

        return freeze({
            ...this.snapshot(),
            accepted:true,
            reason:'SCHEDULED_SEQUENCE_OWNS'
        });
    }

    release(eventId){
        if(
            !this.active ||
            this.active.transaction.eventId!==eventId
        ){
            return false;
        }

        this.ownership.releaseScheduled(eventId);
        this.active=null;
        return true;
    }

    close(){
        if(this.active){
            this.ownership.releaseScheduled(
                this.active.transaction.eventId
            );
            this.active=null;
        }
    }
}
