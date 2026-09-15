import {validateSchedule,getActiveItem,getNextItem} from '../../public/js/scheduler/ScheduleContract.js';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import ScheduleStore from './ScheduleStore.js';
import ScheduleAuthority from './ScheduleAuthority.js';
import ScheduleDiagnostics from './ScheduleDiagnostics.js';
const owners=new Set();

export default class SchedulerServer {
    constructor({path,clock=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}) {
        this.path=resolve(path);this.clock=clock;this.sessionId=randomUUID();this.generation=0;
        this.ownerKey=process.platform==='win32'?this.path.toLowerCase():this.path;
        this.diagnostics=new ScheduleDiagnostics({clock});this.listeners=new Set();this.closed=false;
        this.owned=!owners.has(this.ownerKey);if(this.owned)owners.add(this.ownerKey);
        this.store=new ScheduleStore({path:this.path,clock,diagnostics:this.diagnostics});
        this.runtime=new ScheduleAuthority({store:this.store,clock,setTimer,clearTimer,diagnostics:this.diagnostics});
        this.unsubscribe=this.runtime.subscribeEvaluation(()=>this.refresh());
        this.ready=this.start();
    }
    async start(){
        this.diagnostics.record('scheduler-server-start');
        try {if(this.owned)await this.runtime.start();}
        catch {this.runtime.stop();this.failed=true;this.diagnostics.record('persistence-error');}
        this.refresh();
    }
    available(){return !this.closed&&this.owned&&!this.failed&&this.store.getStatus().status==='READY';}
    refresh(){
        if(this.closed)return;
        const state=this.runtime.getSnapshot();
        const key=JSON.stringify([this.available(),state?.scheduleRevision,state?.activeEvents,state?.nextDeadline,this.programSummary()]);
        if(key===this.fingerprint)return;
        this.fingerprint=key;++this.generation;
        this.diagnostics.record('retained-state-update',{revision:state?.scheduleRevision});
        const snapshot=this.summary();for(const fn of this.listeners)try{fn(snapshot);}catch{}
    }
    programSummary(){
        const plan=this.store.getSnapshot()?.programPlan;const schedule=plan?validateSchedule(plan).schedule:null;const now=this.clock();
        return {execution:"SUSPENDED",activeId:getActiveItem(schedule,now)?.id??null,nextId:getNextItem(schedule,now)?.id??null,
            items:(schedule?.items??[]).map(item=>({id:item.id,status:now<item.startMs?"UPCOMING":now<item.endMs?"ACTIVE":"EXPIRED"}))};
    }
    summary(){
        const state=this.runtime.getSnapshot();
        return Object.freeze({version:1,sessionId:this.sessionId,generation:this.generation,
            status:this.available()?'READY':'UNAVAILABLE',programPlan:this.programSummary(),scheduleRevision:this.store.getSnapshot()?.revision??null,
            serverTime:this.clock(),evaluatedAt:state?.evaluatedAt??null,nextDeadline:state?.nextDeadline??null,
            events:this.store.listEvents().map(e=>({id:e.id,type:e.type,status:!e.enabled?'DISABLED':this.clock()<Date.parse(e.startAt)?'UPCOMING':this.clock()>=Date.parse(e.endAt)?'EXPIRED':state?.activeEvents.some(a=>a.id===e.id)?'ACTIVE':'SUPPRESSED'})),
            activeEvents:(state?.activeEvents??[]).map(e=>({id:e.id,type:e.type}))});
    }
    current(){this.runtime.reconcile();this.refresh();return this.summary();}
    subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
    async close(){
        if(this.closing)return this.closing;
        this.closed=true;this.runtime.destroy();this.unsubscribe();this.listeners.clear();
        this.diagnostics.record('scheduler-server-stop');
        this.closing=(async()=>{await this.ready;await this.store.destroy();if(this.owned)owners.delete(this.ownerKey);})();
        return this.closing;
    }
}
