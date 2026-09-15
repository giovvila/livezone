import { operatorFetch } from '../auth/OperatorSessionClient.js';

export default class PreviewOwnershipClient {
    constructor({ getOwnership, fetcher = operatorFetch, intervalMs = 8000, storage }) {
        Object.assign(this, { getOwnership, fetcher, intervalMs, storage });
        if(storage===undefined){try{this.storage=globalThis.sessionStorage;}catch{this.storage=null;}}
        this.sequence = 0;
        this.generation = 0;
    }
    async start() {
        const generation = ++this.generation;
        this.stopped = false;
        try {
            let resume;try{resume=JSON.parse(this.storage?.getItem('livezone.preview-ownership.v2')||'null');}catch{}
            const response = await this.fetcher('/api/media-library/preview-ownership', { method: 'POST',
                headers:{'Content-Type':'application/json'},body:JSON.stringify(resume?{resumeSessionId:resume.sessionId,generation:resume.generation,resumeToken:resume.resumeToken}:{}) });
            const payload = await response.json();
            if(payload.error?.code==='OWNERSHIP_SESSION_EXPIRED'){try{this.storage?.removeItem('livezone.preview-ownership.v2');}catch{}}
            if (!response.ok || !payload.ok) throw new Error('ownership unavailable');
            if (generation !== this.generation || this.stopped) return;
            this.sessionId = payload.ownership.sessionId;
            this.serverGeneration=payload.ownership.generation;
            try{this.storage?.setItem('livezone.preview-ownership.v2',JSON.stringify({sessionId:this.sessionId,generation:this.serverGeneration,resumeToken:payload.ownership.resumeToken}));}catch{}
            this.sequence = 0;
            await this.report();
        } catch { this.available = false; }
        if (generation === this.generation && !this.stopped) this.timer = setTimeout(() => {
            if (!this.sessionId) void this.start(); else void this.heartbeat();
        }, this.intervalMs);
    }
    async heartbeat() {
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
                this.sessionId = null;
            }
        } catch { if (generation === this.generation && sequence === this.sequence) this.available = false; }
    }
    stop({confirmedGone=false}={}) {
        this.stopped = true; ++this.generation; clearTimeout(this.timer);
        const id = this.sessionId||this.lastSessionId;this.lastSessionId=id; this.sessionId = null;
        const lifecycle=this.generation;
        if(id&&confirmedGone)void this.fetcher('/api/media-library/preview-ownership/'+id,{method:'DELETE',keepalive:true,
            headers:{'X-Livezone-Ownership-Generation':String(this.serverGeneration||1)}}).then(response=>{
                if(response.ok&&this.generation===lifecycle&&this.stopped){try{this.storage?.removeItem('livezone.preview-ownership.v2');this.lastSessionId=null;}catch{}}
            }).catch(()=>{});
        else if(id)void this.fetcher('/api/media-library/preview-ownership/'+id,{method:'PUT',keepalive:true,
            headers:{'Content-Type':'application/json'},body:JSON.stringify({sequence:++this.sequence,generation:this.serverGeneration||1,assets:[],complete:false})}).catch(()=>{});
    }
}
