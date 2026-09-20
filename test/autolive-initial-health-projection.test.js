import test from 'node:test';
import assert from 'node:assert/strict';
import AutoLiveActiveHealth from '../public/js/studio/AutoLiveActiveHealth.js';
import {RuntimeTrace} from '../public/js/core/RuntimeTrace.js';

function fixture(){
 let now=0,lease=true,scene='LIVE';const observations=[];
 const video=Object.assign(new EventTarget(),{currentTime:0,readyState:4,paused:false,ended:false});
 const surface={sourceId:'primecast',instanceId:'program-1',video,getHealth:()=>({state:'ready'})};
 const c={started:true,generation:1,session:{sessionId:'retained',sourceId:'primecast',sceneId:'LIVE',phase:'LIVE',retained:true},
  clock:()=>now,clearTimer:()=>{},executionOwnership:{valid:()=>lease},renderer:{program:{renderer:surface}},
  command:{stateManager:{getProgramSceneId:()=>scene}},lossTimer:null,lossGraceExpired:false,lossGraceMs:5000,
  externalObservation:{state:'ONLINE'},health:{state:'CHECKING',authority:'unresolved'},
  acceptActiveHealth(owner,state,reason){observations.push({owner,state,reason});this.health={state,authority:'active-program'};}};
 const owner=c.activeHealth=new AutoLiveActiveHealth(c);owner.observe();
 return {c,owner,observations,video,advance:ms=>now+=ms,lose:()=>lease=false,changeScene:()=>scene='OTHER',
  progress(){now+=250;video.currentTime+=.25;video.dispatchEvent(new Event('timeupdate'));}};
}
test('first actual ONLINE observation projects once despite initialized ONLINE; construction does not',()=>{
 const h=fixture();assert.equal(h.owner.state,'ONLINE');assert.equal(h.observations.length,0);
 assert.equal(h.c.health.authority,'unresolved');h.progress();
 assert.equal(h.observations.length,1);assert.equal(h.c.health.authority,'active-program');
 assert.equal(h.observations[0].reason,'active-program-progress');h.progress();h.progress();
 assert.equal(h.observations.length,1);assert.equal(h.owner.projected,true);h.owner.destroy();
});
for(const invalidation of ['lease','generation','scene','surface'])test('initial projection rejects stale '+invalidation,()=>{
 const h=fixture();
 if(invalidation==='lease')h.lose();if(invalidation==='generation')h.c.generation++;
 if(invalidation==='scene')h.changeScene();if(invalidation==='surface')h.c.renderer.program.renderer={sourceId:'other'};
 h.progress();assert.equal(h.observations.length,0);assert.equal(h.owner.projected,false);h.owner.destroy();
});
test('first genuine warning projects CHECKING without manufacturing ONLINE',()=>{
 const h=fixture();h.video.dispatchEvent(new Event('waiting'));h.advance(2000);h.owner.check();
 assert.equal(h.observations.length,1);assert.equal(h.observations[0].state,'CHECKING');
 assert.equal(h.c.health.authority,'active-program');h.owner.destroy();
});
test('trace preserves explicit health provenance while rejecting URL-shaped diagnostic values',()=>{
 const trace=new RuntimeTrace({enabled:true});trace.record('autolive-handoff','health-observation',{
  externalMonitorState:'OFFLINE',externalMonitorReason:'HLS_OFFLINE',externalMonitorAuthority:'external-hls',
  controllerProjectionState:'ONLINE',controllerProjectionAuthority:'active-program',controllerProjectionGeneration:2,
  activeProgramPlayerState:'ready',activeProgramHealthState:'ONLINE',activeProgramAuthority:'active-program',
  activeProgramHealthProjected:true,activeProgramPlaybackProgressing:true,activeProgramCurrentTime:42,activeProgramLastHealthyAt:1000,
  reason:'https://secret.invalid/token',unrecognizedSecret:'hidden'});
 const row=trace.snapshot()[0];assert.equal(row.externalMonitorState,'OFFLINE');assert.equal(row.controllerProjectionState,'ONLINE');
 assert.equal(row.activeProgramPlaybackProgressing,true);assert.equal(row.activeProgramHealthProjected,true);
 assert.equal(row.activeProgramCurrentTime,42);assert.equal(row.reason,undefined);assert.equal(row.unrecognizedSecret,undefined);
});
