import {operatorFetch,referenceEventUrl} from '../auth/OperatorSessionClient.js';
const ROOT='/api/studio/schedule';

// Editor/observer only: no clock, activation resolver or storage writes.
export default class ScheduleApiClient {
    constructor({request=operatorFetch,eventSourceFactory=url=>new EventSource(url)}={}) {
        Object.assign(this,{request,eventSourceFactory});this.listeners=new Set();this.retired=new Set();
        this.state={schedule:null,runtime:null,connection:'loading',feedback:null,reason:null};
        this.minimumRevision=0;this.epoch=0;this.requestSequence=0;this.appliedRequest=0;this.started=false;
    }
    subscribe(fn){this.listeners.add(fn);fn(this.state);return()=>this.listeners.delete(fn);}
    emit(){for(const fn of this.listeners)fn(this.state);}
    async start(){if(this.started)return;this.started=true;const epoch=this.epoch;await this.refresh();if(!this.started||epoch!==this.epoch)return;
        try{this.stream=this.eventSourceFactory(referenceEventUrl(ROOT+'/events'));}
        catch{this.connectionLost('SSE_UNAVAILABLE');return;}
        this.message=event=>{try{this.acceptRuntime(JSON.parse(event.data));}catch{/* Ignore malformed events. */}};
        this.error=()=>this.connectionLost('SSE_DISCONNECTED');
        this.stream.addEventListener('schedule-state',this.message);this.stream.addEventListener('error',this.error);
    }
    connectionLost(reason){
        if(!this.started)return;
        // An SSE error must not hide the initial GET failure (for example an old server's 404).
        this.state={...this.state,connection:this.state.schedule?'degraded':'unavailable',reason:this.state.reason||reason};this.emit();
    }
    acceptRuntime(runtime){
        if(!this.started||!runtime||typeof runtime.sessionId!=='string'||!Number.isSafeInteger(runtime.generation)||
            !Number.isSafeInteger(runtime.scheduleRevision)||!Array.isArray(runtime.activeEvents))return;
        if(this.retired.has(runtime.sessionId))return;
        const previous=this.state.runtime;
        if(previous?.sessionId===runtime.sessionId&&previous.generation===runtime.generation&&this.state.connection==='online'&&this.state.schedule?.revision===runtime.scheduleRevision)return;
        if(previous&&previous.sessionId!==runtime.sessionId){this.retired.add(previous.sessionId);++this.epoch;this.minimumRevision=0;this.state={...this.state,schedule:null};}
        else if(previous&&runtime.generation<previous.generation)return;
        this.minimumRevision=Math.max(this.minimumRevision,runtime.scheduleRevision);
        const next={...this.state,runtime,connection:runtime.status==='READY'?'online':'unavailable',reason:runtime.status==='READY'?null:'SERVER_UNAVAILABLE'};
        const changed=JSON.stringify(next)!==JSON.stringify(this.state);this.state=next;if(changed)this.emit();
        if(!this.state.schedule||this.state.schedule.revision!==runtime.scheduleRevision)void this.refresh();
    }
    async refresh(){
        const epoch=this.epoch,sequence=++this.requestSequence;
        try{
            const response=await this.request(ROOT);
            if(!response.ok)throw Object.assign(new Error(),{reason:response.status===404?'API_NOT_FOUND':response.status===401||response.status===403?'AUTH_REQUIRED':response.status===503?'SERVER_UNAVAILABLE':'API_HTTP_ERROR'});
            const body=await response.json().catch(()=>{throw Object.assign(new Error(),{reason:'INVALID_API_RESPONSE'});});
            if(!this.started||epoch!==this.epoch||sequence<this.appliedRequest)return false;
            if(!body.schedule||!body.runtime)throw Object.assign(new Error(),{reason:'INVALID_API_RESPONSE'});
            return this.acceptSnapshot(body,sequence);
        }catch(error){
            if(this.started&&epoch===this.epoch&&sequence>=this.appliedRequest){this.state={...this.state,connection:'unavailable',reason:error.reason||'API_UNREACHABLE'};this.emit();}
            return false;
        }
    }
    acceptSnapshot(body,sequence=++this.requestSequence){
        const revision=body.schedule?.revision;
        if(!this.started||!Number.isSafeInteger(revision)||revision<this.minimumRevision)return false;
        if(this.retired.has(body.runtime?.sessionId))return false;
        const old=this.state;
        if(old.runtime&&body.runtime.sessionId===old.runtime.sessionId&&body.runtime.generation<old.runtime.generation){
            body={...body,runtime:old.runtime};
        }
        this.minimumRevision=revision;this.appliedRequest=Math.max(this.appliedRequest,sequence);
        this.state={...old,schedule:body.schedule,runtime:body.runtime,connection:'online',reason:null};
        if(JSON.stringify(old)!==JSON.stringify(this.state))this.emit();
        return true;
    }
    get writable(){return this.started&&this.state.connection==='online'&&this.state.schedule?.revision===this.minimumRevision;}
    async mutate(method,id,value,{path=null}={}){
        if(!this.writable)return {ok:false,code:'SCHEDULE_UNAVAILABLE'};
        const epoch=this.epoch,revision=this.state.schedule.revision;
        try{
            const response=await this.request(ROOT+(path||('/events'+(id?'/'+encodeURIComponent(id):''))),{method,
                headers:{'Content-Type':'application/json','If-Match':`"schedule-${revision}"`},
                ...(value===undefined?{}:{body:JSON.stringify(value)})});
            const body=await response.json();if(!this.started||epoch!==this.epoch)return {ok:false,code:'STALE_RESPONSE'};
            if(response.status===412){this.state={...this.state,feedback:'SCHEDULE CHANGED — REFRESHED'};await this.refresh();return {ok:false,code:'REVISION_CONFLICT'};}
            if(!response.ok){if(response.status>=500||response.status===401||response.status===403){this.state={...this.state,connection:'unavailable'};this.emit();}return {ok:false,code:body.error?.code||'REQUEST_FAILED'};}
            this.acceptSnapshot(body);return {ok:true};
        }catch{if(this.started){this.state={...this.state,connection:'unavailable'};this.emit();}return {ok:false,code:'SCHEDULE_UNAVAILABLE'};}
    }
    saveProgramPlan(plan,{importOnly=false}={}){return this.mutate(importOnly?'POST':'PUT',null,plan,{path:importOnly?'/program-plan/import':'/program-plan'});}
    create(event){return this.mutate('POST',null,event);}
    update(id,patch){return this.mutate('PATCH',id,patch);}
    delete(id){return this.mutate('DELETE',id);}
    setEnabled(id,enabled){return this.update(id,{enabled});}
    destroy(){this.started=false;++this.epoch;this.stream?.removeEventListener('schedule-state',this.message);
        this.stream?.removeEventListener('error',this.error);this.stream?.close();this.listeners.clear();}
}
