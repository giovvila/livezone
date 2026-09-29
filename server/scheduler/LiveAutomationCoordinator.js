import {resolveHealthSource} from '../autolive/AutoLiveHealthContract.js';
import {evaluateLiveAutomation} from './LiveAutomationShadow.js';

const freeze = value => {
    if(value && typeof value === 'object'){
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};

export default class LiveAutomationCoordinator {
    constructor({
        scheduler,
        healthRegistry,
        catalog,
        catalogReady = Promise.resolve(),
        resolveConfigRef = () => null,
        managedConfig = null,
        clock = () => Date.now()
    } = {}) {
        if(!scheduler || !healthRegistry || typeof catalog !== 'function')
            throw new TypeError('LIVE_AUTOMATION_DEPENDENCY_REQUIRED');

        Object.assign(this,{
            scheduler,
            healthRegistry,
            catalog,
            catalogReady,
            resolveConfigRef,
            managedConfig,
            clock
        });

        this.listeners = new Set();
        this.evaluations = new Set();
        this.currentEvent = null;
        this.healthLease = null;
        this.health = null;
        this.runtime = this.emptyRuntime('NO_LIVE_EVENT');
    }

    emptyRuntime(reason){
        return freeze({
            version:1,
            eventId:null,
            sourceId:null,
            state:'IDLE',
            reason,
            healthStatus:'NO_EVIDENCE',
            intent:null,
            automaticTakeAuthority:false,
            executionAllowed:false,
            serverTake:false
        });
    }

    async start(){
        if(this.started || this.closed) return;
        this.started = true;

        await Promise.resolve(this.catalogReady).catch(()=>{});

        if(this.closed) return;

        this.offEvaluation =
            this.scheduler.runtime.subscribeEvaluation(
                state => this.reconcile(state)
            );

        this.reconcile(this.scheduler.runtime.getSnapshot());
    }

    winner(state){
        return state?.activeEvents?.find(
            event => event.type === 'source.live'
        ) ?? null;
    }

    upcoming(){
        const schedule = this.scheduler.store.getSnapshot();
        if(!schedule) return null;

        const now = this.clock();

        return schedule.events
            .filter(event =>
                event.type === 'source.live' &&
                event.enabled === true &&
                now < Date.parse(event.startAt) &&
                now >= Date.parse(event.startAt) -
                    event.payload.precheckSeconds * 1000
            )
            .sort((a,b) =>
                b.priority-a.priority ||
                Date.parse(b.startAt)-Date.parse(a.startAt) ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
            )[0] ?? null;
    }

    retainedSequence(){
        const event=this.currentEvent;

        if(!event || event.type!=='source.live' || event.enabled!==true)
            return null;

        const now=this.clock();
        const end=Date.parse(event.endAt);

        return now<=end+3000
            ? event
            : null;
    }

    candidate(state){
        return this.winner(state) ??
            this.upcoming() ??
            this.retainedSequence();
    }

    resolveSource(event){
        if(!event) return null;

        const source = this.catalog()?.sources?.find(
            source => source.id === event.payload.sourceId
        );

        if(!source || source.kind !== 'hls' || source.enabled === false)
            return null;

        const descriptor = resolveHealthSource(
            source,
            this.resolveConfigRef,
            this.managedConfig
        );

        return descriptor ? {source,descriptor} : null;
    }

    releaseHealth(){
        this.healthLease?.release();
        this.healthLease = null;
        this.health = null;
        this.healthKey = null;
    }

    syncHealth(event){
        const resolved = this.resolveSource(event);

        if(!resolved){
            this.releaseHealth();
            return null;
        }

        const key = resolved.descriptor.fingerprint;

        if(this.healthKey === key)
            return resolved;

        this.releaseHealth();

        this.healthKey = key;

        this.healthLease = this.healthRegistry.acquire(
            resolved.descriptor,
            value => {
                if(
                    this.closed ||
                    this.healthKey !== value.sourceFingerprint
                ) return;

                this.health = value;
                this.evaluate();
            }
        );

        this.health = this.healthLease.getSnapshot();

        return resolved;
    }

    reconcile(state){
        if(this.closed) return;

        const next = this.candidate(state);

        if(!next){
            this.currentEvent = null;
            this.releaseHealth();
            this.publish(this.emptyRuntime('NO_LIVE_EVENT'));
            return;
        }

        this.currentEvent = next;

        if(this.clock() < Date.parse(next.endAt)){
            this.syncHealth(next);
        }
        else{
            this.releaseHealth();
        }

        this.evaluate();
    }

    evaluate(){
        if(this.closed || !this.currentEvent) return;

        const runtime = evaluateLiveAutomation({
            event:this.currentEvent,
            health:this.health,
            now:this.clock()
        });

        this.publish(runtime);
    }

    publish(runtime){
        for(const listener of this.evaluations){try{listener(runtime);}catch{/* observer isolation */}}
        const key = JSON.stringify(runtime);

        if(key === this.runtimeKey) return;

        this.runtimeKey = key;
        this.runtime = runtime;

        for(const listener of this.listeners){
            try { listener(runtime); }
            catch {/* observer isolation */}
        }
    }

    getSnapshot(){
        return this.runtime;
    }

    subscribe(listener){
        this.listeners.add(listener);
        listener(this.runtime);

        return () => this.listeners.delete(listener);
    }

    subscribeEvaluation(listener){
        this.evaluations.add(listener);
        return ()=>this.evaluations.delete(listener);
    }

    close(){
        if(this.closed) return;

        this.closed = true;
        this.offEvaluation?.();
        this.offEvaluation = null;
        this.releaseHealth();
        this.listeners.clear();
        this.evaluations.clear();
    }
}
