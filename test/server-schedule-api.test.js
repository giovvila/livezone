import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProgramOutputServer} from '../test-support/ReferenceAuthorityTestServer.js';
import OperatorAuth from '../server/auth/OperatorAuth.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';
const epoch=Date.parse('2026-09-12T20:00:00.000Z'),stamp=n=>new Date(epoch+n).toISOString();
const event=(patch={})=>({id:'A',version:1,type:'overlay.sponsor',enabled:true,startAt:stamp(1000),endAt:stamp(10000),priority:10,
    payload:{assetId:'asset-00000000-0000-4000-8000-000000000001',position:'top-right',sizePercent:15,opacity:1},...patch});
const ROOT='/api/studio/schedule';
async function harness(t,{corrupt=false,now=0}={}){
    const dir=await mkdtemp(join(tmpdir(),'lz-api-'));const path=join(dir,'schedule.json');
    if(corrupt)await writeFile(path,'corrupt');
    const clock={now:epoch+now};const timers=new Map();let sequence=0;
    const auth=new OperatorAuth({username:'operator',password:'test-password-only',secureCookie:false});
    const session=auth.authenticate('operator','test-password-only');const cookie=auth.createCookie(session).split(';')[0];
    const make=()=>createProgramOutputServer({publisherToken:'separate-test-publisher',operatorAuth:auth,
        mediaAssetRepository:{initialize:async()=>{},list:()=>[],get:id=>id===event().payload.assetId?{id,kind:'image',url:'/media-library/files/image/test.png'}:null},schedulePath:path,studioStatePath:join(dir,'studio.json'),mediaLibraryRoot:join(dir,'media'),scheduleClock:()=>clock.now,
        scheduleSetTimer:(fn,delay)=>{timers.set(++sequence,{fn,delay});return sequence;},scheduleClearTimer:id=>timers.delete(id)});
    let instance=make();await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));await instance.scheduler.ready;
    let base=`http://127.0.0.1:${instance.server.address().port}`;const aborts=[];
    const headers=()=>({Cookie:cookie,Origin:base,'X-Livezone-Operator-Request':'1','X-Livezone-CSRF':session.csrfToken,'Content-Type':'application/json'});
    const request=async(method,suffix='',body,revision,extra={})=>{
        const r=await fetch(base+ROOT+suffix,{method,headers:{...headers(),...(revision===undefined?{}:{'If-Match':`"schedule-${revision}"`}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
        return {status:r.status,body:await r.json(),etag:r.headers.get('etag')};
    };
    const sse=async()=>{
        const abort=new AbortController();aborts.push(abort);const r=await fetch(base+ROOT+'/events',{headers:headers(),signal:abort.signal});
        assert.equal(r.status,200);const reader=r.body.getReader();let buffer='';
        return {abort,async next(){while(!buffer.includes('\n\n')){const chunk=await reader.read();if(chunk.done)throw Error('closed');buffer+=new TextDecoder().decode(chunk.value);}
            const i=buffer.indexOf('\n\n'),packet=buffer.slice(0,i);buffer=buffer.slice(i+2);return JSON.parse(packet.split('\n').find(l=>l.startsWith('data: ')).slice(6));}};
    };
    t.after(async()=>{aborts.forEach(a=>a.abort());await new Promise(r=>instance.server.close(r));await rm(dir,{recursive:true,force:true});});
    return {get instance(){return instance;},get base(){return base;},clock,timers,path,request,sse,headers,
        tick(now){clock.now=epoch+now;const [id,{fn}]=timers.entries().next().value;timers.delete(id);fn();},
        async restart(){aborts.forEach(a=>a.abort());await new Promise(r=>instance.server.close(r));assert.equal(timers.size,0);
            instance=make();await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));await instance.scheduler.ready;base=`http://127.0.0.1:${instance.server.address().port}`;}};
}
test('one server owner hydrates once and keeps one timer across requests',async t=>{
    const h=await harness(t),owner=h.instance.scheduler;
    for(let i=0;i<5;i++){const r=await h.request('GET');assert.equal(r.status,200);assert.equal(r.body.schedule.version,1);assert.equal(r.body.runtime.scheduleRevision,0);assert.equal(h.instance.scheduler,owner);assert.equal(h.timers.size,1);}
    assert.equal(owner.diagnostics.snapshot().filter(e=>e.event==='schedule-hydrated').length,1);
});
test('API CRUD and revision progression reconcile immediately',async t=>{
    const h=await harness(t,{now:2000});let r=await h.request('POST','/events',event(),0);assert.equal(r.status,201);assert.equal(r.body.runtime.activeEvents[0].id,'A');
    r=await h.request('PATCH','/events/A',{endAt:stamp(1500)},1);assert.equal(r.status,200);assert.deepEqual(r.body.runtime.activeEvents,[]);
    r=await h.request('PATCH','/events/A',{endAt:stamp(9000)},2);assert.equal(r.body.runtime.activeEvents.length,1);
    r=await h.request('PATCH','/events/A',{enabled:false},3);assert.deepEqual(r.body.runtime.activeEvents,[]);
    r=await h.request('PATCH','/events/A',{enabled:true},4);assert.equal(r.body.runtime.activeEvents.length,1);
    r=await h.request('DELETE','/events/A',undefined,5);assert.equal(r.status,200);assert.equal(r.body.schedule.revision,6);assert.deepEqual(r.body.runtime.activeEvents,[]);
});
for(const [name,method,suffix,body,revision,status] of [
    ['missing revision','POST','/events',event(),undefined,428],['invalid create','POST','/events',{},0,422],
    ['unknown type','POST','/events',event({type:'program.scene'}),0,422],['invalid timestamp','POST','/events',event({startAt:'bad'}),0,422],
    ['no GET mutation','GET','/events/A',undefined,0,405],['unsupported method','PUT','/events',event(),0,405]])
    test(name,async t=>{const h=await harness(t);assert.equal((await h.request(method,suffix,body,revision)).status,status);assert.equal(h.instance.scheduler.store.getSnapshot().revision,0);});
test('invalid update and duplicate ID preserve persisted schedule',async t=>{
    const h=await harness(t);await h.request('POST','/events',event(),0);const before=await readFile(h.path,'utf8');
    assert.equal((await h.request('PATCH','/events/A',{payload:{}},1)).status,422);
    assert.equal((await h.request('POST','/events',event(),1)).status,409);assert.equal(await readFile(h.path,'utf8'),before);
});
test('two editors conflict and can reread then retry',async t=>{
    const h=await harness(t);const results=await Promise.all([h.request('POST','/events',event(),0),h.request('POST','/events',event({id:'B'}),0)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[201,412]);assert.equal(results.find(r=>r.status===412).body.error.code,'REVISION_CONFLICT');
    const read=await h.request('GET');assert.equal(read.body.schedule.events.length,1);assert.equal(read.etag,'"schedule-1"');
    assert.equal((await h.request('PATCH','/events/'+read.body.schedule.events[0].id,{priority:20},1)).status,200);
});
test('private retained SSE follows mutations and exact boundaries without any browser',async t=>{
    const h=await harness(t),stream=await h.sse();const initial=await stream.next();assert.deepEqual(initial.activeEvents,[]);
    await h.request('POST','/events',event(),0);let state=await stream.next();assert.equal(state.scheduleRevision,1);assert.deepEqual(state.activeEvents,[]);
    h.tick(1000);state=await stream.next();assert.deepEqual(state.activeEvents,[{id:'A',type:'overlay.sponsor'}]);assert.equal(state.serverTime,epoch+1000);
    h.tick(10000);state=await stream.next();assert.deepEqual(state.activeEvents,[]);assert.equal(h.instance.store.getCurrent(),null);
});
test('late subscriber and reconnect receive current active truth with no payload',async t=>{
    const h=await harness(t,{now:5000});await h.request('POST','/events',event(),0);
    const a=await h.sse(),first=await a.next();assert.equal(first.activeEvents[0].id,'A');assert.ok(!JSON.stringify(first).includes('asset-test'));a.abort.abort();
    const b=await h.sse();assert.deepEqual((await b.next()).activeEvents,first.activeEvents);
});
test('periodic unchanged reconcile does not emit logical SSE updates',async t=>{
    const h=await harness(t);await h.request('POST','/events',event({startAt:stamp(-1000),endAt:stamp(30000)}),0);
    let updates=0;const off=h.instance.scheduler.subscribe(()=>updates++);const generation=h.instance.scheduler.summary().generation;
    for(let i=1;i<10;i++)h.tick(i*1000);assert.equal(updates,0);assert.equal(h.instance.scheduler.summary().generation,generation);off();
});
for(const now of [5000,20000])test(`full HTTP restart hydration at ${now}`,async t=>{
    const h=await harness(t);await h.request('POST','/events',event(),0);h.clock.now=epoch+now;await h.restart();
    const r=await h.request('GET');assert.equal(r.body.schedule.revision,1);assert.equal(r.body.runtime.activeEvents.length,now<10000?1:0);
    const stream=await h.sse();assert.deepEqual((await stream.next()).activeEvents,r.body.runtime.activeEvents);
});
test('corrupt store is unavailable, bytes preserved, public server still alive',async t=>{
    const h=await harness(t,{corrupt:true});for(const suffix of ['','/status','/events'])assert.equal((await h.request('GET',suffix)).status,503);
    assert.equal((await h.request('POST','/events',event(),0)).status,503);assert.equal(await readFile(h.path,'utf8'),'corrupt');assert.equal(h.timers.size,0);
    assert.equal((await fetch(h.base+'/healthz')).status,200);
});
for(const suffix of ['','/status','/events'])test(`private read/SSE auth ${suffix}`,async t=>{
    const h=await harness(t);assert.equal((await fetch(h.base+ROOT+suffix)).status,401);
});
for(const agent of ['Public','OBS','Publisher'])test(`${agent} cannot mutate schedule`,async t=>{
    const h=await harness(t);const r=await fetch(h.base+ROOT+'/events',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer separate-test-publisher','If-Match':'"schedule-0"'},body:JSON.stringify(event())});
    assert.equal(r.status,401);assert.equal(h.instance.scheduler.store.getSnapshot().revision,0);
});
for(const [name,extra] of [['missing CSRF',{'X-Livezone-CSRF':''}],['wrong origin',{Origin:'https://attacker.invalid'}],['missing mutation header',{'X-Livezone-Operator-Request':''}]])
    test(name,async t=>{const h=await harness(t);assert.equal((await h.request('POST','/events',event(),0,extra)).status,403);});
test('shutdown stops runtime and closes live private SSE connections',async t=>{
    const h=await harness(t);const stream=await h.sse();await stream.next();
    await new Promise(r=>h.instance.server.close(r));assert.equal(h.timers.size,0);assert.equal(h.instance.scheduler.runtime.running,false);assert.equal(h.instance.scheduler.store.listeners.size,0);
});
test('Program Output POST and retained public SSE remain unchanged by scheduled state',async t=>{
    const h=await harness(t);const snapshot={version:1,revision:1,publisherSessionId:'test-publisher',publishedAt:stamp(0),committedAt:stamp(0),
        scene:{id:'A',name:'A',type:'MEDIA'},source:{id:'image',kind:'image',url:'https://example.test/image.png'},
        playback:{initialTime:0,duration:null,playing:false,ended:false,state:'ready',startedAt:stamp(0)},graphics:{items:[]},overlays:{},transition:{type:'cut',durationMs:0}};
    const envelope=createProgramOutputEnvelope(snapshot);assert.ok(envelope);
    assert.equal((await fetch(h.base+'/api/program-output',{method:'POST',headers:{...h.headers(),Authorization:'Bearer separate-test-publisher','X-Livezone-Program-Manual':'1','Content-Type':'application/json'},body:JSON.stringify(envelope)})).status,202);
    const retained=h.instance.store.getCurrent();await h.request('POST','/events',event(),0);h.tick(2000);assert.equal(h.instance.store.getCurrent(),retained);
    const abort=new AbortController();try{const r=await fetch(h.base+'/api/program-output/events',{signal:abort.signal});assert.equal(r.status,200);
        const text=new TextDecoder().decode((await r.body.getReader().read()).value);assert.ok(text.includes('event: program'));assert.ok(!text.includes('schedule-state'));assert.ok(!text.includes('asset-test'));
    }finally{abort.abort();}
});
test('GET status exposes runtime summary without payload or filesystem path',async t=>{
    const h=await harness(t);const r=await h.request('GET','/status');assert.equal(r.status,200);assert.equal(r.body.schedule,undefined);
    assert.equal(r.body.runtime.serverTime,epoch);assert.ok(!JSON.stringify(r.body).includes(h.path));
});
test('second owner for canonical path is unavailable and does not start another timer',async t=>{
    const {default:SchedulerServer}=await import('../server/scheduler/SchedulerServer.js');const h=await harness(t);
    const duplicate=new SchedulerServer({path:h.path,setTimer:()=>{throw Error('duplicate timer');}});await duplicate.ready;
    assert.equal(duplicate.available(),false);assert.equal(h.instance.scheduler.available(),true);await duplicate.close();assert.equal(h.timers.size,1);
});
test('schedule initialization cannot alias protected Studio state file',()=>{
    assert.throws(()=>createProgramOutputServer({publisherToken:'test-publisher-only',schedulePath:'same-state.json',studioStatePath:'same-state.json'}),/distinct/);
});
test('already-active create produces retained active SSE immediately',async t=>{
    const h=await harness(t,{now:3000});const s=await h.sse();await s.next();await h.request('POST','/events',event(),0);
    const update=await s.next();assert.equal(update.scheduleRevision,1);assert.equal(update.activeEvents.length,1);
});
test('future edit still emits schedule revision even when effective slots unchanged',async t=>{
    const h=await harness(t);await h.request('POST','/events',event(),0);const s=await h.sse();await s.next();
    await h.request('PATCH','/events/A',{priority:20},1);const update=await s.next();assert.equal(update.scheduleRevision,2);assert.deepEqual(update.activeEvents,[]);
});
test('delete active event emits an immediate empty retained state',async t=>{
    const h=await harness(t,{now:2000});await h.request('POST','/events',event(),0);const s=await h.sse();await s.next();
    await h.request('DELETE','/events/A',undefined,1);assert.deepEqual((await s.next()).activeEvents,[]);
});
test('persistence failure returns unavailable error without revision increment or output mutation',async t=>{
    const h=await harness(t);await h.request('POST','/events',event(),0);const original=h.instance.scheduler.store.fs.rename;
    h.instance.scheduler.store.fs.rename=async()=>{throw Error('private path not exposed');};
    const r=await h.request('PATCH','/events/A',{enabled:false},1);assert.equal(r.status,503);assert.equal(r.body.revision,1);
    assert.equal(r.body.error.code,'PERSISTENCE_FAILED');assert.equal(h.instance.store.getCurrent(),null);h.instance.scheduler.store.fs.rename=original;
});
test('unsupported persisted schema fails closed without rewrite',async t=>{
    const h=await harness(t);await writeFile(h.path,'{"version":999}');await h.restart();assert.equal((await h.request('GET')).status,503);
    assert.equal(await readFile(h.path,'utf8'),'{"version":999}');
});
test('malformed JSON request is rejected before store mutation',async t=>{
    const h=await harness(t);const r=await fetch(h.base+ROOT+'/events',{method:'POST',headers:{...h.headers(),'If-Match':'"schedule-0"'},body:'{'});
    assert.equal(r.status,400);assert.equal(h.instance.scheduler.store.getSnapshot().revision,0);
});
test('payload limit returns 413 without storing or reflecting contents',async t=>{
    const h=await harness(t);const r=await h.request('POST','/events',{text:'x'.repeat(70000)},0);assert.equal(r.status,413);
    assert.equal(r.body.error.code,'PAYLOAD_TOO_LARGE');assert.equal(h.instance.scheduler.store.getSnapshot().revision,0);
});
const planFixture={version:1,timezone:'Europe/Rome',items:[{id:'plan-A',title:'Scheduled media',startMode:'ABSOLUTE',behavior:'NORMAL',resumePolicy:'RESUME_SHIFT',start:stamp(1000),durationSeconds:10,sceneId:'scene-a',transition:'DISSOLVE'}]};
test('A3 Program plan import persists server schema v2 without Program execution',async t=>{
 const h=await harness(t);let r=await h.request('POST','/program-plan/import',planFixture,0);assert.equal(r.status,201);assert.equal(r.body.schedule.version,2);
 assert.equal(r.body.schedule.programPlan.items[0].resumePolicy,'RESUME_SHIFT');h.tick(1000);
 r=await h.request('GET');assert.equal(r.body.runtime.programPlan.activeId,'plan-A');assert.equal(r.body.runtime.programPlan.execution,'SUSPENDED');assert.equal(h.instance.store.getCurrent(),null);
 await h.restart();r=await h.request('GET');assert.equal(r.body.schedule.programPlan.items.length,1);
});
test('A3 import refuses nonempty server and protects revision on retry',async t=>{
 const h=await harness(t);await h.request('POST','/events',event(),0);const r=await h.request('POST','/program-plan/import',planFixture,1);
 assert.equal(r.status,409);assert.equal(r.body.error.code,'SERVER_NOT_EMPTY');assert.equal(h.instance.scheduler.store.getSnapshot().revision,1);
});
test('A3 server Program edits preserve overlay events and reject invalid plans',async t=>{
 const h=await harness(t);await h.request('POST','/events',event(),0);let r=await h.request('PUT','/program-plan',planFixture,1);assert.equal(r.status,200);assert.equal(r.body.schedule.events.length,1);
 r=await h.request('PUT','/program-plan',{...planFixture,timezone:'bad'},2);assert.equal(r.status,422);
 r=await h.request('PATCH','/events/A',{priority:40},2);assert.equal(r.body.schedule.programPlan.items.length,1);
});
test('A3 clear does not enable another automatic legacy import',async t=>{
 const h=await harness(t);await h.request('POST','/program-plan/import',planFixture,0);await h.request('PUT','/program-plan',{...planFixture,items:[]},1);
 assert.equal((await h.request('POST','/program-plan/import',planFixture,2)).status,409);
});
