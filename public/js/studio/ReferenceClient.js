import {operatorFetch,setReferenceClientHeaders,referenceEventUrl} from '../auth/OperatorSessionClient.js';
import {notifyReferenceAuthorityChanged} from '../media-library/ReferenceAuthorityNotifications.js';
const KEY='livezone.asset-reference.client.v2';
export default class ReferenceClient {
    constructor({role,request=operatorFetch,storage,eventSourceFactory=globalThis.EventSource?url=>new EventSource(url):null}={}){Object.assign(this,{role,request,storage,eventSourceFactory});if(storage===undefined){try{this.storage=globalThis.sessionStorage;}catch{this.storage=null;}}}
    async initialize(){
        let resume;try{resume=JSON.parse(this.storage?.getItem(KEY)||'null');}catch{}
        const response=await this.request('/api/media-library/reference-clients',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({role:this.role,version:3,capabilities:['canonical-catalog','preview-ownership-v2','asset-validation','channel-logo-authority-v1'],resumeId:resume?.clientId,resumeGeneration:resume?.generation,resumeToken:resume?.resumeToken})});
        const payload=await response.json();if(!response.ok||!payload.ok)throw Error('REFERENCE INVENTORY INCOMPLETE');
        this.identity=payload.client;setReferenceClientHeaders(this.identity);
        try{this.storage?.setItem(KEY,JSON.stringify(this.identity));}catch{}
        if(this.eventSourceFactory){this.presence?.close();this.presence=this.eventSourceFactory(referenceEventUrl('/api/media-library/reference-presence'));
            this.presence.addEventListener('presence',notifyReferenceAuthorityChanged);this.presence.addEventListener('error',notifyReferenceAuthorityChanged);}
        return this.identity;
    }
    async reportInvalid(){return this.update({catalog:'INVALID'});}
    async update(body){
        if(!this.identity)return;
        const response=await this.request('/api/media-library/reference-clients/'+this.identity.clientId,{method:'PUT',
            headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,generation:this.identity.generation}),keepalive:body.closed===true});
        if(!response.ok)throw Error('REFERENCE INVENTORY INCOMPLETE');return response.json();
    }
    close(){this.presence?.close();return this.update({closed:true});}
    confirmCatalog(revision){return this.update({appliedRevision:revision});}
    confirmLegacy(revision){return this.update({legacyAppliedRevision:revision});}
    async updateLegacy(value){
        if(!this.identity)throw Error('REFERENCE INVENTORY INCOMPLETE');
        const response=await this.request('/api/media-library/reference-clients/'+this.identity.clientId+'/legacy-assets',{
            method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...value,generation:this.identity.generation})});
        const payload=await response.json();if(!response.ok||!payload.ok)throw Object.assign(Error('ASSET NON DISPONIBILE'),{code:payload.error?.code});return payload;
    }
}
