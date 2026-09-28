import {
    scheduledLiveCommitCheck
} from './ScheduledLiveExecutionFence.js';

const rejected=reason=>Object.freeze({
    accepted:false,
    reason
});

export default class ScheduledLiveExecutionCoordinator {
    constructor({
        ownership,
        reconciliation,
        scheduledOwnership,
        mutations,
        commits
    }={}){
        if(
            !ownership ||
            !reconciliation ||
            !scheduledOwnership ||
            typeof scheduledOwnership.transaction!=='function' ||
            !mutations ||
            typeof mutations.run!=='function' ||
            !commits ||
            typeof commits.accept!=='function'
        ){
            throw new TypeError(
                'INVALID_SCHEDULED_LIVE_EXECUTION_COORDINATOR'
            );
        }

        Object.assign(this,{
            ownership,
            reconciliation,
            scheduledOwnership,
            mutations,
            commits
        });

        this.closed=false;
    }

    commit({
        eventId,
        sourceId,
        expectedState,
        fence,
        manualIntentRevision,
        payload
    }={}){
        if(this.closed)
            return Promise.resolve(
                rejected('execution-owner-required')
            );

        /*
         * Initial fence:
         *
         * Do not even enter the shared mutation/PROGRAM commit path
         * unless the Scheduled sequence still owns the exact
         * event/source transaction captured earlier.
         */
        if(!this.#check({
            eventId,
            sourceId,
            expectedState,
            fence,
            manualIntentRevision
        })){
            return Promise.resolve(
                rejected('execution-owner-required')
            );
        }

        /*
         * Scheduled PROGRAM mutation uses the same serializer as
         * manual/browser PROGRAM and all other authoritative asset
         * mutations.
         */
        return this.mutations.run(()=>
            this.commits.accept(
                payload,
                {
                    /*
                     * ProgramCommitCoordinator invokes this check
                     * both before async bind/staging and immediately
                     * before durable commit + memory install.
                     *
                     * Therefore a manual intent, restart, authority
                     * loss or transaction identity change occurring
                     * during an await invalidates the Scheduled commit.
                     */
                    check:()=>this.#check({
                        eventId,
                        sourceId,
                        expectedState,
                        fence,
                        manualIntentRevision
                    })
                }
            )
        );
    }

    #check({
        eventId,
        sourceId,
        expectedState,
        fence,
        manualIntentRevision
    }){
        if(this.closed)
            return false;

        const transaction=
            this.scheduledOwnership.transaction();

        // Event/source ownership alone cannot authorize an earlier action
        // after an await: TAKE belongs to LIVE, BLACK to POSTROLL.
        if(
            !['LIVE','POSTROLL'].includes(expectedState) ||
            transaction?.state!==expectedState
        ){
            return false;
        }

        return scheduledLiveCommitCheck({
            fence,
            transaction,
            eventId,
            sourceId,

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
    }

    close(){
        this.closed=true;
    }
}
