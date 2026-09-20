import { validateProgramOutputEnvelope } from
    "../../public/js/program-output/ProgramOutputEnvelope.js";

const MAX_RETIRED_SESSIONS = 100;

export default class ProgramOutputStore {
    constructor() {
        this.current = null;
        this.retiredSessions = new Set();
        this.listeners = new Set();
    }

    prepare(candidate) {
        // Composite revision and schedule timing are owned exclusively by the server merger.
        if (candidate?.snapshot?.output !== undefined || candidate?.snapshot?.overlays?.sponsor !== undefined || candidate?.snapshot?.overlays?.textCrawl?.scheduled !== undefined)
            return Object.freeze({ accepted: false, reason: "server-owned-output" });
        const envelope = validateProgramOutputEnvelope(candidate);
        if (!envelope) return Object.freeze({ accepted: false, reason: "invalid" });
        if (this.retiredSessions.has(envelope.publisherSessionId)) {
            return Object.freeze({ accepted: false, reason: "retired-session" });
        }
        const previous=this.current||this.historicalCurrent;
        if (previous?.publisherSessionId === envelope.publisherSessionId) {
            if (envelope.revision <= previous.revision) {
                return Object.freeze({ accepted: false, reason: "stale-revision" });
            }
        }
        const retiredPublisherSessions=[...this.retiredSessions];
        if(previous&&previous.publisherSessionId!==envelope.publisherSessionId)retiredPublisherSessions.push(previous.publisherSessionId);
        return {accepted:true,envelope,retiredPublisherSessions:retiredPublisherSessions.slice(-MAX_RETIRED_SESSIONS)};
    }
    restoreHistory(record){this.historicalCurrent=record.envelope;this.retiredSessions=new Set(record.retiredPublisherSessions);}
    install(candidate,notify=true){
        this.historicalCurrent=null;
        this.current=candidate.envelope;this.retiredSessions=new Set(candidate.retiredPublisherSessions);
        if(notify)this.notify();
    }
    notify(){for(const listener of this.listeners)try{listener(this.current);}catch{/* Durable commit cannot be rolled back by an observer. */}}
    accept(candidate){const next=this.prepare(candidate);if(!next.accepted)return next;this.install(next);return Object.freeze({accepted:true,reason:'accepted',envelope:next.envelope});}

    getCurrent() { return this.current; }
    subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    retire(sessionId) {
        this.retiredSessions.add(sessionId);
        if (this.retiredSessions.size > MAX_RETIRED_SESSIONS) {
            this.retiredSessions.delete(this.retiredSessions.values().next().value);
        }
    }
}
