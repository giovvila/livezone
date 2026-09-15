import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import AutoLiveStore from './AutoLiveStore.js';
import AutoLiveRecoveryStore from './AutoLiveRecoveryStore.js';
import {POLICY,runtimeSnapshot,error,freeze} from './AutoLiveContract.js';

const owners=new Set();
export default class AutoLiveAuthority {
    constructor({path,recoveryPath,catalog,catalogReady=Promise.resolve(),resolveConfigRef=()=>null,
        coordinator,clock=()=>Date.now(),fileOperations={}}) {
        Object.assign(this,{catalog,catalogReady,resolveConfigRef,clock});
        this.keys=[path,recoveryPath].map(p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p));
        this.owned=new Set(this.keys).size===2&&this.keys.every(key=>!owners.has(key));if(this.owned)this.keys.forEach(key=>owners.add(key));
        this.sessionId=randomUUID();this.generation=0;this.listeners=new Set();
        this.store=new AutoLiveStore({path,clock,coordinator,fileOperations});
        this.recovery=new AutoLiveRecoveryStore({path:recoveryPath,coordinator,fileOperations});
        this.store.validateReferences=async state=>{await this.catalogReady;if(state.sourceId!==null&&!this.source(state.sourceId))throw error('SOURCE_UNRESOLVED');};
        this.offStore=this.store.subscribe(()=>this.refresh());this.offRecovery=this.recovery.subscribe(()=>this.refresh());
        this.ready=this.start();
    }
    async start(){
        if(this.owned)await Promise.all([this.store.initialize(),this.recovery.initialize(),Promise.resolve(this.catalogReady).catch(()=>{})]);
        this.refresh();
    }
    source(id){
        const state=this.catalog();if(!state?.initialized)return null;
        const source=state.sources.find(source=>source.id===id);
        if(!source || source.kind!=='hls' || source.enabled===false)return null;
        try{const url=new URL(source.url || this.resolveConfigRef(source.configRef));
            if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
            return source;
        }catch{return null;}
    }
    available(){return this.owned&&!this.closed&&this.store.status==='READY';}
    refresh(){
        if(this.closed)return;
        const config=this.store.getSnapshot(),sourceValid=Boolean(config?.sourceId&&this.source(config.sourceId));
        const key=JSON.stringify([this.available(),config,this.recovery.status,this.recovery.getSnapshot(),sourceValid]);
        if(key===this.fingerprint)return;this.fingerprint=key;
        this.runtime=runtimeSnapshot({config,sourceValid,available:this.available(),recoveryAvailable:this.recovery.status==='READY',
            sessionId:this.sessionId,generation:++this.generation,now:new Date(this.clock()).toISOString()});
        for(const fn of this.listeners)try{fn(this.current());}catch{}
    }
    current(){
        const config=this.store.getSnapshot(),recovery=this.recovery.getSnapshot();
        return freeze({version:1,config,runtime:this.runtime,policy:POLICY,
            migration:{pristine:this.available()&&config?.revision===0,completed:config?.migration!==null&&Boolean(config),version:config?.migration?.version??null},
            recovery:{status:this.recovery.status,revision:recovery?.revision??null,present:Boolean(recovery?.record),
                stage:recovery?.record?.stage??null,capability:'storage-only',referenceScope:this.recovery.referenceScope().classification},serverTime:new Date(this.clock()).toISOString()});
    }
    async mutate(value,revision,{migration=false}={}){
        await this.ready;if(!this.available())throw error('STORE_UNAVAILABLE');
        await (migration?this.store.migrate(value,revision):this.store.patch(value,revision));return this.current();
    }
    subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
    references(){
        // Another live writer owns these paths; this instance cannot certify its scope.
        if(!this.owned)return [{name:'AutoLive writer ownership unavailable',complete:false,data:null}];
        const catalog=this.catalog();const config=this.store.getSnapshot(),scope=this.recovery.referenceScope();
        const refs=[];
        const resolveSource=(sourceId)=>catalog?.initialized?catalog.sources.find(s=>s.id===sourceId):null;
        if(config?.sourceId){const source=resolveSource(config.sourceId);refs.push({name:'AutoLive selected source',complete:true,referenceScope:'finite',
            unresolvedRefs:source?[]:[{sourceId:config.sourceId}],data:source});}
        if(scope.record){const record=scope.record,source=resolveSource(record.sourceId);
            const scene=catalog?.scenes.find(s=>s.id===record.sceneId);
            const expected=record.expectedCurrentActivation;
            const candidate=expected?.sourceId?resolveSource(expected.sourceId):null;
            const candidateScene=catalog?.scenes.find(s=>s.id===expected?.sceneId);
            const expectedKnown=!expected?.sourceId||!!candidate||candidateScene?.renderer?.kind==='slate';
            refs.push({name:'AutoLive recovery',classification:'RUNTIME',complete:true,referenceScope:'finite',uncertain:scope.uncertain,
                unresolvedRefs:[...(!source&&record.sourceId?[{sourceId:record.sourceId}]:[]),...(!scene&&record.sceneId?[{sceneId:record.sceneId}]:[]),
                    ...(!expectedKnown?[{sourceId:expected.sourceId}]:[])],
                data:{id:record.sessionId,name:'AutoLive interrupted Program',source,scene,candidate,candidateScene,
                    assets:record.assets.map(a=>({assetId:a.assetId,kind:a.kind==='video'?'media':a.kind}))}});
        }
        return refs;
    }
    async close(){if(this.closed)return;this.closed=true;this.offStore();this.offRecovery();this.listeners.clear();
        await this.ready;await Promise.all([this.store.close(),this.recovery.close()]);if(this.owned)this.keys.forEach(key=>owners.delete(key));}
}
