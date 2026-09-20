import {operatorFetch} from '../auth/OperatorSessionClient.js';
const URL='/api/studio/execution-ownership';
export function secureDocumentId(crypto=globalThis.crypto){
 if(typeof crypto?.randomUUID==='function')return crypto.randomUUID();
 if(typeof crypto?.getRandomValues!=='function')return null;
 const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
// Only execution startup is isolated. Configuration clients keep their own authority.
export async function startBrowserExecutionOwnership(options={}){
 let client;
 try{client=new BrowserExecutionOwnershipClient(options);await client.start();return client;}
 catch(error){
  if(client){client.closed=true;++client.sequence;client.grant=null;client.listeners.clear();
   globalThis.clearTimeout(client.expiryTimer);globalThis.clearTimeout(client.renewTimer);}
  const passive=new BrowserExecutionOwnershipClient({...options,uuid:()=>null});
  passive.state={state:'NO_OWNER',reason:'OWNERSHIP_STARTUP_FAILED',errorName:error?.name||'Error'};
  return passive;
 }
}
// A document's lease is never saved in local/session storage or transferred to another tab.
export default class BrowserExecutionOwnershipClient {
 constructor({request=operatorFetch,clock=()=>performance.now(),setTimer=(fn,ms)=>globalThis.setTimeout(fn,ms),clearTimer=id=>globalThis.clearTimeout(id),uuid=secureDocumentId}={}){
  Object.assign(this,{request,clock,setTimer,clearTimer,uuid});this.ownerInstanceId=uuid();this.publisherSessionId=uuid();this.listeners=new Set();this.grant=null;this.state={state:'NO_OWNER',reason:'INITIALIZING'};this.sequence=0;
 }
 valid(grant=this.grant){return !this.closed&&grant&&grant.leaseId===this.grant?.leaseId&&this.clock()<this.deadline;}
 subscribe(fn){this.listeners.add(fn);fn(this);return()=>this.listeners.delete(fn);}
 emit(){for(const fn of this.listeners)fn(this);}
 async start(){this.closed=false;
  if(!this.ownerInstanceId||!this.publisherSessionId){this.state={state:'NO_OWNER',reason:'SECURE_IDENTITY_UNAVAILABLE'};this.emit();return false;}
  await this.exchange('acquire');return this.valid();}
 trustsDurable(candidate){
  const b=this.durableBinding,g=this.grant;
  return Boolean(this.valid()&&b?.version===1&&Number.isSafeInteger(b.generation)&&b.generation>0&&
   b.authorityEpoch===g.authorityEpoch&&b.authorityProcessSession===g.authorityProcessSession&&
   b.publisherSessionId===candidate?.publisherSessionId&&b.revision===candidate?.revision&&
   JSON.stringify(candidate)===JSON.stringify(this.retainedProgram));
 }
 async reconcileRequest(operation,prepared){
  if(this.closed)return {error:'CLIENT_CLOSED'};
  const sequence=++this.sequence,start=this.clock();
  this.clearTimer(this.renewTimer);
  let body;
  try{
   const response=await this.request(URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,
    ownerInstanceId:this.ownerInstanceId,publisherSessionId:this.publisherSessionId,
    ...(prepared?{reconciliationId:prepared.reconciliationId,expected:prepared.expected}:{})})});
   body=await response.json();
   if(this.closed||sequence!==this.sequence)return {error:'STALE_RESPONSE'};
   if(body.state)this.state=body.state;
   if(response.ok&&body.grant){
    this.state=body.state;this.grant=body.grant;this.retainedProgram=body.retainedProgram;this.durableBinding=body.durableBinding??null;
    this.deadline=start+Math.max(0,body.leaseRemainingMs||0);
    if(!this.valid()){this.lose('LEASE_EXPIRED');return {error:'LEASE_EXPIRED'};}
    this.everOwned=true;
    this.expiryTimer=this.setTimer(()=>this.lose('LEASE_EXPIRED'),Math.max(0,this.deadline-this.clock()));
    this.renewTimer=this.setTimer(()=>void this.exchange('renew'),Math.max(100,Math.min(3000,(this.deadline-this.clock())/3)));
   }
  }catch{body={error:'RECONCILIATION_REQUEST_FAILED'};}
  if(this.closed||sequence!==this.sequence)return {error:'STALE_RESPONSE'};
  this.reconciliation={reconciliationId:body.reconciliationId??prepared?.reconciliationId,expected:body.expected??prepared?.expected,current:body.current,error:body.error,
   result:body.grant?'BROWSER_OWNER':null};this.emit();return body;
 }
 async exchange(operation){
  const sequence=++this.sequence,start=this.clock(),previous=this.grant;
  try{
   const response=await this.request(URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(operation==='acquire'?{operation,ownerInstanceId:this.ownerInstanceId,publisherSessionId:this.publisherSessionId}:{operation,grant:previous})});
   const body=await response.json();if(this.closed||sequence!==this.sequence)return;
   this.state=body.state||{state:'NO_OWNER',reason:'AUTHORITY_UNAVAILABLE'};
   this.grant=response.ok?body.grant:null;
   this.retainedProgram=body.retainedProgram??null;this.durableBinding=body.durableBinding??null;this.deadline=start+Math.max(0,body.leaseRemainingMs||0);
   if(!this.valid())this.grant=null;
  }catch{if(sequence!==this.sequence||this.closed)return;this.grant=this.valid(previous)?previous:null;this.state={...this.state,state:this.grant?'BROWSER_OWNER':'NO_OWNER',reason:'AUTHORITY_UNAVAILABLE'};}
  this.clearTimer(this.expiryTimer);this.clearTimer(this.renewTimer);
  if(this.grant){this.everOwned=true;this.expiryTimer=this.setTimer(()=>this.lose('LEASE_EXPIRED'),Math.max(0,this.deadline-this.clock()));
   this.renewTimer=this.setTimer(()=>void this.exchange('renew'),Math.max(100,Math.min(3000,(this.deadline-this.clock())/3)));}
  // A denied new document may wait for clean close/expiry. A retired document must be explicitly reloaded.
  else if(!this.everOwned&&this.state.reason!=='OWNER_RETIRED')this.renewTimer=this.setTimer(()=>void this.exchange('acquire'),3000);
  this.emit();
 }
 lose(reason){++this.sequence;this.grant=null;this.state={...this.state,state:'NO_OWNER',ownerKind:null,reason};this.clearTimer(this.expiryTimer);this.clearTimer(this.renewTimer);this.emit();}
 async publish(url,options,context){
  if(context?.manual)return this.request(url,{...options,headers:{...options.headers,'X-Livezone-Program-Manual':'1'}});
  if(!context?.grant||!this.valid(context.grant))return {ok:false,status:409,json:async()=>({error:'execution-owner-required'})};
  const response=await this.request(url,{...options,headers:{...options.headers,'X-Livezone-Execution-Grant':JSON.stringify(context.grant)}});
  if(response.status===409){const body=await response.clone().json().catch(()=>null);if(body?.error==='execution-owner-required')this.lose('OWNER_REJECTED');}
  return response;
 }
 capture(manual=false){return manual?{manual:true}:{grant:this.valid()?{...this.grant}:null};}
 close(){if(this.closed)return;const grant=this.grant;this.closed=true;++this.sequence;this.grant=null;this.clearTimer(this.expiryTimer);this.clearTimer(this.renewTimer);this.listeners.clear();
  if(grant)void this.request(URL,{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'release',grant})}).catch(()=>{});
 }
}
