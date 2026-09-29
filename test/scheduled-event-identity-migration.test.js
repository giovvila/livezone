import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,open,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {Readable} from 'node:stream';
import {JSDOM} from 'jsdom';
import ScheduledLiveUI from '../public/js/ui/ScheduledLiveUI.js';
import ScheduleStore from '../server/scheduler/ScheduleStore.js';
import ScheduleAuthority from '../server/scheduler/ScheduleAuthority.js';
import SchedulerServer from '../server/scheduler/SchedulerServer.js';
import ScheduleRoutes from '../server/scheduler/ScheduleRoutes.js';
import {normalizeSchedule,normalizeEvent} from '../server/scheduler/ScheduleContract.js';
import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';

const epoch=Date.parse('2026-09-29T00:00:00.000Z');
const stamp=n=>new Date(epoch+n).toISOString();
const live=(patch={})=>({id:'event',name:'Live',version:1,type:'source.live',enabled:true,
    startAt:stamp(200000),endAt:stamp(300000),priority:10,
    payload:{sourceId:'source',precheckSeconds:180,unavailableAction:'KEEP_PROGRAM',unavailableSceneId:null,endAction:'RETURN',endSceneId:null},
    createdAt:stamp(0),updatedAt:stamp(0),...patch});
const overlay={id:'overlay',version:1,type:'overlay.crawl',enabled:true,startAt:stamp(0),endAt:stamp(300000),priority:0,
    payload:{text:'News',position:'bottom',direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true},createdAt:stamp(0),updatedAt:stamp(0)};
const key=e=>identityForScheduledEvent(e).entryKey;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

async function fixture(t,{legacy,now=100000}={}) {
    const root=resolve(tmpdir()),dir=await mkdtemp(join(root,'lz-c6e-identity-'));
    const path=join(dir,'schedule.json'),stores=[];
    const clock={now:epoch+now};
    if(legacy)await writeFile(path,JSON.stringify(legacy));
    const make=(options={})=>{const store=new ScheduleStore({path,clock:()=>clock.now,...options});stores.push(store);return store;};
    t.after(async()=>{
        for(const store of stores)await store.destroy();
        const child=relative(root,resolve(dir));
        assert.ok(child && !child.startsWith('..') && !isAbsolute(child) && child.startsWith('lz-c6e-identity-'));
        await rm(dir,{recursive:true,force:true});
    });
    return {path,clock,make};
}
async function created(t){
    const f=await fixture(t),store=f.make();await store.initialize();
    assert.equal((await store.insert(live(),0)).ok,true);
    return {...f,store,event:store.getEvent('event')};
}

test('native LIVE receives server identity, v3 envelope, stable fingerprint through restart',async t=>{
    const f=await created(t),event=f.event;
    assert.match(event.incarnationId,/^[a-f0-9-]{36}$/);
    assert.equal(event.entryRevision,1);assert.equal(event.entryMigration,null);
    assert.equal(f.store.getSnapshot().version,3);
    assert.equal(f.store.getSnapshot().liveIdentityMigration,null);
    const bytes=await readFile(f.path,'utf8');
    const reopened=f.make();await reopened.initialize();
    assert.deepEqual(reopened.getEvent('event'),event);
    assert.equal(key(reopened.getEvent('event')),key(event));
    assert.equal(await readFile(f.path,'utf8'),bytes);
});

