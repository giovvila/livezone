import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {referenceError} from './AssetReferenceInventory.js';

const CAPABILITIES=['canonical-catalog','preview-ownership-v2','asset-validation'];
export default class ReferenceClientRegistry {
    constructor({coordinator,path,diagnostics,clock=()=>Date.now(),coverageProven=false,minimumVersion=2,requireEpoch=false,isSessionRevoked}={}) {
        Object.assign(this,{coordinator,path,diagnostics,clock,coverageProven,minimumVersion,requireEpoch,isSessionRevoked});
        this.handshaken=new Set();this.epochConfirmed=false;
        this.clients=new Map();this.available=true;this.ready=this.initialize();
    }
    async initialize() {
        if(!this.path)return;
        try {
            const data=JSON.parse(await readFile(this.path,'utf8'));
            if(data.version!==1||!Array.isArray(data.clients)||data.clients.length>128)throw Error();
            for(const client of data.clients){
                if(!/^[0-9a-f-]{36}$/.test(client.id)||!Number.isSafeInteger(client.generation)||
                    client.generation<1||this.clients.has(client.id)||typeof client.principal!=='string'||
                    !/^[0-9a-f]{64}$/.test(client.resumeHash)||typeof client.active!=='boolean'||typeof client.supported!=='boolean'||
                    !['CONTROL','SCHEDULER','OBSOLETE'].includes(client.role)||!['PENDING','RECONCILED','CONFLICT','INVALID'].includes(client.catalog)||
                    !['PENDING','RECONCILED','INVALID'].includes(client.legacyStatus)||
                    !Array.isArray(client.legacyAssets)||client.legacyAssets.length>500||
                    (client.pendingLegacyAssets!==undefined&&(!Array.isArray(client.pendingLegacyAssets)||client.pendingLegacyAssets.length>500))||
                    [...client.legacyAssets,...client.pendingLegacyAssets||[]].some(value=>!value||typeof value.assetId!=='string'||!['video','image','audio'].includes(value.kind)))throw Error();
                const restored={...client,supported:client.supported&&(!this.requireEpoch||client.version===this.minimumVersion),active:client.active===true,confirmed:false};
                // D2 request-only markers predate the explicit observation field.
                if(client.version===undefined&&client.role==='OBSOLETE'&&client.catalog==='PENDING'&&client.legacyStatus==='PENDING'&&
                    !client.legacyAssets.length&&!client.pendingLegacyAssets?.length)restored.observationOnly=true;
                if(restored.observationOnly&&restored.catalog==='PENDING'&&restored.legacyStatus==='PENDING'&&!restored.legacyAssets.length&&!restored.pendingLegacyAssets?.length&&
                    this.isSessionRevoked?.(restored.principal)===true){restored.active=false;restored.termination='SESSION_REVOKED';restored.catalog='RECONCILED';restored.legacyStatus='RECONCILED';}
                this.clients.set(client.id,restored);
            }
        } catch(error){if(error.code!=='ENOENT')this.available=false;}
    }
    async persist(){
        if(!this.path)return;
        await mkdir(dirname(this.path),{recursive:true});
        const temp=this.path+'.tmp';
        await writeFile(temp,JSON.stringify({version:1,clients:[...this.clients.values()]}));
        await rename(temp,this.path);
    }
    mutate(operation){return this.coordinator.run(async()=>{
        await this.ready;if(!this.available)throw referenceError('REFERENCE_AUDIT_UNAVAILABLE');
        const before=structuredClone(this.clients);
        let result;try{result=await operation();}catch(error){this.clients=before;throw error;}
        try{await this.persist();}catch(error){this.clients=before;this.available=false;throw error;}
        return result;
    });}
    register({role,version,capabilities=[],resumeId,resumeGeneration,resumeToken}={},principal='operator',{observationOnly=false}={}) {
        return this.mutate(()=>{
            const supported=version===this.minimumVersion&&['CONTROL','SCHEDULER'].includes(role)&&Array.isArray(capabilities)&&capabilities.length<=16&&CAPABILITIES.every(cap=>capabilities.includes(cap))&&
                (this.minimumVersion<3||capabilities.includes('channel-logo-authority-v1'));
            const prior=resumeId&&this.clients.get(resumeId);
            if(prior&&(prior.generation!==resumeGeneration||typeof resumeToken!=='string'||createHash('sha256').update(resumeToken).digest('hex')!==prior.resumeHash))throw referenceError('CLIENT_GENERATION_CONFLICT');
            if(!prior&&this.clients.size>=128)throw referenceError('REFERENCE_AUDIT_UNAVAILABLE');
            const id=prior?.id||randomUUID(),generation=(prior?.generation||0)+1;
            const token=prior?resumeToken:randomBytes(32).toString('hex');
            const client={...prior,id,generation,principal,version,resumeHash:createHash('sha256').update(token).digest('hex'),role:supported?role:'OBSOLETE',supported,catalog:prior?.catalog||'PENDING',legacyStatus:prior?.legacyStatus||'PENDING',legacyAssets:prior?.legacyAssets||[],
                observationOnly,active:true,confirmed:supported,lastSeen:this.clock()};
            if(this.requireEpoch){client.catalog='PENDING';client.legacyStatus='PENDING';}
            this.clients.set(id,client);this.diagnostics?.record('CLIENT_CAPABILITY',{complete:supported});
            if(supported){this.handshaken.add(id+':'+generation);this.epochConfirmed=true;}
            return {clientId:id,generation,supported,resumeToken:token};
        });
    }
    update(id,generation,{catalog,closed=false}={},principal='operator') {
        return this.mutate(()=>{
            const client=this.clients.get(id);
            if(!client||client.generation!==generation||client.principal!==principal)throw referenceError('CLIENT_GENERATION_CONFLICT');
            if(catalog&&!['PENDING','RECONCILED','CONFLICT','INVALID'].includes(catalog))throw referenceError('INVALID_CLIENT_STATE');
            if(catalog)client.catalog=catalog;
            client.active=!closed;client.confirmed=client.supported;client.termination=closed?'EXPLICIT_CLOSE':null;client.lastSeen=this.clock();
            return {clientId:id,generation};
        });
    }
    pendingCatalog(id,generation,revision,principal){return this.mutate(()=>{
        const client=this.identify(id,generation,principal);if(!client)throw referenceError('CLIENT_GENERATION_CONFLICT');
        client.catalog='PENDING';client.pendingRevision=revision;
    });}
    confirmCatalog(id,generation,revision,principal){return this.mutate(()=>{
        const client=this.identify(id,generation,principal);
        if(!client||client.pendingRevision!==revision||this.currentCatalogRevision?.()!==revision)throw referenceError('CLIENT_GENERATION_CONFLICT');
        client.catalog='RECONCILED';delete client.pendingRevision;
    });}
    isHistoricalNonwriter(client){
        // Positive credential invalidation, never network silence. Current clients
        // commit persisted references through the server; retained aliases and
        // runtime ownership are still inventoried independently of this census.
        return this.coverageProven && client.supported && client.version===this.minimumVersion &&
            this.minimumVersion>=3 && this.isSessionRevoked?.(client.principal)===true;
    }
    snapshot(){
        const reasons=[];
        if(!this.available)reasons.push('CLIENT_REGISTRY_UNAVAILABLE');
        if(!this.coverageProven)reasons.push('LEGACY_CLIENT_CENSUS_UNPROVEN');
        if(this.requireEpoch&&!this.epochConfirmed)reasons.push('CLIENT_CENSUS_RECONNECT_REQUIRED');
        if(this.authenticatedPrincipals)for(const principal of this.authenticatedPrincipals()){
            if(![...this.clients.values()].some(client=>client.principal===principal&&(client.active||client.termination==='EXPLICIT_CLOSE')&&client.supported&&client.confirmed))reasons.push('AUTHENTICATED_CLIENT_UNCONFIRMED');
        }
        for(const client of this.clients.values()) {
            if(this.isHistoricalNonwriter(client))continue;
            if(client.catalog!=='RECONCILED')reasons.push('LEGACY_CATALOG_'+client.catalog);
            if(client.legacyStatus!=='RECONCILED')reasons.push('LEGACY_ALIASES_UNCONFIRMED');
            if(client.active&&(!client.supported||!client.confirmed||this.requireEpoch&&!this.handshaken.has(client.id+':'+client.generation)))reasons.push('CLIENT_CAPABILITY_UNKNOWN');
        }
        return {state:reasons.length?'INCOMPLETE':'COMPLETE',reasons:[...new Set(reasons)],clientCount:this.clients.size,
            clients:[...this.clients.values()].map(client=>({role:client.role,state:this.isHistoricalNonwriter(client)?'HISTORICAL / NON-AUTHORITATIVE':!client.active?'DISCONNECTED':client.supported&&client.confirmed?'CURRENT_CAPABLE':'LEGACY/UNKNOWN'}))};
    }
    identify(id,generation,principal){const client=this.clients.get(id);return client&&client.generation===generation&&client.principal===principal?client:null;}
    updateLegacy(id,generation,{assets,complete},principal){return this.mutate(()=>{
        const client=this.identify(id,generation,principal);if(!client)throw referenceError('CLIENT_GENERATION_CONFLICT');
        if(!Array.isArray(assets)||assets.length>500||typeof complete!=='boolean')throw referenceError('INVALID_CLIENT_STATE');
        const values=assets.map(value=>{if(!value||typeof value.assetId!=='string'||!['video','image','audio'].includes(value.kind))throw referenceError('INVALID_CLIENT_STATE');return {assetId:value.assetId,kind:value.kind};});
        this.validateLegacy?.(values);
        if(complete){client.pendingLegacyAssets=values;client.legacyRevision=(client.legacyRevision||0)+1;}
        client.legacyStatus=complete?'PENDING':'INVALID';return {complete,revision:client.legacyRevision};
    });}
    confirmLegacy(id,generation,revision,principal){return this.mutate(()=>{
        const client=this.identify(id,generation,principal);if(!client||client.legacyRevision!==revision||!client.pendingLegacyAssets)throw referenceError('CLIENT_GENERATION_CONFLICT');
        client.legacyAssets=client.pendingLegacyAssets;delete client.pendingLegacyAssets;client.legacyStatus='RECONCILED';
    });}
    legacyReferences(){return [...this.clients.values()].flatMap(client=>[...client.legacyAssets||[],...client.pendingLegacyAssets||[]]);}
    observeObsolete(principal){
        if([...this.clients.values()].some(client=>client.principal===principal&&client.role==='OBSOLETE'))return Promise.resolve();
        return this.register({role:'OBSOLETE',version:0},principal,{observationOnly:true});
    }
    presence(id,generation,principal,connected){return this.coordinator.run(async()=>{
        await this.ready;
        const client=this.identify(id,generation,principal);
        if(!client?.active||!this.handshaken.has(id+':'+generation))throw referenceError('CLIENT_CAPABILITY_REQUIRED');
        client.confirmed=connected&&client.supported;
    });}
    revokePrincipal(principal){return this.mutate(()=>{
        for(const client of this.clients.values())if(client.principal===principal){
            client.active=false;client.confirmed=false;client.termination='SESSION_REVOKED';
            // A request-only presence marker has no submitted catalog. Positive auth
            // revocation ends that unknown participation; actual conflicts/references survive.
            if(client.observationOnly&&client.catalog==='PENDING'&&client.legacyStatus==='PENDING'&&
                !client.legacyAssets.length&&!client.pendingLegacyAssets?.length){client.catalog='RECONCILED';client.legacyStatus='RECONCILED';}
        }
        // Revocation terminates runtime participation, never erases unresolved catalogs.
    });}
}
