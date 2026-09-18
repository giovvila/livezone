import test from 'node:test';
import assert from 'node:assert/strict';
import AutoLiveDecisionShadow,{ENTRY_MS,LOSS_MS} from '../server/autolive/AutoLiveDecisionShadow.js';

const fp='a'.repeat(64);
const base={enabled:true,armed:true,sourceId:'live-source',sourceFingerprint:fp};
const health=(state,now)=>({state,freshness:'FRESH',validUntil:now+10000});

test('shadow engine is non executing and disarmed without both consents',()=>{
 let now=0;const engine=new AutoLiveDecisionShadow({clock:()=>now});
 for(const value of [{},{enabled:true},{enabled:true,armed:true,sourceId:'live-source'}]){
  const out=engine.update(value);assert.equal(out.state,'DISARMED');assert.equal(out.executionAllowed,false);assert.equal(out.serverTake,false);
 }
});

test('ONLINE must remain continuous for 30 seconds before ENTRY eligibility',()=>{
 let now=1000;const engine=new AutoLiveDecisionShadow({clock:()=>now});
 assert.equal(engine.update({...base,health:health('ONLINE',now)}).state,'ENTRY_PENDING');
 now+=ENTRY_MS-1;let out=engine.update({...base,health:health('ONLINE',now)});assert.equal(out.entryEligible,false);
 now+=1;out=engine.update({...base,health:health('ONLINE',now)});assert.equal(out.state,'ENTRY_ELIGIBLE');assert.equal(out.entryHealthyMs,ENTRY_MS);
});

test('definite OFFLINE resets entry accumulation while uncertainty does not mature eligibility',()=>{
 let now=0;const engine=new AutoLiveDecisionShadow({clock:()=>now});engine.update({...base,health:health('ONLINE',now)});
 now=10000;assert.equal(engine.update({...base,health:{state:'UNKNOWN',freshness:'FRESH',validUntil:now+10000}}).state,'WAITING_HEALTH');
 now=30000;assert.equal(engine.update({...base,health:{state:'UNKNOWN',freshness:'FRESH',validUntil:now+10000}}).entryEligible,false);
 engine.update({...base,health:health('OFFLINE',now)});now=60000;
 assert.equal(engine.update({...base,health:health('ONLINE',now)}).entryHealthyMs,0);
});

test('fingerprint change fences old entry timer',()=>{
 let now=0;const engine=new AutoLiveDecisionShadow({clock:()=>now});engine.update({...base,health:health('ONLINE',now)});
 now=ENTRY_MS;const changed={...base,sourceFingerprint:'b'.repeat(64)};
 const out=engine.update({...changed,health:health('ONLINE',now)});assert.equal(out.state,'ENTRY_PENDING');assert.equal(out.entryHealthyMs,0);assert.equal(out.entryEligible,false);
});

test('restart does not inherit matured entry time',()=>{
 let now=0;let engine=new AutoLiveDecisionShadow({clock:()=>now});engine.update({...base,health:health('ONLINE',now)});now=ENTRY_MS;
 assert.equal(engine.update({...base,health:health('ONLINE',now)}).entryEligible,true);
 engine=new AutoLiveDecisionShadow({clock:()=>now});const out=engine.update({...base,health:health('ONLINE',now)});assert.equal(out.entryEligible,false);assert.equal(out.entryHealthyMs,0);
});

test('browser LIVE observation enables loss shadow and loss requires more than 15 seconds definite OFFLINE',()=>{
 let now=0;const engine=new AutoLiveDecisionShadow({clock:()=>now});
 assert.equal(engine.update({...base,health:health('ONLINE',now),browserStage:'LIVE'}).state,'LIVE_OBSERVED');
 now=1;assert.equal(engine.update({...base,health:health('OFFLINE',now),browserStage:'LIVE'}).state,'LOSS_PENDING');
 now=1+LOSS_MS;let out=engine.update({...base,health:health('OFFLINE',now),browserStage:'LIVE'});assert.equal(out.lossEligible,false);
 now++;out=engine.update({...base,health:health('OFFLINE',now),browserStage:'LIVE'});assert.equal(out.state,'LOSS_ELIGIBLE');assert.equal(out.lossEligible,true);
});

