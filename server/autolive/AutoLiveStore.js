import {readFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {defaultConfig,normalizeConfig,normalizePatch,normalizeLegacy,error} from './AutoLiveContract.js';

// One serialized writer; failed persistence never replaces the accepted snapshot.
export class AtomicAutoLiveStore {
    constructor({path,normalize,defaults,fileOperations={},coordinator=null}) {
        if (typeof path !== 'string' || !path.trim()) throw error('PATH_REQUIRED');
        Object.assign(this,{path:resolve(path),normalize,defaults,coordinator});
        this.fs={readFile,mkdir,open,rename,unlink,...fileOperations};
        this.state=null;this.status='UNINITIALIZED';this.queue=Promise.resolve();this.listeners=new Set();
    }
    initialize() { return this.initializing ??= this.hydrate(); }
    async hydrate() {
        let parsed;
        try { parsed=JSON.parse(await this.fs.readFile(this.path,'utf8'));this.state=this.normalize(parsed);this.status='READY'; }
        catch(e) { if(e.code==='ENOENT'){this.state=this.defaults();this.status='READY';}else{this.state=null;this.status='UNAVAILABLE';this.captureInvalidScope?.(parsed);} }
        return this.state;
    }
    getSnapshot(){return this.state;}
    subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
    change(expectedRevision,build) {
        const operation=async()=>{
            await this.initialize();
            if(this.closed || !this.state)throw error('STORE_UNAVAILABLE');
            if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==this.state.revision)throw error('REVISION_CONFLICT');
            if(expectedRevision===Number.MAX_SAFE_INTEGER)throw error('REVISION_EXHAUSTED');
            const next=this.normalize(await build(this.state));
            await this.validateReferences?.(next);
            await this.persist(next);
            this.state=next;
            for(const fn of this.listeners)try{fn(next);}catch{/* Committed state cannot be undone by an observer. */}
            return next;
        };
        const coordinated=()=>this.coordinator?this.coordinator.run(operation):operation();
        const result=this.queue.then(coordinated,coordinated);this.queue=result.catch(()=>{});return result;
    }
    async persist(next) {
        const temp=resolve(dirname(this.path),`.autolive-${randomUUID()}.tmp`);let handle;
        try {
            await this.fs.mkdir(dirname(this.path),{recursive:true});handle=await this.fs.open(temp,'wx');
            await handle.writeFile(JSON.stringify(next)+'\n','utf8');await handle.sync();await handle.close();handle=null;
            await this.fs.rename(temp,this.path);
        } catch {
            if(handle)await handle.close().catch(()=>{});await this.fs.unlink(temp).catch(()=>{});
            throw error('PERSISTENCE_FAILED');
        }
    }
    async close(){this.closed=true;await this.queue;this.listeners.clear();}
}
export default class AutoLiveStore extends AtomicAutoLiveStore {
    constructor({clock=()=>Date.now(),...options}){super({...options,normalize:normalizeConfig,defaults:defaultConfig});this.clock=clock;}
    patch(value,revision){
        let patch;try{patch=normalizePatch(structuredClone(value));}catch(e){return Promise.reject(e);}
        return this.change(revision,current=>({...current,...patch,revision:current.revision+1,updatedAt:new Date(this.clock()).toISOString()}));
    }
    migrate(value,revision){
        let legacy;try{legacy=normalizeLegacy(structuredClone(value));}catch(e){return Promise.reject(e);}
        return this.change(revision,current=>{
            if(current.revision!==0 || current.migration!==null)throw error('MIGRATION_CLOSED');
            const at=new Date(this.clock()).toISOString();
            return {...current,...legacy,revision:1,updatedAt:at,migration:{version:1,completedAt:at}};
        });
    }
}
