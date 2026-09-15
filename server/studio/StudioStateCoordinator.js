import { createInitializedState, validateAuthoritativeState } from "./AuthoritativeStateContract.js";
import {reconcileReferenceCatalog} from './ReconcileReferenceCatalog.js';

export default class StudioStateCoordinator {
    constructor({ repository, clock = () => new Date() } = {}) {
        if (!repository) throw new TypeError("StudioStateCoordinator requires a repository.");
        this.repository = repository;
        this.clock = clock;
        this.queue = Promise.resolve();
        this.listeners = new Set();
    }

    initialize() { return this.repository.initialize(); }
    getSnapshot() { return this.repository.getSnapshot(); }
    getStatus() { return this.repository.getStatus(); }
    subscribe(listener) { if (typeof listener !== "function") return () => {};
        this.listeners.add(listener); return () => this.listeners.delete(listener); }

    initializeState(domains) {
        return this.serialize(async () => {
            const current = this.getSnapshot();
            if (!current) throw stateError("STATE_UNAVAILABLE");
            if (current.initialized) throw stateError("STATE_ALREADY_INITIALIZED");
            const candidate = createInitializedState(domains, { stateId: current.stateId,
                revision: current.revision + 1, updatedAt: this.clock().toISOString() });
            if (!candidate) throw stateError("INVALID_STATE");
            await this.referenceValidator?.(candidate);
            const committed = await this.repository.commit(candidate);
            const event = Object.freeze({ type: "initialized", revision: committed.revision,
                changedDomains: Object.freeze(["sources", "scenes", "scheduler",
                    "globalOverlays", "dominantLive"]) });
            this.listeners.forEach((listener) => {
                try { listener(event); } catch { /* A subscriber cannot undo a committed state. */ }
            });
            return committed;
        });
    }

    serialize(operation) {
        const coordinated = () => this.mutationCoordinator ? this.mutationCoordinator.run(operation) : operation();
        const result = this.queue.then(coordinated, coordinated);
        this.queue = result.catch(() => {});
        return result;
    }

    updateCatalog({ sources, scenes, revision }) {
        const input = structuredClone({ sources, scenes, revision });
        return this.serialize(async () => {
            const current = this.getSnapshot();
            if (!current) throw stateError('STATE_UNAVAILABLE');
            if (input.revision !== current.revision) throw stateError('REVISION_CONFLICT');
            const candidate = validateAuthoritativeState({ ...current, initialized: true,
                sources: input.sources, scenes: input.scenes, revision: current.revision + 1,
                updatedAt: this.clock().toISOString() });
            if (!candidate) throw stateError('INVALID_STATE');
            await this.referenceValidator?.({ sources: candidate.sources, scenes: candidate.scenes });
            const state = await this.repository.commit(candidate);
            this.listeners.forEach(listener => { try { listener({ type: 'catalog', revision: state.revision,
                changedDomains: ['sources', 'scenes'] }); } catch {} });
            return state;
        });
    }
    reconcileCatalog({sources,scenes,revision,version}) {
        const input=structuredClone({sources,scenes,revision,version});
        return this.serialize(async()=>{
            const current=this.getSnapshot();if(!current)throw stateError('STATE_UNAVAILABLE');
            if(input.version!==1)throw stateError('CATALOG_VERSION_UNSUPPORTED');
            if(input.revision!==current.revision)throw stateError('REVISION_CONFLICT');
            const imported=validateAuthoritativeState({...current,initialized:true,sources:input.sources,scenes:input.scenes,
                revision:current.revision+1,updatedAt:this.clock().toISOString(),scheduler:{version:1,timezone:'Europe/Rome',items:[],enabled:false},dominantLive:{armed:false,authorizedSourceId:null}});
            if(!imported)throw stateError('INVALID_STATE');
            await this.referenceValidator?.({sources:imported.sources,scenes:imported.scenes});
            this.diagnostics?.record('LEGACY_CATALOG_FOUND',{count:imported.sources.length});
            const result=reconcileReferenceCatalog(current,imported);
            if(result.status==='CONFLICT')return {status:result.status,conflicts:result.conflicts,revision:current.revision};
            const candidate=validateAuthoritativeState({...current,initialized:true,sources:result.sources,scenes:result.scenes,
                revision:current.revision+1,updatedAt:this.clock().toISOString()});
            if(!candidate)throw stateError('INVALID_STATE');
            const state=current.initialized&&result.status!=='IMPORTED'?current:await this.repository.commit(candidate);
            this.diagnostics?.record('LEGACY_CATALOG_RECONCILED',{count:state.sources.length,complete:true});
            if(state!==current)this.listeners.forEach(listener=>{try{listener({type:'catalog',revision:state.revision,changedDomains:['sources','scenes']});}catch{}});
            return {status:result.status,state};
        });
    }
}

function stateError(code) { return Object.assign(new Error(code), { code }); }
