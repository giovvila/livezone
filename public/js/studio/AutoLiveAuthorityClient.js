import {operatorFetch} from '../auth/OperatorSessionClient.js';

const ROOT='/api/studio/autolive';
const valid=body=>body?.version===1 && body.config?.version===1 && Number.isSafeInteger(body.config.revision) && body.config.revision>=0 &&
    typeof body.config.enabled==='boolean' && typeof body.config.armed==='boolean' &&
    (body.config.sourceId===null || typeof body.config.sourceId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(body.config.sourceId)) &&
    body.runtime?.executionAuthority==='browser-legacy' && typeof body.runtime.sessionId==='string' &&
    Number.isSafeInteger(body.runtime.generation) && body.runtime.configRevision===body.config.revision &&
    typeof body.migration?.pristine==='boolean' && typeof body.migration?.completed==='boolean';

// A supplied factory must return a lease on ControlEventStream, never a new SSE.
export default class AutoLiveAuthorityClient {
    constructor({request=operatorFetch,streamFactory=null}={}){
        Object.assign(this,{request,streamFactory});this.listeners=new Set();this.retired=new Set();
        this.state={connection:'unavailable',snapshot:null,error:null};this.epoch=0;this.authorityEpoch=0;this.sequence=0;
    }
    subscribe(fn){this.listeners.add(fn);fn(this.state);return()=>this.listeners.delete(fn);}
    emit(){for(const fn of this.listeners)fn(this.state);}
    fail(code){this.state={...this.state,connection:'unavailable',error:code};this.emit();}
    async start(){
        if(this.started)return this.state.connection==='online';this.started=true;++this.epoch;
        if(this.streamFactory){try{
            this.stream=this.streamFactory();
            this.message=event=>{try{this.accept(JSON.parse(event.data));}catch{}};
            this.disconnected=()=>this.fail('EVENT_STREAM_UNAVAILABLE');
            this.opened=()=>void this.refresh();
            this.stream.addEventListener('autolive-state',this.message);
            this.stream.addEventListener('error',this.disconnected);this.stream.addEventListener('open',this.opened);
        }catch{this.fail('EVENT_STREAM_UNAVAILABLE');}}
        await this.refresh();return this.state.connection==='online';
    }
    accept(body){
        if(!this.started||!valid(body)||this.retired.has(body.runtime.sessionId))return false;
        const old=this.state.snapshot;
        if(old && (body.config.revision<old.config.revision || old.runtime.sessionId===body.runtime.sessionId&&body.runtime.generation<old.runtime.generation))return false;
        if(old&&old.runtime.sessionId!==body.runtime.sessionId){
            this.retired.add(old.runtime.sessionId);if(this.retired.size>64)this.retired.delete(this.retired.values().next().value);++this.authorityEpoch;
        }
        this.state={connection:'online',snapshot:body,error:null};this.emit();return true;
    }
    async refresh(){
        const epoch=this.epoch,authorityEpoch=this.authorityEpoch,sequence=++this.sequence;
        try{
            const response=await this.request(ROOT),body=await response.json();
            if(!this.started||epoch!==this.epoch||authorityEpoch!==this.authorityEpoch||sequence!==this.sequence)return false;
            if(!response.ok||!valid(body)){this.fail(body.error?.code||'AUTOLIVE_UNAVAILABLE');return false;}
            return this.accept(body);
        }catch{if(this.started&&epoch===this.epoch&&authorityEpoch===this.authorityEpoch&&sequence===this.sequence)this.fail('AUTOLIVE_UNAVAILABLE');return false;}
    }
    async mutate(value,{migration=false}={}){
        if(!this.started||this.state.connection!=='online')return {ok:false,code:'AUTOLIVE_UNAVAILABLE'};
        const epoch=this.epoch,authorityEpoch=this.authorityEpoch,revision=this.state.snapshot.config.revision;
        try{
            const response=await this.request(ROOT+(migration?'/migrate':''),{method:migration?'POST':'PATCH',
                headers:{'Content-Type':'application/json','If-Match':`"autolive-${revision}"`},body:JSON.stringify(value)});
            const body=await response.json();
            if(!this.started||epoch!==this.epoch||authorityEpoch!==this.authorityEpoch)return {ok:false,code:'STALE_RESPONSE'};
            if(!response.ok){const code=body.error?.code||'REQUEST_FAILED';
                if(response.status===412||response.status===409)await this.refresh();
                else if(response.status>=500||response.status===401||response.status===403)this.fail(code);
                return {ok:false,code};}
            if(!valid(body)){this.fail('INVALID_RESPONSE');return {ok:false,code:'INVALID_RESPONSE'};}
            this.accept(body);return {ok:true};
        }catch{if(this.started&&epoch===this.epoch)this.fail('AUTOLIVE_UNAVAILABLE');return {ok:false,code:'AUTOLIVE_UNAVAILABLE'};}
    }
    migrate(value){return this.mutate(value,{migration:true});}
    destroy(){this.started=false;++this.epoch;this.stream?.removeEventListener('autolive-state',this.message);
        this.stream?.removeEventListener('error',this.disconnected);this.stream?.removeEventListener('open',this.opened);
        this.stream?.close();this.listeners.clear();}
}
