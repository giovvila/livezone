export default class LegacyAssetReferenceAuthority {
    constructor({library,mediaLibrary,client}){Object.assign(this,{library,mediaLibrary,client});this.queue=Promise.resolve();}
    projection(library=this.library){
        const assets=[];let complete=true;
        for(const value of library.getAssets()){
            let path;try{path=decodeURIComponent(new URL(value.url,globalThis.document?.baseURI).pathname);}catch{complete=false;continue;}
            if(!path.startsWith('/media-library/files/'))continue;
            const managed=this.mediaLibrary.getSnapshot().assets.find(asset=>asset.url===path);
            if(!managed){complete=false;continue;}
            const expected=['logo','still','image'].includes(value.kind)?'image':value.kind;
            if(managed.kind!==expected){complete=false;continue;}
            assets.push({assetId:managed.id,kind:managed.kind});
        }
        if(library.loadOverlay?.().issues?.length)complete=false;
        return {assets,complete};
    }
    async initialize(){try{const value=this.projection();const response=await this.client.updateLegacy(value);if(value.complete)await this.client.confirmLegacy(response.legacy.revision);this.ready=value.complete;}catch{this.ready=false;}return this.ready;}
    execute(method,args){
        const input=structuredClone(args);
        const operation=async()=>{
            if(!this.ready)return {ok:false,reason:'REFERENCE INVENTORY INCOMPLETE'};
            const draft=Object.assign(Object.create(Object.getPrototypeOf(this.library)),this.library);
            for(const [key,value] of Object.entries(this.library)){if(value instanceof Map)draft[key]=new Map(value);if(value instanceof Set)draft[key]=new Set(value);}
            draft.referenceAuthority=null;draft.listeners=new Set();draft.persistOverlay=()=>true;
            const ids=[];draft.uuidFactory=()=>{const id=this.library.uuidFactory();ids.push(id);return id;};
            const result=draft[method](...input);if(!result.ok)return result;
            let revision;
            try{const value=this.projection(draft);if(!value.complete)throw Error();revision=(await this.client.updateLegacy(value)).legacy.revision;}catch{return {ok:false,reason:'ASSET NON DISPONIBILE'};}
            const uuid=this.library.uuidFactory;this.library.uuidFactory=()=>ids.shift();this.library.referenceAuthorityApplying=true;
            let applied;
            try{applied=this.library[method](...input);if(!applied.ok){this.ready=false;void this.client.updateLegacy({assets:[],complete:false}).catch(()=>{});}}
            finally{this.library.uuidFactory=uuid;this.library.referenceAuthorityApplying=false;}
            if(applied.ok){try{await this.client.confirmLegacy(revision);}catch{this.ready=false;}}
            return applied;
        };
        const result=this.queue.then(operation,operation);this.queue=result.catch(()=>{});return result;
    }
}
