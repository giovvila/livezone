import assert from 'node:assert/strict';
import {join} from 'node:path';
import {referenceReadFixture,observer} from './ReferenceReadFixture.js';
const {default:Preview}=await import('../server/media-library/PreviewOwnership.js');
const {default:Inventory}=await import('../server/media-library/AssetReferenceInventory.js');
export async function previewReadFixture(t,options={}){
 const h=await referenceReadFixture(t,options),client=await h.register();let now=1000,clockCalls=0;
 const preview=new Preview({coordinator:h.coordinator,validate:()=>{},clock:()=>{clockCalls++;return now;},leaseMs:1000,path:join(h.root,'preview.json')});
 await preview.ready;
 const principal=h.principal+'|'+client.clientId+'|'+client.generation;
 const asset={id:'asset-12345678-1234-4123-8123-123456789012',kind:'image',url:'/media-library/files/image/fixture.png'};
 const inventory=new Inventory({repository:{list:()=>[asset],get:id=>id===asset.id?asset:null,deleteRecoveryRequired:false},inventories:async()=>[{name:'fixture canonical inventory',complete:true,data:{}}],preview,completeness:()=>({state:'COMPLETE',reasons:[]})});
 h.mediaRoutes.previewOwnership=preview;h.mediaRoutes.referenceAudit=inventory;
 h.mediaRoutes.repository={list:()=>[asset],get:id=>id===asset.id?asset:null};
 const originalObserve=h.observe.bind(h);
 Object.assign(h,{preview,inventory,asset,client,principal,lease:null,setTime:value=>now=value,
  async open(){this.lease=await preview.open(principal);return this.lease;},
  async confirm(assets=[]){return preview.update(this.lease.sessionId,principal,{sequence:1,assets,generation:this.lease.generation,complete:true});},
  getInventory:()=>h.request('GET','/api/media-library/reference-inventory',{headers:h.headers(client)}),
  async observe(fn){const before=structuredClone([...preview.sessions]),available=preview.available;let calls=0;const restore=[];
   for(const name of ['expire','mutate','persist','open','update','close','disconnect','revokePrincipal']){const original=preview[name];preview[name]=function(...args){calls++;return original.apply(this,args);};restore.push(()=>preview[name]=original);}
   let result;try{result=await originalObserve(fn);}finally{restore.forEach(fn=>fn());}
   assert.equal(calls,0);assert.deepEqual([...preview.sessions],before);assert.equal(preview.available,available);return result;
  }
 });Object.defineProperty(h,'clockCalls',{get:()=>clockCalls});return h;
}
export {observer};
