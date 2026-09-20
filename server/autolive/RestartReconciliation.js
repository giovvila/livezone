import {createHash,randomUUID} from 'node:crypto';
import {validateProgramOutputEnvelope} from '../../public/js/program-output/ProgramOutputEnvelope.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const valid=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(value);
const fail=code=>{throw Object.assign(new Error(code),{code});};
// All checks and grant creation are synchronous inside the server mutation queue.
export default class RestartReconciliation {
 constructor({ownership,store,configuration,durable=null,clock=()=>Date.now()}){Object.assign(this,{ownership,store,configuration,durable,clock});this.records=new Map();this.manualIntentRevision=0;}
 manualIntent(){++this.manualIntentRevision;}
 beginManualIntent(){this.manualIntent();this.manualPending=(this.manualPending||0)+1;return ()=>{--this.manualPending;this.manualIntent();};}
 current(){
  const a=this.ownership;a.expire();if(!a.available||a.closed)fail('AUTHORITY_UNAVAILABLE');
  if(this.manualPending)fail('MANUAL_INTENT_PENDING');
  const durable=this.durable?.();if(durable&&!['PRESENT','EXPLICIT_EMPTY'].includes(durable.status))fail(durable.status==='UNRESOLVED'?'PROGRAM_IDENTITY_UNRESOLVED':'RETAINED_PROGRAM_UNAVAILABLE');
  const envelope=this.store.getCurrent();if(!envelope)fail('RETAINED_PROGRAM_UNAVAILABLE');
  if(!validateProgramOutputEnvelope(envelope))fail('PROGRAM_IDENTITY_UNRESOLVED');
  const config=this.configuration();if(!config?.available||!config.sourceFingerprint)fail('SOURCE_UNRESOLVED');
  return {authorityEpoch:a.authorityEpoch,authorityProcessSession:a.authorityProcessSession,
   programIdentity:hash(envelope),...(durable?{durableGeneration:durable.generation}:{}),configRevision:config.revision,sourceFingerprint:config.sourceFingerprint,
   manualIntentRevision:this.manualIntentRevision,ownershipRevision:a.grantRevision};
 }
 execute(value,principal){
  const a=this.ownership;const now=this.clock();
  for(const [id,r] of this.records)if(now>=r.expiresAt)this.records.delete(id);
  if(!valid(value.ownerInstanceId)||!valid(value.publisherSessionId))fail('INVALID_OWNER');
  const binding=JSON.stringify([principal,value.ownerInstanceId,value.publisherSessionId]);
  if(value.operation==='prepare-reconciliation'){
   const expected=this.current();if(a.grant)fail('OWNER_HELD');if(!a.restartBlocked)fail('RECONCILIATION_NOT_REQUIRED');
   if(this.records.size>=256)fail('RECONCILIATION_CAPACITY');
   const reconciliationId=randomUUID(),expiresAt=now+60000;
   this.records.set(reconciliationId,{binding,expected,expiresAt});
   const s=this.store.getCurrent().snapshot;
   return {reconciliationId,expected,expiresAt,program:{status:s.scene?'PRESENT':'EMPTY',sceneId:s.scene?.id??null,sceneName:s.scene?.name??null,sourceId:s.source?.id??null,kind:s.source?.kind??null}};
  }
  const record=this.records.get(value.reconciliationId);if(!record)fail('RECONCILIATION_EXPIRED');
  if(record.binding!==binding||!value.expected||hash(value.expected)!==hash(record.expected))fail('RECONCILIATION_MISMATCH');
  if(record.result){
   if(!a.matches(record.result.grant,principal))fail('RECONCILIATION_COMPLETED_GRANT_INACTIVE');
   return {...record.result,state:a.snapshot(),leaseRemainingMs:Math.max(0,a.grant.expiresAt-a.clock())};
  }
  const current=this.current();
  for(const key of Object.keys(current))if(current[key]!==record.expected[key])fail(key==='programIdentity'?'PROGRAM_CHANGED':key==='manualIntentRevision'?'MANUAL_INTENT_CHANGED':'RECONCILIATION_STALE');
  if(a.grant)fail('OWNER_HELD');if(!a.restartBlocked||a.manualSuppressed)fail('RECONCILIATION_STALE');
  if(a.retiredInstances.has(value.ownerInstanceId)||a.retiredInstances.size>=4096)fail('OWNER_RETIRED');
  a.principal=principal;a.grant={authorityEpoch:a.authorityEpoch,authorityProcessSession:a.authorityProcessSession,
   ownerKind:'BROWSER',ownerInstanceId:value.ownerInstanceId,publisherSessionId:value.publisherSessionId,
   grantRevision:++a.grantRevision,leaseId:randomUUID(),expiresAt:a.clock()+a.leaseMs};
  a.restartBlocked=false;a.reason='RECONCILED';
  record.result={reconciliationId:value.reconciliationId,state:a.snapshot(),grant:{...a.grant},
   retainedProgram:structuredClone(this.store.getCurrent().snapshot),leaseRemainingMs:a.leaseMs};
  return record.result;
 }
}
