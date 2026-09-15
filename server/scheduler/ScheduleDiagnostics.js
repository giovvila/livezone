// Bounded, payload-free diagnostic history. Never invoke external callbacks on the write path.
export default class ScheduleDiagnostics {
    constructor({capacity=100,clock=()=>Date.now()}={}) {
        this.capacity=Number.isInteger(capacity)?Math.max(1,Math.min(1000,capacity)):100;
        this.clock=clock;this.entries=[];
    }
    record(event, fields={}) {
        const entry={event};
        try { const at=this.clock(); if(Number.isFinite(at))entry.at=at; } catch {}
        for(const key of ['revision','deadline','activeCount'])if(Number.isFinite(fields[key]))entry[key]=fields[key];
        this.entries.push(Object.freeze(entry));if(this.entries.length>this.capacity)this.entries.shift();
    }
    snapshot(){return Object.freeze([...this.entries]);}
}