const cosmeticAndPolicy={
    name:{name:'Cosmetic'},enabled:{enabled:false},priority:{priority:20},
    precheck:{payload:{...live().payload,precheckSeconds:0}},
    fallback:{payload:{...live().payload,unavailableAction:'RADIO'}},
    terminal:{payload:{...live().payload,endAction:'HOLD'}}
};
for(const [name,patch] of Object.entries(cosmeticAndPolicy))test(`${name} edit preserves entryRevision and fingerprint`,async t=>{
    const f=await created(t);
    assert.equal((await f.store.update('event',patch,1)).ok,true);
    assert.equal(f.store.getEvent('event').entryRevision,1);
    assert.equal(key(f.store.getEvent('event')),key(f.event));
});
for(const [name,patch] of Object.entries({START:{startAt:stamp(210000)},END:{endAt:stamp(310000)},source:{payload:{...live().payload,sourceId:'other'}}})) {
    test(`${name} edit and A-B-A use monotonic entryRevision`,async t=>{
        const f=await created(t);
        assert.equal((await f.store.update('event',patch,1)).ok,true);
        const changed=f.store.getEvent('event');
        assert.equal(changed.incarnationId,f.event.incarnationId);assert.equal(changed.entryRevision,2);
        assert.notEqual(key(changed),key(f.event));
        const reverse=Object.fromEntries(Object.keys(patch).map(k=>[k,f.event[k]]));
        assert.equal((await f.store.update('event',reverse,2)).ok,true);
        assert.equal(f.store.getEvent('event').entryRevision,3);
        assert.notEqual(key(f.store.getEvent('event')),key(f.event));
    });
}
test('no-op executable edit does not bump revision; another event cannot rearm LIVE',async t=>{
    const f=await created(t);
    await f.store.update('event',{startAt:f.event.startAt,endAt:f.event.endAt,payload:f.event.payload},1);
    await f.store.insert(overlay,2);await f.store.update('overlay',{priority:50},3);
    assert.equal(key(f.store.getEvent('event')),key(f.event));
    assert.equal(f.store.getEvent('event').entryRevision,1);
});
test('delete/recreate identical event gets a different incarnation',async t=>{
    const f=await created(t);await f.store.delete('event',1);await f.store.insert(live(),2);
    assert.notEqual(f.store.getEvent('event').incarnationId,f.event.incarnationId);
    assert.equal(f.store.getEvent('event').entryRevision,1);
    assert.notEqual(key(f.store.getEvent('event')),key(f.event));
});
for(const field of ['incarnationId','entryRevision','entryMigration'])for(const action of ['insert','update']){
    test(`${action} rejects client injection of ${field}, including roundtripped server values`,async t=>{
        const f=await created(t),before=await readFile(f.path,'utf8');
        const patch={[field]:f.event[field]};
        const result=action==='insert'?await f.store.insert({...live({id:'clone'}),...patch},1):await f.store.update('event',patch,1);
        assert.equal(result.code,'SERVER_OWNED_IDENTITY');assert.equal(await readFile(f.path,'utf8'),before);
    });
}

const legacyEvents=[live({id:'past',startAt:stamp(0),endAt:stamp(50000)}),
    live({id:'end-cutoff',startAt:stamp(0),endAt:stamp(100000)}),
    live({id:'active',startAt:stamp(50000),endAt:stamp(150000)}),
    live({id:'start-cutoff',startAt:stamp(100000),endAt:stamp(150000)}),live({id:'future'}),overlay];
for(const version of [1,2])test(`legacy v${version} mixed file atomically classifies past/active/future, preserves overlays/plan`,async t=>{
    const plan={version:1,timezone:'Europe/Rome',items:[]};
    const f=await fixture(t,{legacy:{version,revision:7,events:legacyEvents,...(version===2?{programPlan:plan}:{})}});
    const store=f.make();await store.initialize();
    const snapshot=store.getSnapshot();assert.equal(snapshot.version,3);assert.equal(snapshot.revision,8);
    assert.deepEqual(snapshot.liveIdentityMigration,{version:1,cutoffAt:stamp(100000)});
    for(const id of ['past','active','end-cutoff','start-cutoff'])assert.equal(store.getEvent(id).entryMigration.disposition,'EXCLUDED');
    assert.equal(store.getEvent('future').entryMigration.disposition,'FUTURE');
    for(const e of snapshot.events.filter(e=>e.type==='source.live')){assert.equal(e.entryRevision,1);assert.match(key(e),/^[a-f0-9]{64}$/);}
    assert.deepEqual(store.getEvent('overlay'),normalizeEvent(overlay));
    if(version===2)assert.deepEqual(snapshot.programPlan,plan);
    const bytes=await readFile(f.path,'utf8');f.clock.now=epoch+400000;
    const reopened=f.make();await reopened.initialize();
    assert.deepEqual(reopened.getSnapshot(),snapshot);assert.equal(await readFile(f.path,'utf8'),bytes);
});

test('legacy exclusion provenance survives executable edits and plan replacement',async t=>{
    const f=await fixture(t,{legacy:{version:1,revision:0,events:[legacyEvents[2]]}}),store=f.make();
    await store.initialize();const origin=store.getEvent('active').entryMigration;
    await store.update('active',{startAt:stamp(200000),endAt:stamp(300000)},1);
    assert.deepEqual(store.getEvent('active').entryMigration,origin);
    assert.equal(store.getEvent('active').entryRevision,2);
    await store.replaceProgramPlan({version:1,timezone:'Europe/Rome',items:[]},2);
    assert.equal(store.getSnapshot().version,3);assert.deepEqual(store.getEvent('active').entryMigration,origin);
});

