import {resolveSchedule} from './ScheduleContract.js';
import ScheduleDiagnostics from './ScheduleDiagnostics.js';
export const RECONCILIATION_INTERVAL_MS=1000;
export default class ScheduleAuthority {
    constructor({store,clock=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,
        diagnostics=new ScheduleDiagnostics({clock})}={}) {
        if(!store)throw new TypeError('Schedule store required');
        Object.assign(this,{store,clock,setTimer,clearTimer,diagnostics});
        this.listeners=new Set();this.evaluations=new Set();this.running=false;this.generation=0;this.timer=null;this.state=null;
    }
    async start(){
        if(this.running)return;this.running=true;const generation=++this.generation;
        await this.store.initialize();
        if(!this.running||generation!==this.generation)return;
        this.unsubscribe=this.store.subscribe(()=>this.reconcile());this.reconcile();
    }
    reconcile(){
        if(!this.running)return;
        if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;
        const generation=++this.generation;
        const schedule=this.store.getSnapshot();
        if(!schedule){this.state=null;return;}
        const next=resolveSchedule(schedule,this.clock());
        this.diagnostics.record('reconcile',{revision:next.scheduleRevision});
        const fingerprint=JSON.stringify(next.activeEvents);
        const changed=fingerprint!==this.fingerprint;
        this.state=next;this.fingerprint=fingerprint;
        for(const fn of this.evaluations)try{fn(next);}catch{/* Isolated observer. */}
        if(changed){
            this.diagnostics.record('effective-state-changed',{revision:next.scheduleRevision,activeCount:next.activeEvents.length});
            for(const fn of this.listeners)try{fn(next);}catch{/* Isolated observer. */}
        }
        if(!this.running||generation!==this.generation)return;
        const delay=next.nextDeadline===null?RECONCILIATION_INTERVAL_MS:
            Math.max(1,Math.min(RECONCILIATION_INTERVAL_MS,next.nextDeadline-next.evaluatedAt));
        this.diagnostics.record('deadline-scheduled',{deadline:next.evaluatedAt+delay});
        this.timer=this.setTimer(()=>{
            if(!this.running||generation!==this.generation)return;
            this.timer=null;this.diagnostics.record('deadline-fired');this.reconcile();
        },delay);
        this.timer?.unref?.();
    }
    getSnapshot(){return this.state;}
    subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
    subscribeEvaluation(fn){this.evaluations.add(fn);return()=>this.evaluations.delete(fn);}
    stop(){this.running=false;++this.generation;if(this.timer!==null)this.clearTimer(this.timer);
        this.timer=null;this.unsubscribe?.();this.unsubscribe=null;}
    destroy(){this.stop();this.listeners.clear();this.evaluations.clear();}
}
