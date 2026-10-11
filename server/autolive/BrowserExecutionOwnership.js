import {capturedEvidence} from '../recovery/PersistentEvidence.js';
import {existsSync} from 'node:fs';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink,readdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {executionEraStartup,eraRecordBytes} from '../recovery/ExecutionEraContract.js';
import {createLedgerV2Durability} from '../scheduler/LedgerV2Durability.js';
import {hash,seal,fail} from '../scheduler/ScheduledEntryLedgerV2Protocol.js';
import {normalizeSchedule} from '../scheduler/ScheduleContract.js';
import {readEvidence} from '../recovery/PersistentEvidence.js';
import {acquireMaintenanceGate} from './AuthorityMaintenanceGate.js';
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(value);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
// Single-host fail-closed lock. Never break an existing lock based on PID/age.
// After an unclean process exit an operator must reconcile the abandoned lock.
export default class BrowserExecutionOwnership {
 constructor({path,clock=()=>Date.now(),leaseMs=15000,eraLedgerPath,eraDurability=createLedgerV2Durability(),eraHook=()=>{},eraRecovery}){
  const executionEra=eraLedgerPath?executionEraStartup(eraLedgerPath):null;
  Object.assign(this,{path,clock,leaseMs,executionEra,eraDurability,eraHook,eraRecovery});this.executionEraId=executionEra?.executionEraId;this.authorityProcessSession=randomUUID();this.authorityEpoch=0;this.grantRevision=0;this.grant=null;this.retiredInstances=new Set();this.reason='INITIALIZING';this.ready=this.initialize();
 }
 async initialize(){
  let releaseGate;
  try{
   if(this.eraRecovery){
    if(!this.executionEra||this.path!==this.eraRecovery.p.authority)fail('NEW_ERA_RECOVERY_PATH_MISMATCH');
    await this.eraRecovery.acquireOwner(this);return;
   }
   if(this.executionEra&&(this.executionEra.pendingStartStages?.length||existsSync(this.executionEra.directory+'-recovery')))
    fail('EXECUTION_ERA_CONTROLLED_START_REQUIRED');
   const firstEraOwner=this.executionEra&&!(await readdir(this.executionEra.directory)).some(name=>name.startsWith('start-'));
   const retainedFence=async()=>{
    if(!firstEraOwner)return;
    const a=this.executionEra;
    for(const key of ['program','autoLive','authority'])if((await readEvidence(a.paths[key])).sha256!==a.inventory.find(i=>i.key===key).sha256)fail('EXECUTION_ERA_RETAINED_EVIDENCE_CHANGED');
    const original=JSON.parse(Buffer.from(a.inventory.find(i=>i.key==='schedule').bytes,'base64'));
    const expected=eraRecordBytes(normalizeSchedule({...original,revision:original.revision+1,executionEra:a.scheduleEra}));
    if((await readEvidence(a.paths.schedule)).sha256!==hash(expected))fail('EXECUTION_ERA_RETAINED_EVIDENCE_CHANGED');
   };
   await retainedFence();
   if(this.executionEra)await this.eraDurability.ensureDirectory(dirname(this.path));else await mkdir(dirname(this.path),{recursive:true});
   releaseGate=await acquireMaintenanceGate(this.path,this.executionEra?{durability:this.eraDurability}:{});this.lock=await open(this.path+'.lock','wx');
   this.lockBytes=JSON.stringify({pid:process.pid,authorityProcessSession:this.authorityProcessSession,...(this.executionEra?{executionEraId:this.executionEraId,transitionId:this.executionEra.transitionId,activationHash:this.executionEra.activationHash}:{})});
   await this.lock.writeFile(this.lockBytes);await this.lock.sync();if(this.executionEra){this.eraDurability.sync(this.path+'.lock');this.eraHook('owner-lock-durable');}
   let epoch=0,epochHash;try{const captured=capturedEvidence(await readFile(this.path),{json:true});epoch=captured.value.epoch;epochHash=captured.sha256;if(!Number.isSafeInteger(epoch)||epoch<0)throw Error('INVALID_EPOCH');}catch(e){if(e.code!=='ENOENT')throw e;}
   if(!Number.isSafeInteger(epoch+1))throw Error('INVALID_EPOCH');
   const temp=this.path+'.'+this.authorityProcessSession+'.tmp';const file=await open(temp,'wx');
   try{await file.writeFile(JSON.stringify({epoch:epoch+1}));await file.sync();}finally{await file.close();}
   if(this.executionEra){
    this.eraDurability.sync(temp);this.eraHook('before-epoch-install');
    await retainedFence();
    if((await readEvidence(this.path+'.lock')).text!==this.lockBytes)fail('EXECUTION_ERA_OWNER_CHANGED');
    if((await readEvidence(this.path)).sha256!==epochHash)fail('EXECUTION_ERA_AUTHORITY_CHANGED');
    this.eraDurability.replace(temp,this.path);await this.eraDurability.syncFile(this.path);this.eraHook('epoch-durable');
    const path=join(this.executionEra.directory,'start-'+this.authorityProcessSession+'.json');
    const record=seal({version:1,phase:'NEW_AUTHORITY_READY',executionEraId:this.executionEraId,transitionId:this.executionEra.transitionId,
     activationHash:this.executionEra.activationHash,previousEpoch:epoch,authorityEpoch:epoch+1,authorityProcessSession:this.authorityProcessSession,
     authorityBytesHash:(await readEvidence(this.path)).sha256,lockBytesHash:hash(this.lockBytes)});
    const handle=await open(path,'wx',0o600);try{await handle.writeFile(eraRecordBytes(record));await handle.sync();}finally{await handle.close();}
    await this.eraDurability.syncFile(path);this.eraHook('authority-ready-durable');
   }else await rename(temp,this.path);
   this.authorityEpoch=epoch+1;this.available=true;this.restartBlocked=epoch>0;this.reason=this.restartBlocked?'RESTART_RECONCILIATION_REQUIRED':'NO_OWNER';
  }catch(error){this.available=false;this.reason='AUTHORITY_UNAVAILABLE';this.initializationError=error.code||error.message;}
  finally{if(releaseGate)try{await releaseGate();}catch(error){this.available=false;this.reason='AUTHORITY_UNAVAILABLE';this.initializationError=error.code||error.message;}}
 }
 expire(){if(this.grant&&this.clock()>=this.grant.expiresAt){this.retiredInstances.add(this.grant.ownerInstanceId);this.grant=null;this.principal=null;this.reason='LEASE_EXPIRED';++this.grantRevision;}}
 // Project expiry without retiring the stored owner or consuming a revision.
 // expire() remains owned by mutation/authorization flows, never observation.
 snapshot(now=this.clock()){
  const expired=Boolean(this.grant&&now>=this.grant.expiresAt),grant=expired?null:this.grant;
  return {available:this.available===true,state:grant?'BROWSER_OWNER':'NO_OWNER',ownerKind:grant?'BROWSER':null,ownerInstanceId:grant?.ownerInstanceId??null,authorityEpoch:this.authorityEpoch,authorityProcessSession:this.authorityProcessSession,grantRevision:this.grantRevision,expiresAt:grant?.expiresAt??null,reason:expired?'LEASE_EXPIRED':this.reason,reconciliationRequired:expired,manualSuppressed:this.manualSuppressed===true,scheduledSuppressed:this.scheduledSuppressed===true,scheduledEventId:this.scheduledEventId??null,executionAllowed:false,serverTake:false};
 }
 matches(candidate,principal,publisherSessionId=candidate?.publisherSessionId){
  this.expire();const g=this.grant;
  return this.available===true&&!this.closed&&g&&principal===this.principal&&candidate&&
   ['authorityEpoch','authorityProcessSession','ownerInstanceId','publisherSessionId','grantRevision','ownerKind'].every(k=>candidate[k]===g[k])&&
   same(candidate.leaseId,g.leaseId)&&publisherSessionId===g.publisherSessionId;
 }
 async operate(value,principal){await this.ready;
  if(value.operation==='inspect')return {state:this.snapshot(),grant:null,leaseRemainingMs:0};
  this.expire();let grant=null;
  if(!this.available||this.closed)return {state:this.snapshot(),grant,leaseRemainingMs:grant?Math.max(0,grant.expiresAt-this.clock()):0};
  if(value.operation==='acquire'){
   if(!validId(value.ownerInstanceId)||!validId(value.publisherSessionId))throw Error('INVALID_OWNER');
   if(this.retiredInstances.has(value.ownerInstanceId)||this.retiredInstances.size>=4096){this.reason='OWNER_RETIRED';return {state:this.snapshot(),grant:null};}
   if(!this.grant&&!this.restartBlocked&&!this.manualSuppressed&&!this.scheduledSuppressed){this.principal=principal;this.grant={authorityEpoch:this.authorityEpoch,authorityProcessSession:this.authorityProcessSession,ownerKind:'BROWSER',ownerInstanceId:value.ownerInstanceId,publisherSessionId:value.publisherSessionId,grantRevision:++this.grantRevision,leaseId:randomUUID(),expiresAt:this.clock()+this.leaseMs};this.reason='GRANTED';grant={...this.grant};}
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
 suppressForScheduled(eventId){
  if(!validId(eventId))throw Error('INVALID_SCHEDULED_OWNER');
  if(!this.available||this.closed||this.restartBlocked)return false;
  if(this.scheduledSuppressed&&this.scheduledEventId!==eventId)return false;
  if(this.grant)this.retiredInstances.add(this.grant.ownerInstanceId);
  this.grant=null;this.principal=null;++this.grantRevision;
  this.scheduledSuppressed=true;this.scheduledEventId=eventId;this.reason='SCHEDULED_OVERRIDE';
  return true;
 }
 releaseScheduled(eventId){
  if(!validId(eventId)||!this.scheduledSuppressed||this.scheduledEventId!==eventId)return false;
  this.scheduledSuppressed=false;this.scheduledEventId=null;++this.grantRevision;
  this.reason=this.manualSuppressed?'MANUAL_OVERRIDE':'NO_OWNER';
  return true;
 }
 revokeForManual(publisherSessionId){
  this.restartBlocked=false;
  this.scheduledSuppressed=false;this.scheduledEventId=null;
  if(!this.grant||this.grant.publisherSessionId!==publisherSessionId){
   this.manualSuppressed=true;
   if(this.grant)this.retiredInstances.add(this.grant.ownerInstanceId);
   this.grant=null;this.principal=null;++this.grantRevision;this.reason='MANUAL_OVERRIDE';
  }
 }
 async close(){if(this.closing)return this.closing;this.closed=true;this.closing=(async()=>{await this.ready;this.available=false;this.grant=null;if(this.lock){await this.lock.close();if(this.executionEra){
   if(this.initializationError)return;
   if((await readEvidence(this.path+'.lock')).text!==this.lockBytes)fail('EXECUTION_ERA_OWNER_CHANGED');
   await this.eraDurability.remove(this.path+'.lock');
  }else await unlink(this.path+'.lock').catch(()=>{});this.lock=null;}})();return this.closing;}
}
