import { operatorFetch } from '../auth/OperatorSessionClient.js';

// Two-phase operator command: stage without runtime effects, commit reference-bearing
// metadata on the server, then apply the existing local operation. Playback stays local.
export default class StudioReferenceAuthority {
    constructor({ catalog, request = requestJson, client }) {
        Object.assign(this, { catalog, request, client });
        this.queue = Promise.resolve();
        this.ready = false;
    }
    projection(catalog = this.catalog) {
        const sources = [...catalog.sources.values()].map(source => {
            const value = catalog.serializeSource(source);
            // Legacy aliases refer to external URLs; managed aliases are canonicalized
            // against the shared library, never against a filename.
            for (const [field, urlField] of [['assetId','url'],['audioAssetId','audioUrl'],
                ['stillAssetId','stillUrl'],['motionAssetId','motionUrl']]) {
                if (!value[field] || /^asset-[0-9a-f-]{36}$/i.test(value[field])) continue;
                const asset = catalog.assetResolver?.getAsset?.(value[field]);
                if (!asset) throw new Error('ASSET NON DISPONIBILE');
                const managed = catalog.assetResolver.mediaLibraryManager?.getSnapshot()?.assets.find(item => {
                    try { return decodeURIComponent(new URL(asset.url).pathname) === item.url; } catch { return false; }
                });
                if (managed) value[field] = managed.id;
                else { delete value[field]; value[urlField] = asset.url; }
            }
            return value;
        });
        const scenes = [...catalog.definitions.values()].map(({id,name,type,renderer}) => ({id,name,type,renderer:{...renderer}}));
        return { sources, scenes };
    }
    reconcileRuntimeScenes() {
        const state = this.catalog.studioStateManager;
        if (!state?.getScene || !state?.registerScene) return true;
        for (const scene of this.catalog.definitions.values()) {
            const source = scene.renderer?.kind === 'source' ? this.catalog.sources.get(scene.renderer.sourceId) : null;
            // Disabled LIVE definitions intentionally remain persisted but absent from the runtime scene registry.
            if (source?.kind === 'hls' && source.enabled === false) continue;
            if (state.getScene(scene.id)) continue;
            if (!state.registerScene(scene)) return false;
        }
        return true;
    }
    async initialize() {
        try {
            const { state } = await this.request('/api/studio/state');
            if(this.catalog.loadOverlay?.().issues?.length){await this.client?.reportInvalid();this.issue='LEGACY_CATALOG_INVALID';return false;}
            const projection = this.projection();
            const result=await this.request('/api/studio/state/catalog/reconcile',{method:'POST',body:JSON.stringify({...projection,revision:state.revision,version:1})});
            const committed=result.state;
            if(!this.reconcileRuntimeScenes()){this.issue='CATALOG_RUNTIME_RECONCILIATION_REQUIRED';await this.client?.reportInvalid();return false;}
            this.serverSnapshot=committed;this.localSnapshot=projection;
            this.revision = committed.revision;
            this.ready = true;
            return true;
        } catch(error) { this.issue = error.code==='CATALOG_AUTHORITY_CONFLICT'?'CATALOG_AUTHORITY_CONFLICT':'REFERENCE INVENTORY INCOMPLETE';await this.client?.reportInvalid().catch(()=>{});return false; }
    }
    createDraftManager(manager, mutations) {
        // The draft must never mutate the live runtime registry. A proxy that merely
        // replaced mutation methods was insufficient because read methods remained
        // bound to the live manager: staged removeScene() therefore observed the live
        // scene and its fake unregister succeeded, but later compound draft operations
        // could still reason from runtime state that did not reflect earlier staged
        // mutations. Keep a tiny isolated scene/source identity model for the methods
        // catalog mutations use while all other reads remain delegated.
        const sceneMap = manager?.getScenes ? new Map(manager.getScenes().map(scene => [scene.id, scene])) : null;
        const sourceMap = manager?.getSources ? new Map(manager.getSources().map(source => [source.id, source])) : null;
        return new Proxy(manager, { get(target, key) {
            if (key === 'getScene' && sceneMap) return id => sceneMap.get(id) || null;
            if (key === 'getScenes' && sceneMap) return () => [...sceneMap.values()];
            if (key === 'registerScene' && sceneMap) return scene => {
                if (!scene || sceneMap.has(scene.id)) return null; sceneMap.set(scene.id, scene); return scene;
            };
            if (key === 'replaceScene' && sceneMap) return scene => {
                if (!scene || !sceneMap.has(scene.id)) return null; sceneMap.set(scene.id, scene); return scene;
            };
            if (key === 'unregisterScene' && sceneMap) return id => {
                const scene=sceneMap.get(id); if(!scene)return null; sceneMap.delete(id); return scene;
            };
            if (key === 'getSource' && sourceMap) return id => sourceMap.get(id) || null;
            if (key === 'getSources' && sourceMap) return () => [...sourceMap.values()];
            if (key === 'registerSource' && sourceMap) return source => {
                if (!source || sourceMap.has(source.id)) return null; sourceMap.set(source.id, source); return source;
            };
            if (key === 'replaceSource' && sourceMap) return source => {
                if (!source || !sourceMap.has(source.id)) return null; sourceMap.set(source.id, source); return source;
            };
            if (key === 'unregisterSource' && sourceMap) return id => {
                const source=sourceMap.get(id); if(!source)return null; sourceMap.delete(id); return source;
            };
            if (mutations.includes(key)) return () => true;
            const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
        } });
    }
    execute(method, args) {
        const input = structuredClone(args);
        const operation = async () => {
            if (!this.ready) return { ok: false, reason: this.issue || 'REFERENCE INVENTORY INCOMPLETE' };
            const original = this.catalog;
            const draft = Object.assign(Object.create(Object.getPrototypeOf(original)), original);
            for (const [key, value] of Object.entries(original)) {
                if (value instanceof Map) draft[key] = new Map(value);
                if (value instanceof Set) draft[key] = new Set(value);
            }
            draft.referenceAuthority = null;
            draft.listeners = new Set();
            draft.persistOverlay = draft.writeOverlay = () => true;
            draft.studioSourceManager = this.createDraftManager(original.studioSourceManager,
                ['registerSource','replaceSource','unregisterSource']);
            draft.studioStateManager = this.createDraftManager(original.studioStateManager,
                ['registerScene','replaceScene','unregisterScene']);
            const ids = [];
            draft.uuidFactory = () => { const id = original.uuidFactory(); ids.push(id); return id; };
            let staged, committed;
            try {
                staged = draft[method](...input);
                if (!staged.ok) return staged;
                const local=this.projection(draft);
                const candidate=this.preserveServerRecords(local);
                committed = await this.request('/api/studio/state/catalog', { method: 'PUT',
                    body: JSON.stringify({ ...candidate, revision: this.revision }) });
                this.serverSnapshot=committed.state;this.localSnapshot=local;
            } catch (error) {
                if (error.code === 'REVISION_CONFLICT') { this.ready = false; this.issue = 'CATALOG_AUTHORITY_CONFLICT'; }
                return { ok: false, reason: error.code || 'REFERENCE INVENTORY INCOMPLETE' };
            }
            this.revision = committed.state.revision;
            const uuid = original.uuidFactory;
            original.uuidFactory = () => ids.shift();
            original.referenceAuthorityApplying = true;
            let result;
            try {
                result = original[method](...input);
                if (!result.ok) {
                    // Do not silently undo a durable server reference. Stop edits until
                    // catalog reconciliation; production deletion remains fail-closed.
                    this.ready = false; this.issue = 'CATALOG_RECONCILIATION_REQUIRED';
                }
            } finally { original.uuidFactory = uuid; original.referenceAuthorityApplying = false; }
            if(result.ok&&this.client){try{await this.client.confirmCatalog(this.revision);}catch{this.ready=false;this.issue='CATALOG_RECONCILIATION_REQUIRED';}}
            return result;
        };
        const result = this.queue.then(operation, operation);
        this.queue = result.catch(() => {});
        return result;
    }
    preserveServerRecords(candidate){
        if(!this.serverSnapshot||!this.localSnapshot)return candidate;
        const result={};
        for(const domain of ['sources','scenes']){
            const previousIds=new Set(this.localSnapshot[domain].map(value=>value.id));
            const records=new Map(this.serverSnapshot[domain].filter(value=>!previousIds.has(value.id)).map(value=>[value.id,value]));
            candidate[domain].forEach(value=>records.set(value.id,value));result[domain]=[...records.values()];
        }
        return result;
    }
}
async function requestJson(url, options) {
    const response = await operatorFetch(url, { ...options, headers: { 'Content-Type': 'application/json' } });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw Object.assign(new Error('Reference authority unavailable'), { code: payload.error?.code });
    return payload;
}
