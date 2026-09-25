import {
    normalizeScheduledLiveTransaction
} from './ScheduledLiveExecutionTransaction.js';

const freeze=value=>Object.freeze(value);

const fail=code=>{
    throw Object.assign(new Error(code),{code});
};

export default class ScheduledLivePersistenceCoordinator {
    constructor({repository}={}){
        if(!repository)
            throw new TypeError(
                'INVALID_SCHEDULED_LIVE_PERSISTENCE_COORDINATOR'
            );

        this.repository=repository;
        this.closed=false;
        this.last=null;
    }

    snapshot(){
        return freeze({
            available:
                !this.closed &&
                this.repository.status==='READY',

            repositoryStatus:
                this.repository.status??'UNAVAILABLE',

            eventId:this.last?.eventId??null,
            sourceId:this.last?.sourceId??null,
            state:this.last?.state??null,

            executionAllowed:false,
            serverTake:false
        });
    }

    async persist(transaction){
        if(this.closed)
            fail('SCHEDULED_LIVE_PERSISTENCE_CLOSED');

        if(this.repository.status!=='READY')
            fail('SCHEDULED_LIVE_PERSISTENCE_UNAVAILABLE');

        const canonical=
            normalizeScheduledLiveTransaction(transaction);

        /*
         * Persistence never grants execution authority.
         */
        if(
            canonical.executionAllowed!==false ||
            canonical.serverTake!==false
        ){
            fail('SCHEDULED_LIVE_EXECUTION_AUTHORITY_FORBIDDEN');
        }

        const persisted=
            await this.repository.write(canonical);

        this.last=persisted;

        return freeze({
            persisted:true,
            eventId:persisted.eventId,
            sourceId:persisted.sourceId,
            state:persisted.state,
            executionAllowed:false,
            serverTake:false
        });
    }

    hydrate(){
        if(
            this.closed ||
            this.repository.status!=='READY'
        ){
            return null;
        }

        const record=this.repository.record;

        if(!record){
            this.last=null;
            return null;
        }

        const canonical=
            normalizeScheduledLiveTransaction(record);

        this.last=canonical;

        return canonical;
    }

    close(){
        this.closed=true;
        this.last=null;
    }
}
