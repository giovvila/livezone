import {recordFor} from './DurableProgramContract.js';

export default class ProgramCommitCoordinator {
 constructor({repository,store,bind=async()=>({sourceFingerprint:null,assets:[]}),validate=async()=>false,authorityEpoch=()=>0}){Object.assign(this,{repository,store,bind,validate,authorityEpoch});this.closed=false;}
 async initialize(){
  const record=await this.repository.load();if(!record)return;this.store.restoreHistory(record);
  try{if(!await this.validate(record))throw Error('UNRESOLVED');this.store.install({envelope:record.envelope,retiredPublisherSessions:record.retiredPublisherSessions});}
  catch{this.repository.status='UNRESOLVED';this.repository.error='DURABLE_IDENTITY_UNRESOLVED';}
 }
 async accept(payload,{check=()=>false,afterInstall=()=>{}}={}){
  if(this.closed||['DURABLE_COMMIT_UNCERTAIN','DURABLE_READ_FAILED','DURABLE_INITIALIZATION_FAILED'].includes(this.repository.error)||this.repository.status==='CORRUPT')return {accepted:false,reason:'durable-unavailable'};
  const before=this.store.getCurrent(),ledger=JSON.stringify([...this.store.retiredSessions]);
  const candidate=this.store.prepare(payload);if(!candidate.accepted)return candidate;
  let staged;
  try{
   if(!check())return {accepted:false,reason:'execution-owner-required'};
   const identity=await this.bind(candidate.envelope.snapshot);
   staged=await this.repository.stage(recordFor({...candidate,identity,generation:(this.repository.record?.generation||0)+1,authorityEpoch:this.authorityEpoch()}));
   if(!check()||this.store.getCurrent()!==before||JSON.stringify([...this.store.retiredSessions])!==ledger)return {accepted:false,reason:'execution-owner-required'};
   // From final fence through memory install there is no await/event-loop turn.
   this.repository.commit(staged);
   this.store.install(candidate,false);try{afterInstall();this.repository.hook('installed');}catch{};
   this.store.notify();try{this.repository.hook('notified');}catch{};
   return {accepted:true,reason:'accepted',envelope:candidate.envelope};
  }catch(error){return {accepted:false,reason:error.code==='PROGRAM_IDENTITY_UNRESOLVED'?'program-identity-unresolved':'durable-write-failed'};}
  finally{await this.repository.discard(staged);}
 }
}