test('pending migration exposes no schedule, no evaluation and no deadline',async t=>{
    const f=await fixture(t,{legacy:{version:1,revision:0,events:[live()]}});
    const entered=deferred(),resume=deferred();
    const store=f.make({fileOperations:{rename:async(...args)=>{entered.resolve();await resume.promise;return rename(...args);}}});
    const evaluations=[];let timers=0;
    const authority=new ScheduleAuthority({store,clock:()=>f.clock.now,setTimer:()=>++timers,clearTimer:()=>{}});
    t.after(()=>authority.destroy());
    authority.subscribeEvaluation(value=>evaluations.push(value));const pending=authority.start();
    try {await entered.promise;assert.equal(store.getSnapshot(),null);assert.equal(evaluations.length,0);assert.equal(timers,0);}
    finally {resume.resolve();}
    await pending;assert.equal(evaluations.length,1);assert.ok(store.getEvent('event').incarnationId);
});

test('destroy drains in-flight migration before the caller can clean up storage',async t=>{
    const f=await fixture(t,{legacy:{version:1,revision:0,events:[live()]}});
    const entered=deferred(),resume=deferred();
    const store=f.make({fileOperations:{rename:async(...args)=>{entered.resolve();await resume.promise;return rename(...args);}}});
    const initialization=store.initialize();await entered.promise;
    let drained=false;const closing=store.destroy().then(()=>{drained=true;});
    try {await Promise.resolve();assert.equal(drained,false);}finally{resume.resolve();}
    await Promise.all([initialization,closing]);assert.equal(drained,true);
    assert.equal(JSON.parse(await readFile(f.path,'utf8')).version,3);
    assert.equal((await store.insert(live({id:'after-close'}),1)).code,'STORE_CLOSED');
});

for(const stage of ['write','sync','before-replace','after-replace','final-sync'])test(`migration failure at ${stage} is unavailable; restart is safe`,async t=>{
    const f=await fixture(t,{legacy:{version:1,revision:0,events:[live()]}}),original=await readFile(f.path,'utf8');
    const fail=()=>{throw Object.assign(Error('injected'),{code:'EIO'});};
    const store=f.make({fileOperations:{
        open:async(...args)=>{
            const file=await open(...args);
            if(stage==='write' && args[1]==='wx')file.writeFile=async()=>fail();
            if((stage==='sync' && args[1]==='wx') || (stage==='final-sync' && args[1]==='r+'))file.sync=async()=>fail();
            return file;
        },
        rename:async(...args)=>{if(stage==='before-replace')fail();await rename(...args);if(stage==='after-replace')fail();}
    }});
    assert.equal(await store.initialize(),null);assert.equal(store.getStatus().status,'UNAVAILABLE');
    assert.equal((await store.insert(live({id:'other'}),0)).code,'SCHEDULE_UNAVAILABLE');
    const disk=await readFile(f.path,'utf8');
    if(['after-replace','final-sync'].includes(stage))assert.equal(JSON.parse(disk).version,3);
    else assert.equal(disk,original);
    f.clock.now=epoch+250000;const reopened=f.make();await reopened.initialize();
    assert.equal(reopened.getStatus().status,'READY');
    if(['after-replace','final-sync'].includes(stage))assert.equal(await readFile(f.path,'utf8'),disk);
    else assert.equal(reopened.getEvent('event').entryMigration.disposition,'EXCLUDED','retry later must be conservative');
});

test('malformed v3, missing identity and downgrade envelopes fail closed',async t=>{
    const f=await created(t),valid=f.store.getSnapshot();
    const variants=[{...valid,version:4},{...valid,version:1},
        {...valid,events:[live()]},
        {...valid,events:[{...f.event,entryRevision:0}]},
        {...valid,events:[{...f.event,entryMigration:{cutoffAt:stamp(100000),originalStartAt:stamp(0),originalEndAt:stamp(300000),disposition:'FUTURE'}}]}];
    for(const value of variants){assert.throws(()=>normalizeSchedule(value));await writeFile(f.path,JSON.stringify(value));
        const reopened=f.make();assert.equal(await reopened.initialize(),null);
        assert.equal((await reopened.insert(live({id:'new'}),0)).code,'SCHEDULE_UNAVAILABLE');}
});

