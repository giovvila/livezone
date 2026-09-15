import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {referenceError} from './AssetReferenceInventory.js';

// Reference metadata only; renderer state remains owned by the operator client.
export default class ChannelLogoAuthority {
    constructor({path,coordinator,inventory,clients}){
        Object.assign(this,{path,coordinator,inventory,clients});this.records=new Map();this.available=true;this.ready=this.load();
    }
    async load(){
        if(!this.path)return;
        try{
            const data=JSON.parse(await readFile(this.path,'utf8'));
            if(data.version!==1||!Array.isArray(data.records)||data.records.length>256)throw Error();
            for(const [key,value] of data.records){
                if(!/^[0-9a-f-]{36}:(preview|program)$/.test(key)||this.records.has(key)||!Number.isSafeInteger(value.revision)||value.revision<1||
                    !Number.isSafeInteger(value.generation)||value.generation<1||
                    typeof value.pending!=='boolean'||!Array.isArray(value.references)||!Array.isArray(value.previous)||value.references.length>1||value.previous.length>500||
                    [...value.references,...value.previous].some(ref=>!ref||typeof ref.assetId!=='string'))throw Error();
                this.records.set(key,value);
            }
        }catch(error){if(error.code!=='ENOENT')this.available=false;}
    }
    async persist(){if(!this.path)return;await mkdir(dirname(this.path),{recursive:true});
        await writeFile(this.path+'.tmp',JSON.stringify({version:1,records:[...this.records]}));await rename(this.path+'.tmp',this.path);}
    mutate(operation){return this.coordinator.run(async()=>{
        await this.ready;if(!this.available)throw referenceError('REFERENCE_AUDIT_UNAVAILABLE');
        const before=structuredClone(this.records);let result;
        try{result=operation();}catch(error){this.records=before;throw error;}
        try{await this.persist();}catch(error){this.records=before;this.available=false;throw error;}return result;
    });}
    key(client,consumer){const current=this.clients.clients.get(client?.id);if(!client?.supported||!current?.active||current.generation!==client.generation||!['preview','program'].includes(consumer))throw referenceError('CLIENT_CAPABILITY_REQUIRED');return client.id+':'+consumer;}
    get(client,consumer){return structuredClone(this.records.get(this.key(client,consumer))||{revision:0,pending:false,references:[],previous:[]});}
    assign(client,consumer,{revision,asset=null}={}){return this.mutate(()=>{
        const key=this.key(client,consumer),old=this.records.get(key);
        if(revision!==(old?.revision||0))throw referenceError('REVISION_CONFLICT');
        if(asset!==null&&(typeof asset!=='string'||asset.length>4096))throw referenceError('INVALID_LOGO');
        if(asset!==null){let url;try{url=new URL(asset,'http://reference.invalid');decodeURIComponent(url.pathname);}catch{throw referenceError('INVALID_LOGO');}
            if(!['http:','https:'].includes(url.protocol))throw referenceError('INVALID_LOGO');}
        const references=asset===null?[]:this.inventory.validate({asset}).map(ref=>({assetId:ref.assetId}));
        const value={revision:revision+1,pending:true,generation:client.generation,references,
            previous:[...old?.references||[],...old?.previous||[]].filter((ref,index,array)=>array.findIndex(other=>other.assetId===ref.assetId)===index)};
        if(value.previous.length>500)throw referenceError('REFERENCE_AUDIT_UNAVAILABLE');
        this.records.set(key,value);return structuredClone(value);
    });}
    acknowledge(client,consumer,revision){return this.mutate(()=>{
        const value=this.records.get(this.key(client,consumer));
        if(!value||value.revision!==revision||value.generation!==client.generation)throw referenceError('REVISION_CONFLICT');
        value.pending=false;value.previous=[];return structuredClone(value);
    });}
    snapshot(){
        const active=[...this.clients.clients.values()].filter(client=>client.active&&client.role==='CONTROL');
        const complete=this.available&&active.every(client=>['preview','program'].every(consumer=>{
            const value=this.records.get(client.id+':'+consumer);return value&&!value.pending&&value.generation===client.generation;
        }))&&[...this.records.values()].every(value=>!value.pending);
        return {complete,references:[...this.records].flatMap(([id,value])=>[...value.references,...value.previous].map(ref=>({...ref,id,name:'Channel Logo'})))};
    }
}
