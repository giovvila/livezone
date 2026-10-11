import { operatorFetch } from '../auth/OperatorSessionClient.js';

export default class PreviewOwnershipClient {
    constructor({ getOwnership, fetcher = operatorFetch, intervalMs = 8000, storage, onStatus = () => {} }) {
        Object.assign(this, { getOwnership, fetcher, intervalMs, storage, onStatus });
        if(storage===undefined){try{this.storage=globalThis.sessionStorage;}catch{this.storage=null;}}
        this.sequence = 0;
        this.generation = 0;
    }
    start() {
        if(this.starting)return this.starting;
        this.starting=this.startOnce().finally(()=>{this.starting=null;});
        return this.starting;
    }
    fail(code,classification,intent) {
        this.available=false;this.stopped=true;clearTimeout(this.timer);
        this.failure={code,classification,intent,reviewRequired:true};
        try{this.onStatus(this.getStatus());}catch{ /* Presentation cannot change the failure fence. */ }
    }
    getStatus(){return {available:this.available===true,stopped:this.stopped===true,failure:this.failure?{...this.failure}:null};}
    async startOnce() {
        const generation = ++this.generation;
        this.stopped = false;
        this.failure=null;clearTimeout(this.timer);
        try{this.onStatus(this.getStatus());}catch{ /* Presentation does not own lifecycle. */ }
        let intent='CREATE_NEW';
        try {
            let resume=this.resumeIdentity;
            if(resume===null||resume===undefined){
                try{
                    const saved=this.storage?.getItem('livezone.preview-ownership.v2');
                    if(saved!==null&&saved!==undefined)intent='RESUME_EXISTING';
                    resume=JSON.parse(saved??'null');
                }catch{this.fail('INVALID_SAVED_IDENTITY','STOP_REVIEW_REQUIRED',intent);return;}
            }
            if(resume!==null&&resume!==undefined){
                intent='RESUME_EXISTING';this.resumeIdentity=resume;
                if(!resume||typeof resume!=='object'||typeof resume.sessionId!=='string'||!Number.isSafeInteger(resume.generation)||resume.generation<1||typeof resume.resumeToken!=='string'){
                    this.fail('INVALID_SAVED_IDENTITY','STOP_REVIEW_REQUIRED',intent);return;
                }
            }
            const response = await this.fetcher('/api/media-library/preview-ownership', { method: 'POST',
                headers:{'Content-Type':'application/json'},body:JSON.stringify(resume?{resumeSessionId:resume.sessionId,generation:resume.generation,resumeToken:resume.resumeToken}:{}) });
            const payload = await response.json();
            if (!response.ok || !payload.ok) {
                const code=payload.error?.code||'OWNERSHIP_UNAVAILABLE';
                const terminal=['OWNERSHIP_SESSION_EXPIRED','OWNERSHIP_STALE_UPDATE','INVALID_OWNERSHIP','CLIENT_GENERATION_CONFLICT','CLIENT_CAPABILITY_REQUIRED','GENERATION_EXHAUSTED'].includes(code);
                if(generation===this.generation)this.fail(code,terminal?'TERMINAL_RESUME_REJECTION':'STOP_REVIEW_REQUIRED',intent);
                return;
            }
            this.resumeIdentity={sessionId:payload.ownership.sessionId,generation:payload.ownership.generation,resumeToken:payload.ownership.resumeToken};
            this.lastSessionId=this.resumeIdentity.sessionId;this.serverGeneration=this.resumeIdentity.generation;
            this.storage?.setItem('livezone.preview-ownership.v2',JSON.stringify(this.resumeIdentity));
            if (generation !== this.generation || this.stopped) return;
            this.sessionId = payload.ownership.sessionId;
            this.sequence = 0;
            await this.report();
        } catch {
            if(generation===this.generation)this.fail('OWNERSHIP_RESULT_UNCERTAIN','UNCERTAIN_RESULT',intent);
            return;
        }
        if (generation === this.generation && !this.stopped) this.timer = setTimeout(() => {
            if (!this.sessionId) void this.start(); else void this.heartbeat();
        }, this.intervalMs);
    }
    async heartbeat() {
        if(this.stopped)return;
        if (!this.sessionId) return this.start();
        const generation = this.generation;
        await this.report();
        if (!this.stopped && generation === this.generation) {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => void this.heartbeat(), this.intervalMs);
        }
    }
    async report() {
        if (this.stopped || !this.sessionId) return;
        const generation = this.generation, sequence = ++this.sequence;
        try {
            const ownership = this.getOwnership();
            const response = await this.fetcher('/api/media-library/preview-ownership/' + this.sessionId, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assets: ownership.assets, ownerLabel: ownership.ownerLabel,
                    complete: ownership.complete, sequence,generation:this.serverGeneration||1 }) });
            const payload = await response.json();
            if (generation !== this.generation || sequence !== this.sequence) return;
            this.available = response.ok && payload.ok && payload.ownership?.complete !== false;
            if (payload.error?.code === 'OWNERSHIP_SESSION_EXPIRED') {
                this.fail(payload.error.code,'TERMINAL_RESUME_REJECTION','RESUME_EXISTING');
            }
        } catch { if (generation === this.generation && sequence === this.sequence) this.available = false; }
    }
    stop({confirmedGone=false}={}) {
        this.stopped = true; ++this.generation; clearTimeout(this.timer);
        const id = this.sessionId||this.lastSessionId;this.lastSessionId=id; this.sessionId = null;
        const lifecycle=this.generation;
        if(id&&confirmedGone)void this.fetcher('/api/media-library/preview-ownership/'+id,{method:'DELETE',keepalive:true,
            headers:{'X-Livezone-Ownership-Generation':String(this.serverGeneration||1)}}).then(response=>{
                if(response.ok&&this.generation===lifecycle&&this.stopped){try{this.storage?.removeItem('livezone.preview-ownership.v2');this.resumeIdentity=null;this.lastSessionId=null;}catch{}}
            }).catch(()=>{});
        else if(id)void this.fetcher('/api/media-library/preview-ownership/'+id,{method:'PUT',keepalive:true,
            headers:{'Content-Type':'application/json'},body:JSON.stringify({sequence:++this.sequence,generation:this.serverGeneration||1,assets:[],complete:false})}).catch(()=>{});
    }
}
