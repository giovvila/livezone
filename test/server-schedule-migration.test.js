import test from 'node:test';
import assert from 'node:assert/strict';
import ServerScheduleStore from '../public/js/scheduler/ServerScheduleStore.js';
import ScheduleApiClient from '../public/js/scheduler/ScheduleApiClient.js';
import {normalizeProgramPlan,editorPlan,serializeProgramPlan} from '../public/js/scheduler/ProgramScheduleAdapter.js';
import SchedulerEngine from '../public/js/scheduler/SchedulerEngine.js';
const key='livezone.scheduler.schedule.v1';
const plan={version:1,timezone:'Europe/Rome',items:[{id:'A',title:'Media A',startMode:'ABSOLUTE',behavior:'NORMAL',resumePolicy:'RESUME_SHIFT',start:'2026-09-12T20:00:00.000Z',durationSeconds:30,sceneId:'scene-a',transition:'DISSOLVE'},
{id:'B',title:'Media B',startMode:'AFTER_PREVIOUS',behavior:'NORMAL',resumePolicy:'RESUME_FIXED',durationSeconds:40,target:{kind:'source',id:'source-b'},transition:'CUT'}]};
const runtime=revision=>({version:1,sessionId:'server',generation:revision,scheduleRevision:revision,status:'READY',activeEvents:[],programPlan:{execution:'SUSPENDED',activeId:null,nextId:'A',items:[]}});
async function harness(t,{legacy=null,initial={version:1,revision:0,events:[]},unavailable=false}={}){
 let schedule=initial,writes=0;const data=new Map([['unrelated','keep']]);if(legacy!==null)data.set(key,legacy);
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const client=new ScheduleApiClient({eventSourceFactory:()=>{const x=new EventTarget();x.close=()=>{};return x;},request:async(url,o)=>{
  if(unavailable)return {ok:false,status:503,json:async()=>({})};
  if(o){writes++;schedule={...schedule,version:2,revision:schedule.revision+1,programPlan:JSON.parse(o.body)};}
  return {ok:true,status:o?201:200,json:async()=>({schedule,runtime:runtime(schedule.revision)})};
 }});
 const store=new ServerScheduleStore({client,storage});t.after(()=>store.destroy());await store.start();return{store,data,get writes(){return writes;},get schedule(){return schedule;}};
}
test('program plan adapter round-trips scene/source, timing and recovery fields',()=>{
 assert.deepEqual(serializeProgramPlan(editorPlan(plan)),normalizeProgramPlan(plan));
 assert.equal(editorPlan(plan).items[1].startMs,Date.parse(plan.items[0].start)+30000);
});
test('empty server without legacy stays empty without writes',async t=>{const h=await harness(t);assert.equal(h.writes,0);assert.equal(h.store.getSnapshot().schedule.items.length,0);});
test('valid legacy imports once verifies persistence and preserves original',async t=>{const raw=JSON.stringify(plan),h=await harness(t,{legacy:raw});assert.equal(h.writes,1);assert.equal(h.data.get(key),raw);assert.equal(h.store.getSnapshot().schedule.items.length,2);assert.match(h.store.migration,/VERIFIED/);});
test('reload after migration never repeats import',async t=>{
 const initial={version:2,revision:1,events:[],programPlan:normalizeProgramPlan(plan)};const h=await harness(t,{legacy:JSON.stringify(plan),initial});assert.equal(h.writes,0);assert.equal(h.store.getSnapshot().schedule.items.length,2);
});
test('migration is idempotent during repeated initialization checks',async t=>{const h=await harness(t,{legacy:JSON.stringify(plan)});await h.store.importLegacy();assert.equal(h.writes,1);});
test('nonempty server overlay domain wins without merging legacy plan',async t=>{const h=await harness(t,{legacy:JSON.stringify(plan),initial:{version:1,revision:1,events:[{id:'overlay'}]}});assert.equal(h.writes,0);assert.equal(h.schedule.programPlan,undefined);assert.ok(h.data.has(key));});
test('different nonempty server Program plan wins',async t=>{const other={...plan,items:[{...plan.items[0],title:'Server version'}]};const h=await harness(t,{legacy:JSON.stringify(plan),initial:{version:2,revision:3,events:[],programPlan:other}});assert.equal(h.store.getSnapshot().schedule.items[0].title,'Server version');assert.equal(h.writes,0);});
test('malformed legacy remains intact with visible status',async t=>{const h=await harness(t,{legacy:'{bad'});assert.equal(h.data.get(key),'{bad');assert.equal(h.writes,0);assert.match(h.store.migration,/INVALID/);});
test('import touches only exact marker and no unrelated keys',async t=>{const h=await harness(t,{legacy:JSON.stringify(plan)});assert.equal(h.data.get('unrelated'),'keep');assert.deepEqual([...h.data.keys()].sort(),['unrelated',key,'livezone.scheduler.schedule.serverMigration.v1'].sort());});
test('deliberately cleared server plan cannot resurrect legacy import',async t=>{const h=await harness(t,{legacy:JSON.stringify(plan),initial:{version:2,revision:4,events:[],programPlan:{version:1,timezone:'Europe/Rome',items:[]}}});assert.equal(h.writes,0);assert.match(h.store.migration,/REVIEW/);});
test('offline server never executes or imports legacy fallback',async t=>{const h=await harness(t,{legacy:JSON.stringify(plan),unavailable:true});assert.equal(h.store.writable,false);assert.equal(h.writes,0);assert.equal(h.store.getSnapshot().schedule.items.length,0);});
test('editor save uses API without modifying legacy bytes',async t=>{const h=await harness(t);const result=await h.store.save(editorPlan(plan));assert.equal(result.ok,true);assert.equal(h.writes,1);assert.equal(h.data.has(key),false);});
test('suspended Program engine keeps AutoLive gate without commands or deadlines',()=>{
 let commands=0,timers=0;const engine=new SchedulerEngine({programExecution:false,eventBus:{on(){},off(){}},catalog:{},clock:()=>Date.parse(plan.items[0].start)+1000,
 command:{execute(){commands++;},release(){commands++;}},setTimer(){timers++;},clearTimer(){}});
 engine.setSchedule(editorPlan(plan));engine.start();assert.equal(engine.getSnapshot().enabled,true);assert.equal(engine.getSnapshot().activeItem,null);
 const context=engine.beginInterruption({sessionId:'live',allowEmptySlot:true});assert.equal(context.kind,'empty-slot');engine.endInterruption(undefined,{reconcile:true});
 assert.equal(commands,0);assert.equal(timers,0);engine.destroy();
});


