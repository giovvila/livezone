import {readFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {normalizeSchedule,normalizeEvent} from './ScheduleContract.js';
import ScheduleDiagnostics from './ScheduleDiagnostics.js';
const error = code => Object.assign(new Error(code),{code});
// Internal single-owner store. No default operator path and no HTTP exposure in A1.
export default class ScheduleStore {
    constructor({path,clock=()=>Date.now(),fileOperations={},diagnostics=new ScheduleDiagnostics({clock})}={}) {
        if(typeof path!=='string'||!path.trim())throw error('PATH_REQUIRED');
        this.path=resolve(path);this.clock=clock;this.diagnostics=diagnostics;
        this.fs={readFile,mkdir,open,rename,unlink,...fileOperations};
        this.state=null;this.status='UNINITIALIZED';this.listeners=new Set();this.queue=Promise.resolve();
    }
    initialize(){
        if(!this.initializing)this.initializing=this.hydrate();
        return this.initializing;
    }
    async hydrate(){
        try {
            const raw=await this.fs.readFile(this.path,'utf8');
            this.state=normalizeSchedule(JSON.parse(raw));this.status='READY';
        }catch(e){
            if(e.code==='ENOENT'){this.state=normalizeSchedule({version:1,revision:0,events:[]});this.status='READY';}
            else {this.state=null;this.status='UNAVAILABLE';this.diagnostics.record('persistence-error');}
        }
        this.diagnostics.record('schedule-hydrated',{revision:this.state?.revision});return this.state;
    }
    getSnapshot(){return this.state;}
    getStatus(){return Object.freeze({status:this.status,revision:this.state?.revision??null});}
    listEvents(){return this.state?.events??Object.freeze([]);}
    getEvent(id){return this.listEvents().find(e=>e.id===id)??null;}
    subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
    insert(event,expectedRevision){return this.mutate('insert',event?.id,event,expectedRevision);}
    update(id,patch,expectedRevision){return this.mutate('update',id,patch,expectedRevision);}
    replaceProgramPlan(plan,expectedRevision,{importOnly=false}={}){return this.mutate(importOnly?'import-plan':'plan',null,plan,expectedRevision);}
    delete(id,expectedRevision){return this.mutate('delete',id,null,expectedRevision);}
    setEnabled(id,enabled,expectedRevision){return this.update(id,{enabled},expectedRevision);}
    mutate(action,id,value,expectedRevision){
        if(this.closed)return Promise.resolve(Object.freeze({ok:false,code:'STORE_CLOSED'}));
        // Capture caller-owned objects before awaiting queue or filesystem operations.
        let input;
        try{input=value===null?null:structuredClone(value);}catch{return Promise.resolve({ok:false,code:'INVALID_EVENT'});}
        const operation=async()=>{
            await this.initialize();
            if(!this.state)return Object.freeze({ok:false,code:'SCHEDULE_UNAVAILABLE'});
            if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==this.state.revision){
                this.diagnostics.record('conflict',{revision:this.state.revision});
                return Object.freeze({ok:false,code:'REVISION_CONFLICT',revision:this.state.revision});
            }
            try{
                const events=[...this.state.events],index=events.findIndex(e=>e.id===id);
                if(action==='insert'&&index!==-1)throw error('DUPLICATE_ID');
                if(!['insert','plan','import-plan'].includes(action)&&index===-1)throw error('EVENT_NOT_FOUND');
                const now=new Date(this.clock()).toISOString();
                const planAction=['plan','import-plan'].includes(action);
                if(action==='import-plan'&&(this.state.revision!==0||this.state.events.length||this.state.programPlan?.items.length))throw error('SERVER_NOT_EMPTY');
                if(planAction){}
                else if(action==='delete')events.splice(index,1);
                else if(action==='insert')events.push(normalizeEvent({...input,createdAt:now,updatedAt:now}));
                else {
                    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['type','name','enabled','startAt','endAt','priority','payload'].includes(k)))throw error('INVALID_PATCH');
                    events[index]=normalizeEvent({...events[index],...input,updatedAt:now});
                }
                const next=normalizeSchedule({...this.state,revision:this.state.revision+1,events,...(planAction?{version:2,programPlan:input}:{})});
                // Validate only the changed event. Invalid historical entries remain protective
                // and must not prevent an operator from removing or repairing them.
                if (action === 'insert' || action === 'update') await this.referenceValidator?.(next.events.find(e => e.id === id));
                await this.persist(next);
                this.state=next;
                this.diagnostics.record('schedule-mutated',{revision:next.revision});
                for(const fn of this.listeners)try{fn(next);}catch{/* Observers cannot undo durable commit. */}
                return Object.freeze({ok:true,schedule:next});
            }catch(e){return Object.freeze({ok:false,code:e.code||'INVALID_EVENT'});}
        };
        const coordinated=()=>this.mutationCoordinator?this.mutationCoordinator.run(operation):operation();
        const result=this.queue.then(coordinated,coordinated);this.queue=result.then(()=>{},()=>{});return result;
    }
    async persist(next){
        const temp=resolve(dirname(this.path),`.schedule-${randomUUID()}.tmp`);let handle;
        try{
            await this.fs.mkdir(dirname(this.path),{recursive:true});
            handle=await this.fs.open(temp,'wx');
            await handle.writeFile(JSON.stringify(next)+'\n','utf8');await handle.sync();
            await handle.close();handle=null;
            await this.fs.rename(temp,this.path);
        }catch{
            if(handle)await handle.close().catch(()=>{});
            await this.fs.unlink(temp).catch(()=>{});
            this.diagnostics.record('persistence-error',{revision:this.state?.revision});throw error('PERSISTENCE_FAILED');
        }
    }
    async destroy(){this.closed=true;await this.queue;this.listeners.clear();}
}