test('ScheduleRoutes create/update rejects identity injection and supports ordinary UI payloads',async t=>{
    const f=await fixture(t),owner=new SchedulerServer({path:f.path,clock:()=>f.clock.now,setTimer:()=>1,clearTimer:()=>{}});
    const routes=new ScheduleRoutes({owner});t.after(async()=>{routes.close();await owner.close();});await owner.ready;
    async function request(method,suffix,body,revision){
        const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
        req.method=method;req.headers={'content-type':'application/json','if-match':`"schedule-${revision}"`};
        let status,value;
        const res={writeHead(code){status=code;},end(data){value=JSON.parse(data);}};
        await routes.handle(req,res,new URL('http://isolated.test/api/studio/schedule'+suffix));return {status,value};
    }
    assert.equal((await request('POST','/events',{...live(),entryRevision:1},0)).status,422);
    const created=await request('POST','/events',live(),0);assert.equal(created.status,201);
    const event=created.value.schedule.events[0];
    assert.equal((await request('PATCH','/events/event',{incarnationId:event.incarnationId},1)).status,422);
    assert.equal((await request('PATCH','/events/event',{entryRevision:0},1)).status,422);
    assert.equal((await request('POST','/events',{...event,id:'clone'},1)).status,422);
    const edited=await request('PATCH','/events/event',{name:'UI edit',payload:{...event.payload,endAction:'HOLD'}},1);
    assert.equal(edited.status,200);assert.equal(key(edited.value.schedule.events[0]),key(event));
    assert.equal((await request('GET','',undefined,2)).value.runtime.status,'READY');
});

test('actual ScheduledLiveUI submit creates and edits without sending server-owned PATCH fields',async t=>{
    const f=await fixture(t),store=f.make();await store.initialize();
    const dom=new JSDOM('<form></form>'),form=dom.window.document.querySelector('form');
    const previousFormData=globalThis.FormData;
    globalThis.FormData=dom.window.FormData;
    t.after(()=>{globalThis.FormData=previousFormData;dom.window.close();});
    const values={sourceId:'source',name:'UI live',date:'2026-09-29',time:'12:00',durationHours:'0',durationMinutes:'2',precheckMinutes:'3',priority:'10',unavailableAction:'KEEP_PROGRAM',endAction:'RETURN'};
    for(const [name,value] of Object.entries(values)){
        const input=dom.window.document.createElement('input');input.name=name;input.value=value;form.append(input);
    }
    let response,patch;
    const client={state:{schedule:store.getSnapshot()},
        create:async value=>(response=await store.insert(value,store.getSnapshot().revision)),
        update:async(id,value)=>{patch=value;return response=await store.update(id,value,store.getSnapshot().revision);}};
    const ui=new ScheduledLiveUI({store:{writable:true,client},catalog:{getSources:()=>[{id:'source',kind:'hls',enabled:true}]},
        clock:()=>f.clock.now,uuidFactory:()=> 'ui-event'});
    ui.form=form;ui.reset=()=>{};ui.message=()=>{};
    await ui.submit({preventDefault(){}});assert.equal(response.ok,true);
    const original=store.getEvent('live-ui-event');ui.editingId=original.id;
    form.elements.namedItem('name').value='Changed title';
    await ui.submit({preventDefault(){}});assert.equal(response.ok,true);
    for(const field of ['incarnationId','entryRevision','entryMigration','updatedAt','createdAt'])assert.equal(Object.hasOwn(patch,field),false);
    assert.equal(key(store.getEvent(original.id)),key(original));
});

test('invalid edits and entryRevision exhaustion preserve persisted identity',async t=>{
    const f=await created(t);const before=await readFile(f.path,'utf8');
    assert.equal((await f.store.update('event',{endAt:f.event.startAt},1)).ok,false);
    assert.equal(await readFile(f.path,'utf8'),before);
    const snapshot=JSON.parse(before);snapshot.events[0].entryRevision=Number.MAX_SAFE_INTEGER;
    await writeFile(f.path,JSON.stringify(snapshot));const store=f.make();await store.initialize();
    const bytes=await readFile(f.path,'utf8');
    assert.equal((await store.update('event',{endAt:stamp(310000)},1)).code,'ENTRY_REVISION_EXHAUSTED');
    assert.equal(await readFile(f.path,'utf8'),bytes);
});

test('2C6F contract: consumed active version cannot be rearmed; future revision is allowed',async t=>{
    const {harness,START,END,event}=await import('../test-support/ScheduledEntryHarness.js');
    const h=await harness(t);h.fire(START+1);await h.settle();
    assert.equal(h.acceptedLive().length,1);
    const store=h.owner.scheduler.store,previous=store.getEvent(event.id);
    const result=await store.update(event.id,{payload:{...previous.payload,sourceId:'other'}},store.getSnapshot().revision);
    assert.equal(result.code,'ACTIVE_REARM_NOT_ALLOWED');
    assert.deepEqual(store.getEvent(event.id),previous);
    const future=await store.update(event.id,{startAt:new Date(Date.parse(event.startAt)+END).toISOString(),endAt:new Date(Date.parse(event.endAt)+END).toISOString()},store.getSnapshot().revision);
    assert.equal(future.ok,true);
    assert.equal(store.getEvent(event.id).entryRevision,previous.entryRevision+1);
});
