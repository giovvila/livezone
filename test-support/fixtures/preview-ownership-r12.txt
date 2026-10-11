import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { referenceError } from './AssetReferenceInventory.js';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';

export default class PreviewOwnership {
    constructor({ coordinator, validate, clock = () => Date.now(), leaseMs = 30000, maxSessions = 64, path, diagnostics }) {
        Object.assign(this, { coordinator, validate, clock, leaseMs, maxSessions, path, diagnostics });
        this.sessions = new Map();
        this.available = true;
        this.ready=this.initialize();
    }
    async initialize() {
        if(!this.path)return;
        try {
            const data=JSON.parse(await readFile(this.path,'utf8'));
            if(data.version!==2||!Array.isArray(data.sessions)||data.sessions.length>this.maxSessions)throw Error();
            for(const [id,session] of data.sessions){
                if(!/^[0-9a-f-]{36}$/.test(id)||!Number.isSafeInteger(session.generation)||typeof session.principal!=='string'||
                    session.generation<1||this.sessions.has(id)||!/^[0-9a-f]{64}$/.test(session.resumeHash)||
                    !Number.isSafeInteger(session.sequence)||session.sequence<0||!Number.isFinite(session.expiresAt)||
                    !Array.isArray(session.references)||session.references.length>64||
                    session.references.some(value=>!value||typeof value.assetId!=='string'||value.kind!=='PREVIEW'||value.ownerId!==id))throw Error();
                this.sessions.set(id,{...session,confirmed:false});
            }
        }catch(error){if(error.code!=='ENOENT')this.available=false;}
    }
    async persist(){
        if(!this.path)return;
        await mkdir(dirname(this.path),{recursive:true});
        await writeFile(this.path+'.tmp',JSON.stringify({version:2,sessions:[...this.sessions]}));
        await rename(this.path+'.tmp',this.path);
    }
    mutate(operation){return this.coordinator.run(async()=>{
        await this.ready;
        if(!this.available)throw referenceError('REFERENCE_AUDIT_UNAVAILABLE');
        const before=structuredClone(this.sessions);let result;
        try{result=await operation();}catch(error){this.sessions=before;throw error;}
        try{await this.persist();}catch(error){this.sessions=before;this.available=false;throw error;}
        return result;
    });}
    open(principal,{resumeSessionId,generation,resumeToken}={}) {
        return this.mutate(() => {
            this.expire();
            const previous=resumeSessionId&&this.sessions.get(resumeSessionId);
            if(previous){
                if(previous.generation!==generation||typeof resumeToken!=='string'||createHash('sha256').update(resumeToken).digest('hex')!==previous.resumeHash)throw referenceError('OWNERSHIP_STALE_UPDATE');
                previous.principal=principal;
                previous.generation++;previous.sequence=0;previous.confirmed=false;previous.expiresAt=this.clock()+this.leaseMs;
                return {sessionId:resumeSessionId,generation:previous.generation,resumeToken,sequence:0,leaseMs:this.leaseMs};
            }
            if (resumeSessionId)throw referenceError('OWNERSHIP_SESSION_EXPIRED');
            if (this.sessions.size >= this.maxSessions) throw referenceError('REFERENCE_AUDIT_UNAVAILABLE');
            const sessionId = randomUUID();
            const token=randomBytes(32).toString('hex');
            this.sessions.set(sessionId, { principal, resumeHash:createHash('sha256').update(token).digest('hex'),generation:1, sequence: 0, confirmed: false,
                expiresAt: this.clock() + this.leaseMs, references: [] });
            return { sessionId, generation:1,resumeToken:token, sequence: 0, leaseMs: this.leaseMs };
        });
    }
    update(sessionId, principal, { sequence, assets, ownerLabel = 'Preview', complete = true, generation=1 } = {}) {
        // Capture the caller's payload before waiting for other mutations.
        const input = structuredClone({ sequence, assets, ownerLabel, complete, generation });
        return this.mutate(() => {
            this.expire();
            const session = this.sessions.get(sessionId);
            if (!this.available || !session || session.principal !== principal) throw referenceError('OWNERSHIP_SESSION_EXPIRED');
            if(session.generation!==input.generation)throw referenceError('OWNERSHIP_STALE_UPDATE');
            if (!Number.isSafeInteger(input.sequence) || input.sequence <= session.sequence) throw referenceError('OWNERSHIP_STALE_UPDATE');
            if (!Array.isArray(input.assets) || input.assets.length > 64 || input.assets.some(id => typeof id !== 'string') ||
                typeof input.ownerLabel !== 'string' || input.ownerLabel.length > 120 || typeof input.complete !== 'boolean') throw referenceError('INVALID_OWNERSHIP');
            if (!input.complete) {
                session.sequence = input.sequence; session.confirmed = false;
                session.expiresAt = this.clock() + this.leaseMs;
                this.diagnostics?.record('PREVIEW_OWNERSHIP_UNCERTAIN');
                return { sequence: session.sequence, expiresAt: session.expiresAt, complete: false };
            }
            this.validate(input.assets.map(assetId => ({ assetId })));
            session.references = [...new Set(input.assets)].map(assetId => ({ assetId, classification: 'RUNTIME',
                kind: 'PREVIEW', ownerId: sessionId, ownerLabel: input.ownerLabel, location: 'preview' }));
            session.sequence = input.sequence;
            session.confirmed = true;
            session.expiresAt = this.clock() + this.leaseMs;
            this.diagnostics?.record('PREVIEW_OWNERSHIP_ACTIVE',{count:session.references.length,complete:true});
            return { sequence: session.sequence, expiresAt: session.expiresAt, complete: true };
        });
    }
    close(sessionId, principal, generation=1) {
        return this.mutate(() => {
            const session=this.sessions.get(sessionId);
            if(session?.principal===principal&&session.generation===generation){this.sessions.delete(sessionId);
                this.diagnostics?.record('PREVIEW_OWNERSHIP_RELEASED',{complete:true});}
        });
    }
    expire() { for (const value of this.sessions.values()) if (value.expiresAt <= this.clock()&&value.confirmed) {
        value.confirmed=false;this.diagnostics?.record('PREVIEW_OWNERSHIP_UNCERTAIN',{count:value.references.length});
    } }
    disconnect(principal){return this.coordinator.run(async()=>{
        await this.ready;
        for(const session of this.sessions.values())if(session.principal===principal)session.confirmed=false;
    });}
    revokePrincipal(principal){return this.mutate(()=>{
        for(const [id,session] of this.sessions)if(session.principal===principal||session.principal.startsWith(principal+'|')){
            this.sessions.delete(id);this.diagnostics?.record('PREVIEW_OWNERSHIP_RELEASED',{complete:true});
        }
    });}
    snapshot() {
        this.expire();
        const sessions=[...this.sessions.values()];
        const required=this.requiredPrincipals?.()||[];
        return { complete: this.available && sessions.every(s => s.confirmed)&&required.every(principal=>sessions.some(s=>s.principal===principal&&s.confirmed)),
            references: [...this.sessions.values()].flatMap(s => s.references) };
    }
}
