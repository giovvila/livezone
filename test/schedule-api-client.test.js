import test from 'node:test';
import assert from 'node:assert/strict';
import ScheduleApiClient from '../public/js/scheduler/ScheduleApiClient.js';
const summary=(revision,generation=revision)=>({version:1,sessionId:'server',generation,scheduleRevision:revision,status:'READY',serverTime:0,activeEvents:[],nextDeadline:null});
const body=(revision,generation=revision)=>({schedule:{version:1,revision,events:[]},runtime:summary(revision,generation)});
const response=(value,status=200)=>({ok:status<400,status,json:async()=>value});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
async function harness(t,request){const stream=new EventTarget();stream.close=()=>{stream.closed=true;};
 const client=new ScheduleApiClient({request,eventSourceFactory:()=>stream});t.after(()=>client.destroy());await client.start();
 return {client,stream,send:v=>stream.dispatchEvent(new MessageEvent('schedule-state',{data:JSON.stringify(v)}))};}
test('initial GET and retained SSE are server-derived',async t=>{
 const h=await harness(t,async()=>response(body(1)));assert.equal(h.client.state.schedule.revision,1);assert.equal(h.client.writable,true);
 h.send({...summary(1,2),activeEvents:[{id:'A',type:'overlay.crawl'}]});assert.equal(h.client.state.runtime.activeEvents[0].id,'A');
 h.send(summary(1,3));assert.deepEqual(h.client.state.runtime.activeEvents,[]);
});
for(const [method,action] of [['POST',c=>c.create({id:'A'})],['PATCH',c=>c.update('A',{priority:1})],['DELETE',c=>c.delete('A')],['PATCH',c=>c.setEnabled('A',false)]])
 test(`mutation ${method} uses current If-Match`,async t=>{
  let options;const h=await harness(t,async(url,o)=>{if(o){options=o;return response(body(2));}return response(body(1));});
  assert.equal((await action(h.client)).ok,true);assert.equal(options.method,method);assert.equal(options.headers['If-Match'],'"schedule-1"');assert.equal(h.client.state.schedule.revision,2);
 });
test('conflict refreshes without automatic retry or merge',async t=>{
 let reads=0,writes=0;const h=await harness(t,async(url,o)=>{if(o){writes++;return response({error:{code:'REVISION_CONFLICT'}},412);}return response(body(++reads));});
 assert.equal((await h.client.update('A',{})).code,'REVISION_CONFLICT');assert.equal(writes,1);assert.equal(h.client.state.schedule.revision,2);assert.match(h.client.state.feedback,/SCHEDULE CHANGED/);
});
test('older GET completion cannot overwrite a newer SSE revision',async t=>{
 let reads=0,finish;const h=await harness(t,async()=>{reads++;if(reads===2)return new Promise(r=>finish=r);return response(body(reads===1?1:3));});
 const pending=h.client.refresh();h.send(summary(3));await flush();finish(response(body(2)));await pending;assert.equal(h.client.state.schedule.revision,3);
});
test('duplicate HTTP and SSE revision produce no duplicate data',async t=>{
 const h=await harness(t,async()=>response(body(1)));let calls=0;h.client.subscribe(()=>calls++);h.client.acceptSnapshot(body(1));assert.equal(calls,1);
 h.send(summary(1));assert.equal(h.client.state.schedule.events.length,0);
});
test('SSE error disables writes without local timer fallback and retained reconnect restores',async t=>{
 const h=await harness(t,async()=>response(body(1)));h.stream.dispatchEvent(new Event('error'));assert.equal(h.client.writable,false);assert.equal(h.client.state.schedule.revision,1);
 h.send(summary(1));assert.equal(h.client.writable,true);
});
test('server unavailable retains explicit read-only state',async t=>{
 const h=await harness(t,async()=>response({},503));assert.equal(h.client.writable,false);assert.equal(h.client.state.connection,'unavailable');assert.equal((await h.client.create({})).code,'SCHEDULE_UNAVAILABLE');
});
test('destroy rejects late request completion and closes stream',async t=>{
 let finish,count=0;const h=await harness(t,async()=>++count===1?response(body(1)):new Promise(r=>finish=r));const pending=h.client.refresh();h.client.destroy();finish(response(body(2)));await pending;
 assert.equal(h.client.state.schedule.revision,1);assert.equal(h.stream.closed,true);
});


test('two clients observe one mutation through SSE and reject stale edits',async t=>{
 let state=body(1); const request=async(url,o)=>{
  if(o){if(o.headers['If-Match']!=='"schedule-'+state.schedule.revision+'"')return response({error:{code:'REVISION_CONFLICT'}},412);state=body(2);}
  return response(state);
 };
 const a=await harness(t,request),b=await harness(t,request);
 assert.equal((await a.client.create({id:'A'})).ok,true);
 assert.equal((await b.client.update('A',{})).code,'REVISION_CONFLICT');
 b.send(state.runtime);await flush();assert.deepEqual(b.client.state.schedule,a.client.state.schedule);
 state=body(3);b.send(state.runtime);await flush();assert.equal(b.client.state.schedule.revision,3);
});

test('new server session retires old SSE and in-flight GET',async t=>{
 let reads=0,finish;const fresh=body(0);fresh.runtime={...summary(0),sessionId:'restart'};
 const h=await harness(t,async()=>++reads===1?response(body(8)):reads===2?new Promise(r=>finish=r):response(fresh));
 const pending=h.client.refresh();h.send(fresh.runtime);await flush();
 finish(response(body(9)));await pending;h.send(summary(10));
 assert.equal(h.client.state.runtime.sessionId,'restart');assert.equal(h.client.state.schedule.revision,0);
});


test('old server 404 remains the first failure after SSE error',async t=>{
 const h=await harness(t,async()=>response({ok:false,error:'not-found'},404));
 h.stream.dispatchEvent(new Event('error'));
 assert.equal(h.client.state.reason,'API_NOT_FOUND');assert.equal(h.client.state.connection,'unavailable');
 assert.equal(h.client.state.schedule,null);assert.equal(h.client.writable,false);
});

test('retained reconnect clears initial API failure and restores writes',async t=>{
 let available=false;const h=await harness(t,async()=>available?response(body(0)):response({},404));
 available=true;h.send(summary(0));await flush();
 assert.equal(h.client.state.reason,null);assert.equal(h.client.writable,true);assert.equal(h.client.state.schedule.revision,0);
});
