import assert from 'node:assert/strict';
import ScheduledEntryRuntime from '../server/scheduler/ScheduledEntryRuntime.js';
import ScheduledLiveOwnershipCoordinator from '../server/scheduler/ScheduledLiveOwnershipCoordinator.js';
import ScheduledLiveExecutionCoordinator from '../server/scheduler/ScheduledLiveExecutionCoordinator.js';
import {createScheduledLiveProgram} from '../server/scheduler/ScheduledLiveProgramFactory.js';
import AssetMutationCoordinator from '../server/media-library/AssetMutationCoordinator.js';
export async function grantFutureRuntime({app,event,clock,setNow,counter,replay=false}){
 const ownership=app.executionOwnership,scheduler=app.scheduler,ledger=app.ledger,commits=app.programCommits;
 const retained=structuredClone(app.durableProgram.record),sourceId=event.payload.sourceId;
 const scheduledOwnership=new ScheduledLiveOwnershipCoordinator({ownership,reconciliation:app.restartReconciliation,program:()=>app.store.getCurrent(),clock});
 const capture=scheduledOwnership.capture.bind(scheduledOwnership);
 scheduledOwnership.capture=input=>{assert.equal(ledger.snapshot.entries.filter(e=>e.identity.eventId===input.eventId).length,1);assert.equal(ledger.records.at(-1).type,'COMMIT');counter.captures++;return capture(input);};
 const mutations=new AssetMutationCoordinator();
 const automation={resolveSource:()=>({descriptor:{fingerprint:'TEMP-verified-health'}}),health:{sourceId,sourceFingerprint:'TEMP-verified-health',state:'ONLINE',freshness:'FRESH',validUntil:Date.parse('2031-01-01T00:00:00Z'),playlistProgressing:true,segmentReachable:true}};
 const diagnostics=[];
 const runtime=new ScheduledEntryRuntime({scheduler,automation,ownership,reconciliation:app.restartReconciliation,scheduledOwnership,mutations,clock,ready:Promise.resolve(ledger),logger:e=>diagnostics.push(e)});
 const execution=new ScheduledLiveExecutionCoordinator({ownership,reconciliation:app.restartReconciliation,scheduledOwnership,mutations,commits,entryCheck:c=>runtime.checkCommit(c)});
 const unsubscribe=scheduler.runtime.subscribeEvaluation(snapshot=>{const active=snapshot.activeEvents.find(e=>e.id===event.id);if(active)runtime.request({eventId:event.id},async ticket=>{
  scheduledOwnership.transition('begin-preroll');const live=scheduledOwnership.transition('begin-live');
  const payload=createScheduledLiveProgram({eventId:ticket.eventId,sourceId,sourceUrl:'https://example.test/era.m3u8',publisherSessionId:'grant-live-'+ticket.incarnationId,revision:1,now:clock()});
  const result=await execution.commit({eventId:ticket.eventId,sourceId,expectedState:'LIVE',fence:scheduledOwnership.snapshot().fence,manualIntentRevision:live.manualIntentRevision,payload});assert.equal(result.accepted,true,result.reason);
 });});
 try{
  setNow(Date.parse(event.startAt)+1);scheduler.runtime.reconcile();await runtime.idle();
  assert.equal(counter.captures,1,JSON.stringify(diagnostics));assert.equal(ledger.snapshot.entries.filter(e=>e.identity.eventId===event.id).length,1);
  if(!replay){
   scheduledOwnership.release(event.id);
   const envelope={...retained.envelope,publisherSessionId:'grant-return',revision:1,publishedAt:new Date(clock()).toISOString(),snapshot:{...retained.envelope.snapshot,publisherSessionId:'grant-return',revision:1,publishedAt:new Date(clock()).toISOString()}};
   assert.equal((await commits.accept(envelope,{check:()=>ownership.available})).accepted,true);
  }
 }finally{unsubscribe();runtime.close();scheduledOwnership.close();}
}
