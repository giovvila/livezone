import {randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {acquireMaintenanceGate} from './AuthorityMaintenanceGate.js';
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(value);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
// Single-host fail-closed lock. Never break an existing lock based on PID/age.
// After an unclean process exit an operator must reconcile the abandoned lock.
export default class BrowserExecutionOwnership {
 constructor({path,clock=()=>Date.now(),leaseMs=15000}){
  Object.assign(this,{path,clock,leaseMs});this.authorityProcessSession=randomUUID();this.authorityEpoch=0;this.grantRevision=0;this.grant=null;this.retiredInstances=new Set();this.reason='INITIALIZING';this.ready=this.initialize();
 }
 async initialize(){
  let releaseGate;
  try{
   await mkdir(dirname(this.path),{recursive:true});releaseGate=await acquireMaintenanceGate(this.path);this.lock=await open(this.path+'.lock','wx');
   await this.lock.writeFile(JSON.stringify({pid:process.pid,authorityProcessSession:this.authorityProcessSession}));await this.lock.sync();
   let epoch=0;try{epoch=JSON.parse(await readFile(this.path,'utf8')).epoch;if(!Number.isSafeInteger(epoch)||epoch<0)throw Error('INVALID_EPOCH');}catch(e){if(e.code!=='ENOENT')throw e;}
   if(!Number.isSafeInteger(epoch+1))throw Error('INVALID_EPOCH');
   const temp=this.path+'.'+this.authorityProcessSession+'.tmp';const file=await open(temp,'wx');
   try{await file.writeFile(JSON.stringify({epoch:epoch+1}));await file.sync();}finally{await file.close();}
   await rename(temp,this.path);this.authorityEpoch=epoch+1;this.available=true;this.restartBlocked=epoch>0;this.reason=this.restartBlocked?'RESTART_RECONCILIATION_REQUIRED':'NO_OWNER';
  }catch(error){this.available=false;this.reason='AUTHORITY_UNAVAILABLE';this.initializationError=error.code||error.message;}
  finally{if(releaseGate)try{await releaseGate();}catch(error){this.available=false;this.reason='AUTHORITY_UNAVAILABLE';this.initializationError=error.code||error.message;}}
 }
 expire(){if(this.grant&&this.clock()>=this.grant.expiresAt){this.retiredInstances.add(this.grant.ownerInstanceId);this.grant=null;this.principal=null;this.reason='LEASE_EXPIRED';++this.grantRevision;}}
 snapshot(){this.expire();return {available:this.available===true,state:this.grant?'BROWSER_OWNER':'NO_OWNER',ownerKind:this.grant?'BROWSER':null,ownerInstanceId:this.grant?.ownerInstanceId??null,authorityEpoch:this.authorityEpoch,authorityProcessSession:this.authorityProcessSession,grantRevision:this.grantRevision,expiresAt:this.grant?.expiresAt??null,reason:this.reason,manualSuppressed:this.manualSuppressed===true,executionAllowed:false,serverTake:false};}
 matches(candidate,principal,publisherSessionId=candidate?.publisherSessionId){
  this.expire();const g=this.grant;
  return this.available===true&&!this.closed&&g&&principal===this.principal&&candidate&&
   ['authorityEpoch','authorityProcessSession','ownerInstanceId','publisherSessionId','grantRevision','ownerKind'].every(k=>candidate[k]===g[k])&&
   same(candidate.leaseId,g.leaseId)&&publisherSessionId===g.publisherSessionId;
 }
 async operate(value,principal){await this.ready;this.expire();let grant=null;
  if(!this.available||this.closed)return {state:this.snapshot(),grant,leaseRemainingMs:grant?Math.max(0,grant.expiresAt-this.clock()):0};
  if(value.operation==='acquire'){
   if(!validId(value.ownerInstanceId)||!validId(value.publisherSessionId))throw Error('INVALID_OWNER');
   if(this.retiredInstances.has(value.ownerInstanceId)||this.retiredInstances.size>=4096){this.reason='OWNER_RETIRED';return {state:this.snapshot(),grant:null};}
   if(!this.grant&&!this.restartBlocked&&!this.manualSuppressed){this.principal=principal;this.grant={authorityEpoch:this.authorityEpoch,authorityProcessSession:this.authorityProcessSession,ownerKind:'BROWSER',ownerInstanceId:value.ownerInstanceId,publisherSessionId:value.publisherSessionId,grantRevision:++this.grantRevision,leaseId:randomUUID(),expiresAt:this.clock()+this.leaseMs};this.reason='GRANTED';grant={...this.grant};}
   // Knowing an instance ID never retrieves its secret or extends its lease.
   if(!grant&&this.grant)return {state:{...this.snapshot(),reason:'OWNER_HELD'},grant:null};
  }else if(value.operation==='renew'&&this.matches(value.grant,principal)){
   this.grant.expiresAt=this.clock()+this.leaseMs;this.reason='RENEWED';grant={...this.grant};
  }else if(value.operation==='release'&&this.matches(value.grant,principal)){
   this.retiredInstances.add(this.grant.ownerInstanceId);this.grant=null;this.principal=null;++this.grantRevision;this.reason='RELEASED';
  }else if(value.operation!=='inspect')this.reason='STALE_GRANT';
  return {state:this.snapshot(),grant,leaseRemainingMs:grant?Math.max(0,grant.expiresAt-this.clock()):0};
 }
 configurationChanged(){this.manualSuppressed=false;}
 revokeForManual(publisherSessionId){this.restartBlocked=false;if(!this.grant||this.grant.publisherSessionId!==publisherSessionId){this.manualSuppressed=true;if(this.grant)this.retiredInstances.add(this.grant.ownerInstanceId);this.grant=null;this.principal=null;++this.grantRevision;this.reason='MANUAL_OVERRIDE';}}
 async close(){if(this.closing)return this.closing;this.closed=true;this.closing=(async()=>{await this.ready;this.available=false;this.grant=null;if(this.lock){await this.lock.close();await unlink(this.path+'.lock').catch(()=>{});this.lock=null;}})();return this.closing;}
}