test('failed verification GET does not mark legacy import verified',async t=>{
 const data=new Map([[key,JSON.stringify(plan)]]);let reads=0;
 const client=new ScheduleApiClient({eventSourceFactory:()=>{const s=new EventTarget();s.close=()=>{};return s;},request:async(url,o)=>{
  if(!o&&++reads>1)return {ok:false,status:503,json:async()=>({})};
  const schedule=o?{version:2,revision:1,events:[],programPlan:normalizeProgramPlan(plan)}:{version:1,revision:0,events:[]};
  return {ok:true,status:200,json:async()=>({schedule,runtime:runtime(schedule.revision)})};
 }});
 const store=new ServerScheduleStore({client,storage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)}});t.after(()=>store.destroy());await store.start();
 assert.match(store.migration,/VERIFICATION REQUIRED/);assert.equal(data.has('livezone.scheduler.schedule.serverMigration.v1'),false);assert.equal(data.get(key),JSON.stringify(plan));
});


test('workspace projects server status and read-only failure without browser activation',async t=>{
 const {default:Workspace}=await import('../public/js/ui/ScheduleWorkspaceUI.js');
 const previous=globalThis.document;t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 globalThis.document={createElement:()=>({textContent:'',setAttribute(){},after(){},replaceChildren(...children){this.children=children;}})};
 const input={disabled:false};const ui=Object.create(Workspace.prototype);
 Object.assign(ui,{store:{serverAuthoritative:true,writable:false,runtime:{nextDeadline:1000,events:[{id:'crawl',type:'overlay.crawl',status:'ACTIVE'}]}},
 root:{prepend(){}},form:{querySelectorAll:()=>[input]},selectedDate:'2026-09-12',dateInput:{},renderScenes(){},renderSourceTargets(){},renderMediaDuration(){},render(){}});
 ui.handleSchedule({schedule:editorPlan(plan),issues:[],connection:'degraded',revision:7,feedback:'SCHEDULE CHANGED — REFRESHED'});
 assert.match(ui.serverBanner.textContent,/DEGRADED.*REV 7.*PROGRAM EXECUTION SUSPENDED.*SCHEDULE CHANGED/);
 assert.equal(input.disabled,true);assert.match(ui.serverEvents.children[0].textContent,/ACTIVE.*overlay/);
 ui.store.writable=true;ui.store.runtime.events[0].status='EXPIRED';
 ui.handleSchedule({schedule:editorPlan(plan),connection:'online',revision:7});
 assert.equal(input.disabled,false);assert.match(ui.serverEvents.children[0].textContent,/EXPIRED/);
});
