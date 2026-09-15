import {operatorFetch} from '../auth/OperatorSessionClient.js';

export default class ChannelLogoReferenceClient {
    constructor({request=operatorFetch}={}){this.request=request;this.queue=Promise.resolve();this.revisions={};this.ready=false;}
    async call(consumer,method,body){
        const response=await this.request('/api/media-library/channel-logo/'+consumer,{method,headers:{'Content-Type':'application/json'},
            ...(body===undefined?{}:{body:JSON.stringify(body)})});const payload=await response.json();
        if(!response.ok||!payload.ok)throw Object.assign(Error('ASSET NON DISPONIBILE'),{code:payload.error?.code});return payload.logo;
    }
    async initialize(states){try{
        for(const consumer of ['preview','program']){
            const old=await this.call(consumer,'GET');this.revisions[consumer]=old.revision;
            const value=await this.call(consumer,'PUT',{revision:old.revision,asset:states[consumer]});this.revisions[consumer]=value.revision;
            await this.call(consumer,'POST',{revision:value.revision});
        }
        this.ready=true;
    }catch{this.ready=false;}return this.ready;}
    execute(consumer,asset,apply){
        const operation=async()=>{
            if(!this.ready)throw Error('REFERENCE INVENTORY INCOMPLETE');
            const value=await this.call(consumer,'PUT',{revision:this.revisions[consumer],asset});this.revisions[consumer]=value.revision;
            // Server retains both assignments until local application is acknowledged.
            apply();await this.call(consumer,'POST',{revision:value.revision});return true;
        };
        const result=this.queue.then(operation).catch(error=>{this.ready=false;throw error;});this.queue=result.catch(()=>{});return result;
    }
}