test('uncertainty while live never becomes definite loss and recovery clears loss timer',()=>{
 let now=0;const engine=new AutoLiveDecisionShadow({clock:()=>now});engine.update({...base,health:health('ONLINE',now),browserStage:'LIVE'});
 now=1000;assert.equal(engine.update({...base,health:{state:'ERROR',freshness:'FRESH',validUntil:now+10000},browserStage:'LIVE'}).state,'LIVE_UNCERTAIN');
 now=30000;assert.equal(engine.update({...base,health:{state:'UNKNOWN',freshness:'EXPIRED',validUntil:0},browserStage:'LIVE'}).lossEligible,false);
 engine.update({...base,health:health('OFFLINE',now),browserStage:'LIVE'});now+=5000;
 const recovered=engine.update({...base,health:health('ONLINE',now),browserStage:'LIVE'});assert.equal(recovered.state,'LIVE_OBSERVED');assert.equal(recovered.lossMs,0);assert.equal(recovered.lossEligible,false);
});


test('A4 shadow exposes bounded transition diagnostics without execution authority',()=>{
 let now=0;const engine=new AutoLiveDecisionShadow({clock:()=>now});
 let out=engine.update({...base,health:health('ONLINE',now)});
 assert.equal(out.state,'ENTRY_PENDING');assert.equal(out.lastTransitionAt,0);assert.equal(out.lastTransitionFrom,null);assert.equal(out.lastTransitionTo,'ENTRY_PENDING');
 now=ENTRY_MS;out=engine.update({...base,health:health('ONLINE',now)});
 assert.equal(out.state,'ENTRY_ELIGIBLE');assert.equal(out.lastTransitionAt,ENTRY_MS);assert.equal(out.lastTransitionFrom,'ENTRY_PENDING');assert.equal(out.lastTransitionTo,'ENTRY_ELIGIBLE');
 now++;out=engine.update({...base,health:health('ONLINE',now),browserStage:'LIVE'});
 assert.equal(out.state,'LIVE_OBSERVED');assert.equal(out.lastTransitionFrom,'ENTRY_ELIGIBLE');assert.equal(out.lastTransitionTo,'LIVE_OBSERVED');
 assert.equal(out.executionAllowed,false);assert.equal(out.serverTake,false);
 const json=JSON.stringify(out);assert.doesNotMatch(json,/https?:|secret|url/i);
});


test('A5 readiness contract is fail-closed and never grants execution',()=>{
 let now=0;const engine=new AutoLiveDecisionShadow({clock:()=>now});
 let out=engine.update();
 assert.equal(out.readyForEntry,false);assert.equal(out.readyForLoss,false);assert.equal(out.readinessReason,'CONSENT_OR_SOURCE_MISSING');
 assert.equal(out.executionAllowed,false);assert.equal(out.serverTake,false);
 out=engine.update({...base,health:health('ONLINE',now)});
 assert.equal(out.readyForEntry,false);assert.equal(out.readinessReason,'ENTRY_HEALTH_ACCUMULATING');
 now=ENTRY_MS;out=engine.update({...base,health:health('ONLINE',now)});
 assert.equal(out.readyForEntry,true);assert.equal(out.readyForLoss,false);assert.equal(out.readinessReason,'ENTRY_HEALTH_MATURED');
 assert.equal(out.executionAllowed,false);assert.equal(out.serverTake,false);
 now++;out=engine.update({...base,health:health('ONLINE',now),browserStage:'LIVE'});
 assert.equal(out.readyForEntry,false);assert.equal(out.readyForLoss,false);assert.equal(out.readinessReason,'LIVE_HEALTHY');
 now++;out=engine.update({...base,health:health('OFFLINE',now),browserStage:'LIVE'});
 assert.equal(out.readyForLoss,false);assert.equal(out.readinessReason,'LOSS_GRACE_ACCUMULATING');
 now+=LOSS_MS+1;out=engine.update({...base,health:health('OFFLINE',now),browserStage:'LIVE'});
 assert.equal(out.readyForEntry,false);assert.equal(out.readyForLoss,true);assert.equal(out.readinessReason,'LOSS_CONFIRMED');
 assert.equal(out.executionAllowed,false);assert.equal(out.serverTake,false);
});

test('A5 uncertainty can never become execution readiness',()=>{
 let now=1000;const engine=new AutoLiveDecisionShadow({clock:()=>now});
 engine.update({...base,health:health('ONLINE',now),browserStage:'LIVE'});
 now+=60000;const out=engine.update({...base,health:{state:'ERROR',freshness:'FRESH',validUntil:now+10000},browserStage:'LIVE'});
 assert.equal(out.state,'LIVE_UNCERTAIN');assert.equal(out.readyForEntry,false);assert.equal(out.readyForLoss,false);
 assert.equal(out.readinessReason,'LIVE_HEALTH_UNCERTAIN');assert.equal(out.executionAllowed,false);assert.equal(out.serverTake,false);
});
