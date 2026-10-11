import {readEvidenceSync,capturedEvidence} from '../recovery/PersistentEvidence.js';
import {readFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {normalizeSchedule,normalizeEvent,controlledSchedule} from './ScheduleContract.js';
import ScheduleDiagnostics from './ScheduleDiagnostics.js';
import {ENTRY_METADATA,ERA_ENTRY_METADATA,newEntryMetadata,migrateLiveIdentities,requiresLiveExecutionAuthority} from './ScheduledEventIdentity.js';
import {issueEraEntry,assertEraAuthority,assertEraIdentityMutation,eraAdmits} from '../recovery/ExecutionEraContract.js';
import {createLedgerV2Durability} from './LedgerV2Durability.js';
import {equal,hash} from './ScheduledEntryLedgerV2Protocol.js';
const error = code => Object.assign(new Error(code),{code});
const serverOwnedIdentity=[...ENTRY_METADATA,...ERA_ENTRY_METADATA,'entryKey','identitySchema'];
const grantRequestHash=event=>hash({type:event.type,sourceId:event.payload?.sourceId,startAt:event.startAt,endAt:event.endAt});
// Internal single-owner store. No default operator path and no HTTP exposure in A1.
export default class ScheduleStore {
    constructor({path,clock=()=>Date.now(),fileOperations={},diagnostics=new ScheduleDiagnostics({clock}),executionEra=null,authority,eraDurability=createLedgerV2Durability()}={}) {
        if(typeof path!=='string'||!path.trim())throw error('PATH_REQUIRED');
        this.path=resolve(path);this.clock=clock;this.diagnostics=diagnostics;
        Object.assign(this,{executionEra,authority,eraDurability});
        this.fs={readFile,mkdir,open,rename,unlink,...fileOperations};
        this.state=null;this.status='UNINITIALIZED';this.listeners=new Set();this.queue=Promise.resolve();
    }
    initialize(){
        if(!this.initializing)this.initializing=this.hydrate();
        return this.initializing;
    }
    async hydrate(){
        try {
            const raw=capturedEvidence(await this.fs.readFile(this.path),{json:true});
            const legacy=normalizeSchedule(raw.value);
            if(Boolean(legacy.executionEra)!==Boolean(this.executionEra)||(this.executionEra&&!equal(legacy.executionEra,this.executionEra.scheduleEra)))throw error('SCHEDULE_ERA_CONTEXT_REQUIRED');
            const migrated=migrateLiveIdentities(legacy,new Date(this.clock()).toISOString());
            const next=controlledSchedule(migrated,{ready:true}).schedule;
            // No in-memory schedule (and thus no scheduler evaluation) exists
            // until the entire classification and identity snapshot is durable.
            if(migrated!==legacy)await this.persist(next);
            this.state=next;this.status='READY';
        }catch(e){
            if(e.code==='ENOENT'&&!this.executionEra){this.state=normalizeSchedule({version:1,revision:0,events:[]});this.status='READY';}
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
            // An unobserved successful insert is recognized without another write.
            // Executable changes remain update operations, never insert retries.
            const existing=action==='insert'&&this.executionEra?this.getEvent(id):null;
            if(existing&&!serverOwnedIdentity.some(key=>Object.hasOwn(input||{},key))){
                try{
                    const request=normalizeEvent({...input,createdAt:existing.createdAt,updatedAt:existing.updatedAt});
                    if(grantRequestHash(request)===grantRequestHash(existing)&&existing.executionEraId){
                        assertEraAuthority(this.executionEra,this.authority,{ready:true});
                        if(!eraAdmits(this.executionEra,{identitySchema:2,eventId:id,...existing}))throw error('EXECUTION_ERA_GRANT_CHANGED');
                        return Object.freeze({ok:true,alreadyPublished:true,schedule:this.state});
                    }
                }catch(e){return Object.freeze({ok:false,code:e.code||'INVALID_EVENT'});}
            }
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
                else if(action==='insert'){
                    if(serverOwnedIdentity.some(key=>Object.hasOwn(input||{},key)))throw error('SERVER_OWNED_IDENTITY');
                    const event=normalizeEvent({...input,createdAt:now,updatedAt:now});
                    if(event.type==='source.live'&&this.executionEra)this.grantPublication=true;
                    events.push(normalizeEvent({...event,...(event.type==='source.live'?this.executionEra?await issueEraEntry(this.executionEra,id,{durability:this.eraDurability,authority:this.authority,requestHash:grantRequestHash(event),hook:this.eraGrantHook}):newEntryMetadata():{})}));
                }
                else {
                    if(serverOwnedIdentity.some(key=>Object.hasOwn(input||{},key)))throw error('SERVER_OWNED_IDENTITY');
                    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['type','name','enabled','startAt','endAt','priority','payload'].includes(k)))throw error('INVALID_PATCH');
                    const previous=events[index];
                    const candidate={...previous,...input,updatedAt:now};
                    if(candidate.type!=='source.live')[...ENTRY_METADATA,...ERA_ENTRY_METADATA].forEach(key=>delete candidate[key]);
                    else if(previous.type!=='source.live'){
                        if(this.executionEra)this.grantPublication=true;
                        Object.assign(candidate,this.executionEra?await issueEraEntry(this.executionEra,id,{durability:this.eraDurability,authority:this.authority,requestHash:grantRequestHash(candidate),hook:this.eraGrantHook}):newEntryMetadata());
                    }
                    else if(candidate.startAt!==previous.startAt || candidate.endAt!==previous.endAt || candidate.payload?.sourceId!==previous.payload.sourceId){
                        if(!Number.isSafeInteger(previous.entryRevision+1))throw error('ENTRY_REVISION_EXHAUSTED');
                        candidate.entryRevision=previous.entryRevision+1;
                    }
                    events[index]=normalizeEvent(candidate);
                    if(previous.type==='source.live' && candidate.type==='source.live' && candidate.entryRevision!==previous.entryRevision){
                        await this.validateEntryEdit?.(previous,events[index]);
                    }
                }
                const identified=this.state.version===3 || events.some(e=>e.type==='source.live');
                const publications=this.executionEra?[...new Set([...(this.state.publishedEraGrants??[]),...this.state.events.filter(e=>e.executionEraId).map(e=>e.incarnationId),...events.filter(e=>e.executionEraId).map(e=>e.incarnationId)])]:null;
                const next=normalizeSchedule({...this.state,...(publications?{publishedEraGrants:publications}:{}),revision:this.state.revision+1,events,...(planAction?{version:2,programPlan:input}:{}),
                    ...(identified?{version:3,liveIdentityMigration:this.state.liveIdentityMigration??null}:{})});
                // Validate only the changed event. Invalid historical entries remain protective
                // and must not prevent an operator from removing or repairing them.
                if (action === 'insert' || action === 'update') await this.referenceValidator?.(next.events.find(e => e.id === id));
                await this.persist(next);
            this.state=next;
                if(this.grantPublication)await this.eraGrantHook?.('grant-schedule/published',this.path);
                this.diagnostics.record('schedule-mutated',{revision:next.revision});
                for(const fn of this.listeners)try{fn(next);}catch{/* Observers cannot undo durable commit. */}
                if(this.grantPublication)await this.eraGrantHook?.('grant-schedule/before-return',this.path);
                return Object.freeze({ok:true,schedule:next});
            }catch(e){return Object.freeze({ok:false,code:e.code||'INVALID_EVENT'});}
            finally{this.grantPublication=false;}
        };
        const coordinated=()=>this.mutationCoordinator?this.mutationCoordinator.run(operation):operation();
        const result=this.queue.then(coordinated,coordinated);this.queue=result.then(()=>{},()=>{});return result;
    }
    async persist(next){
        const emit=point=>this.grantPublication?this.eraGrantHook?.('grant-schedule/'+point,this.path):undefined;
        // New incarnations, executable revisions and enabling LIVE share the
        // publication fence. Editorial edits/removal/hydration keep owner-only
        // authority. Identity comparison uses the canonical Scheduled entryKey.
        const publications=this.executionEra&&this.state?next.events.filter(event=>
            requiresLiveExecutionAuthority(this.state.events.find(current=>current.id===event.id),event)):[];
        if(publications.length)this.grantPublication=true;
        const beforeHash=publications.length?readEvidenceSync(this.path,{text:false}).sha256:null;
        const fence=()=>{
            if(!this.executionEra)return;
            if(!publications.length){assertEraAuthority(this.executionEra,this.authority);return;}
            if(this.path!==resolve(this.executionEra.schedulePath)||
                readEvidenceSync(this.path,{text:false}).sha256!==beforeHash)throw error('EXECUTION_ERA_GRANT_SCHEDULE_CHANGED');
            for(const event of publications)assertEraIdentityMutation(this.executionEra,this.authority,
                this.state.events.find(current=>current.id===event.id),event);
        };
        fence();
        const temp=resolve(dirname(this.path),`.schedule-${randomUUID()}.tmp`);let handle;let replacing=false;
        try{
            await this.fs.mkdir(dirname(this.path),{recursive:true});
            await emit('before-open');fence();
            handle=await this.fs.open(temp,'wx');
            await emit('opened');fence();
            if(this.grantPublication){
                const bytes=Buffer.from(JSON.stringify(next)+'\n');const mid=Math.floor(bytes.length/2);
                await handle.writeFile(bytes.subarray(0,mid));await emit('partial-written');fence();
                await handle.writeFile(bytes.subarray(mid));await emit('written');
            }else await handle.writeFile(JSON.stringify(next)+'\n','utf8');
            await handle.sync();await emit('file-flushed');
            await handle.close();handle=null;
            if(this.executionEra){this.eraDurability.sync(temp);await emit('namespace-flushed');fence();await emit('before-install');fence();replacing=true;this.eraDurability.replace(temp,this.path);await emit('installed');await this.eraDurability.syncFile(this.path);await emit('durable');}
            else {replacing=true;await this.fs.rename(temp,this.path);}
            if(next.version===3){
                handle=await this.fs.open(this.path,'r+');await handle.sync();await handle.close();handle=null;
            }
        }catch{
            if(next.version===3 && replacing){this.state=null;this.status='UNAVAILABLE';}
            if(handle)await handle.close().catch(()=>{});
            if(this.grantPublication){
                await (async()=>{await this.fs.readFile(temp);await emit('before-cleanup');await this.eraDurability.remove(temp);await emit('stage-cleaned');})().catch(()=>{});
            }else await this.fs.unlink(temp).catch(()=>{});
            this.diagnostics.record('persistence-error',{revision:this.state?.revision});throw error('PERSISTENCE_FAILED');
        }
    }
    async destroy(){this.closed=true;await this.initializing;await this.queue;this.listeners.clear();}
}
