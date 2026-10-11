import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pureScheduleFixture,observer} from '../test-support/PureScheduleReadFixture.js';
const {default:ControlEventFeed}=await import('../server/program-output/ControlEventFeed.js');
const {default:ScheduleApiClient}=await import('../public/js/scheduler/ScheduleApiClient.js');

test('exact C-R8 GET RED to GREEN: actual Ledger WAL and full TEMP tree remain identical',async t=>{
 const h=await pureScheduleFixture(t),scheduler=h.owner.scheduler;
 const green=await h.observe(()=>h.request());
 assert.equal(green.status,200);assert.equal(green.body.runtime.reconciliationRequired,true);
 assert.equal(green.body.runtime.events.find(e=>e.id===h.event.id).status,'ACTIVE');
 assert.equal((await h.owner.ledger.inspect(h.identity)).status,'UNCONSUMED');
 const wal=await readFile(h.f.paths.ledger+'.wal');const original=scheduler.current;
 // Exact former shared caller from C-R8, using the same current production
 // reconciliation, execution subscribers and real TEMP v2 Ledger.
 scheduler.current=function(){this.runtime.reconcile();this.refresh();return this.summary();};
 const beforeSchedule=await readFile(h.f.paths.schedule);
 observer.enable();try{await h.request();await h.entry.idle();}finally{observer.disable();scheduler.current=original;}
 assert.notDeepEqual(await readFile(h.f.paths.ledger+'.wal'),wal);
 assert.deepEqual(await readFile(h.f.paths.schedule),beforeSchedule);
 assert.ok(observer.counts.write>0);assert.ok(observer.counts.rename>0);assert.ok(observer.counts.fileSync>=4);
 assert.equal((await h.owner.ledger.inspect(h.identity)).status,'ALREADY_CONSUMED');
 assert.deepEqual(h.counts,{captures:1,executions:1,consumeAttempts:1});
});

test('pending GET, status, SSE and HEAD share zero filesystem/domain effects',async t=>{
 const h=await pureScheduleFixture(t);
 await h.observe(async()=>{
  for(const suffix of ['', '/status']){const r=await h.request('GET',suffix);assert.equal(r.status,200);assert.equal(r.body.runtime.reconciliationRequired,true);assert.equal(r.body.runtime.serverTime,h.now);assert.ok(r.body.runtime.evaluatedAt<h.now);}
  const sse=await h.request('GET','/events');assert.equal(sse.status,200);assert.match(sse.chunks.join(''),/"reconciliationRequired":true/);
  for(const suffix of ['', '/status','/events'])assert.equal((await h.request('HEAD',suffix)).status,405);
 });
});

test('Control Room initial feed and UI polling observe pending state without ownership',async t=>{
 const h=await pureScheduleFixture(t);let reads=0;
 const feed=new ControlEventFeed({scheduler:h.owner.scheduler,effectiveOutput:{subscribe:()=>()=>{},getCurrent:()=>null},liveAutomation:h.automation});t.after(()=>feed.close());
 const client=new ScheduleApiClient({request:async(url,options)=>{assert.equal(options,undefined);reads++;const r=await h.request();return {ok:true,json:async()=>r.body};},eventSourceFactory:()=>({addEventListener(){},removeEventListener(){},close(){}})});t.after(()=>client.destroy());
 await h.observe(async()=>{
  const chunks=[];feed.connect({write:value=>{chunks.push(value);return true;},end(){}});
  assert.match(chunks.join(''),/"reconciliationRequired":true/);
  await client.start();await Promise.all(Array.from({length:12},()=>client.refresh()));
  assert.equal(reads,13);assert.equal(client.state.connection,'online');assert.equal(client.state.runtime.reconciliationRequired,true);
  const oldGeneration=client.state.runtime.generation;
  client.acceptRuntime({...client.state.runtime,reconciliationRequired:false});
  assert.equal(client.state.runtime.generation,oldGeneration);assert.equal(client.state.runtime.reconciliationRequired,false);
 });
});

test('concurrent GETs retain coherent revision, clock and projection without protocol advancement',async t=>{
 const h=await pureScheduleFixture(t);
 const responses=await h.observe(()=>Promise.all(Array.from({length:24},()=>h.request())));
 for(const r of responses){assert.equal(r.body.runtime.scheduleRevision,r.body.schedule.revision);assert.equal(r.body.runtime.serverTime,h.now);assert.equal(r.body.runtime.activeEvents.find(e=>e.id===h.event.id).type,'source.live');assert.equal(r.headers.ETag,'"schedule-'+r.body.schedule.revision+'"');}
 assert.ok(responses.every(r=>JSON.stringify(r.body)===JSON.stringify(responses[0].body)));
});

test('authorized reconciliation consumes before capture, concurrent reads add no work, repeated owner evaluation is idempotent',async t=>{
 const h=await pureScheduleFixture(t),scheduler=h.owner.scheduler;
 // Park the canonical serializer after the active authority requests entry.
 const run=h.entry.mutations.run;let release;h.entry.mutations.run=fn=>new Promise(resolve=>{release=()=>resolve(fn());});
 scheduler.runtime.reconcile();await Promise.resolve();assert.equal(typeof release,'function');
 await h.observe(()=>Promise.all(Array.from({length:8},()=>h.request())),{drain:false});
 h.entry.mutations.run=run;release();await h.entry.idle();
 assert.deepEqual(h.counts,{captures:1,executions:1,consumeAttempts:1});
 const wal=await readFile(h.f.paths.ledger+'.wal');
 for(let i=0;i<4;i++){scheduler.runtime.reconcile();await h.entry.idle();}
 assert.deepEqual(h.counts,{captures:1,executions:1,consumeAttempts:1});assert.deepEqual(await readFile(h.f.paths.ledger+'.wal'),wal);
 assert.equal((await h.request()).body.runtime.reconciliationRequired,false);
});

test('existing active authority timer drives liveness without any GET',async t=>{
 const h=await pureScheduleFixture(t),scheduler=h.owner.scheduler;let callback;
 scheduler.runtime.setTimer=fn=>{callback=fn;return {unref(){}};};
 h.now=h.start-1;scheduler.runtime.reconcile();await h.entry.idle();assert.equal(h.counts.captures,0);
 h.now=h.start+1;callback();await h.entry.idle();assert.equal(h.counts.captures,1);
 assert.equal((await h.owner.ledger.inspect(h.identity)).status,'ALREADY_CONSUMED');
});

test('successful authorized Schedule publication retains the canonical reconciliation subscriber',async t=>{
 const h=await pureScheduleFixture(t);const revision=h.owner.scheduler.store.getSnapshot().revision;
 const result=await h.owner.scheduler.store.update(h.event.id,{priority:1},revision);assert.equal(result.ok,true);
 await h.entry.idle();assert.equal(h.counts.captures,1);assert.equal(h.counts.executions,1);
});

test('read-model projection calls the clock once and retains last owner evaluation',async t=>{
 const h=await pureScheduleFixture(t);let calls=0;h.owner.scheduler.clock=()=>{calls++;return h.now;};
 const result=await h.observe(()=>h.request());assert.equal(calls,1);assert.ok(result.body.runtime.evaluatedAt<result.body.runtime.serverTime);
});

test.after(()=>observer.restore());
