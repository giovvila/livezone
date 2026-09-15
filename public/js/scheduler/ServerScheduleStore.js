import ScheduleApiClient from './ScheduleApiClient.js';
import {serializeProgramPlan,editorPlan,normalizeProgramPlan} from './ProgramScheduleAdapter.js';
const LEGACY='livezone.scheduler.schedule.v1';
const MARKER='livezone.scheduler.schedule.serverMigration.v1';
export default class ServerScheduleStore {
    constructor({client=new ScheduleApiClient(),storage=globalThis.localStorage}={}){
        this.client=client;this.storage=storage;this.listeners=new Set();this.serverAuthoritative=true;this.migration='';
        this.unsubscribe=client.subscribe(()=>this.emit());
    }
    async start(){await this.client.start();await this.importLegacy();this.emit();}
    async importLegacy(){
        if(!this.client.writable)return;
        let raw;try{raw=this.storage?.getItem(LEGACY);}catch{this.migration='LEGACY STORAGE UNAVAILABLE';return;}
        if(!raw)return;
        let plan;try{plan=normalizeProgramPlan(JSON.parse(raw));}catch{this.migration='LEGACY INVALID — PRESERVED';return;}
        if(!plan.items.length)return;
        const server=this.client.state.schedule;
        if(server.programPlan?.items.length||server.events.length){this.migration='SERVER AUTHORITATIVE — LEGACY PRESERVED';return;}
        // Import is restricted server-side to a pristine domain; never auto-import after a deliberate clear.
        if(server.revision!==0){this.migration='LEGACY IMPORT REQUIRES REVIEW';return;}
        const result=await this.client.saveProgramPlan(plan,{importOnly:true});
        if(!result.ok){this.migration='LEGACY IMPORT NOT APPLIED — SERVER PRESERVED';return;}
        const verified=await this.client.refresh();
        if(verified&&JSON.stringify(this.client.state.schedule?.programPlan)===JSON.stringify(plan)){
            this.migration='LEGACY IMPORT VERIFIED — ORIGINAL PRESERVED';
            try{this.storage?.setItem(MARKER,JSON.stringify({version:1,revision:this.client.state.schedule.revision}));}catch{this.migration+=' (MARKER UNAVAILABLE)';}
        }else this.migration='LEGACY IMPORT VERIFICATION REQUIRED';
    }
    get runtime(){return this.client.state.runtime;}
    get writable(){return this.client.writable;}
    load(){return this.getSnapshot();}
    getSnapshot(){return {schedule:editorPlan(this.client.state.schedule?.programPlan),issues:[],
        connection:this.client.state.connection,reason:this.client.state.reason,feedback:this.client.state.feedback,migration:this.migration,
        revision:this.client.state.schedule?.revision??null,runtime:this.runtime};}
    subscribe(fn){this.listeners.add(fn);fn(this.getSnapshot());return()=>this.listeners.delete(fn);}
    emit(){for(const fn of this.listeners)fn(this.getSnapshot());}
    async save(schedule){
        let plan;try{plan=normalizeProgramPlan(serializeProgramPlan(schedule));}catch{return {ok:false};}
        const result=await this.client.saveProgramPlan(plan);return {...result,schedule:this.getSnapshot().schedule};
    }
    destroy(){this.unsubscribe();this.client.destroy();this.listeners.clear();}
}
