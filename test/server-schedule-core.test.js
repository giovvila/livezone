import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeSchedule,normalizeEvent,resolveSchedule} from '../server/scheduler/ScheduleContract.js';
import ScheduleStore from '../server/scheduler/ScheduleStore.js';
import ScheduleAuthority,{RECONCILIATION_INTERVAL_MS} from '../server/scheduler/ScheduleAuthority.js';
const epoch=Date.parse('2026-09-12T20:00:00.000Z');
const iso=n=>new Date(epoch+n).toISOString();
const event=(patch={})=>({id:'A',version:1,type:'overlay.sponsor',enabled:true,startAt:iso(0),endAt:iso(20000),priority:10,
    payload:{assetId:'asset-example',position:'top-right',sizePercent:15,opacity:1},createdAt:iso(-10000),updatedAt:iso(-10000),...patch});
const schedule=(events=[],revision=0)=>normalizeSchedule({version:1,revision,events});
const ids=s=>s.activeEvents.map(e=>e.id);
async function harness(t,now=-1000){
    const dir=await mkdtemp(join(tmpdir(),'lz-schedule-'));const path=join(dir,'schedule.json');
    const clock={now:epoch+now};const timers=new Map();let sequence=0;
    const store=new ScheduleStore({path,clock:()=>clock.now});
    const authority=new ScheduleAuthority({store,clock:()=>clock.now,
        setTimer:(fn,delay)=>{timers.set(++sequence,{fn,delay});return sequence;},clearTimer:id=>timers.delete(id)});
    t.after(async()=>{authority.destroy();await store.destroy();await rm(dir,{recursive:true,force:true});});
    await authority.start();
    return {dir,path,store,authority,clock,timers,fire(){const [id,{fn}]=timers.entries().next().value;timers.delete(id);fn();}};
}
for(const [name,now,enabled,expected] of [
    ['future',-1,true,[]],['start',0,true,['A']],['midpoint',10000,true,['A']],
    ['end',20000,true,[]],['expired',20001,true,[]],['disabled',1000,false,[]]])
    test(`pure resolver ${name}`,()=>assert.deepEqual(ids(resolveSchedule(schedule([event({enabled})]),epoch+now)),expected));
test('empty schedule has no deadline',()=>{const s=resolveSchedule(schedule(),epoch);assert.deepEqual(ids(s),[]);assert.equal(s.nextDeadline,null);});
for(const [now,expected] of [[5000,['A']],[12000,['B']],[16000,['A']],[21000,[]]])
    test(`priority overlap at ${now}`,()=>assert.deepEqual(ids(resolveSchedule(schedule([event(),event({id:'B',startAt:iso(10000),endAt:iso(15000),priority:20})]),epoch+now)),expected));
test('tie uses latest start then ASCII stable ID independent of input order',()=>{
    const events=[event({id:'Z',startAt:iso(1000)}),event({id:'B',startAt:iso(1000)}),event()];
    assert.deepEqual(ids(resolveSchedule(schedule(events),epoch+2000)),['B']);
    assert.deepEqual(ids(resolveSchedule(schedule(events.reverse()),epoch+2000)),['B']);
});
test('crawl and sponsor occupy independent logical slots',()=>{
    const crawl=event({id:'C',type:'overlay.crawl',payload:{text:' News ',position:'bottom',direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true}});
    const s=resolveSchedule(schedule([event(),crawl]),epoch);assert.equal(s.activeEvents.length,2);assert.equal(s.activeEvents[0].payload.text,'News');
});
for(const [name,patch] of [['missing ID',{id:undefined}],['future type',{type:'program.scene'}],['timestamp',{startAt:'yesterday'}],
    ['calendar rollover',{startAt:'2026-02-30T20:00:00.000Z'}],['timezone ambiguity',{startAt:'2026-09-12T20:00:00'}],
    ['end before start',{endAt:iso(-1)}],['equal boundaries',{endAt:iso(0)}],['priority',{priority:Infinity}],['payload',{payload:{}}]])
    test(`reject ${name}`,()=>assert.throws(()=>normalizeEvent(event(patch))));
for(const [now,expected] of [[-1,[]],[5000,['A']],[21000,[]]])test(`cold hydration at ${now}`,async t=>{
    const h=await harness(t,now);await h.store.insert(event(),0);h.authority.destroy();
    const store=new ScheduleStore({path:h.path});await store.initialize();
    assert.deepEqual(ids(resolveSchedule(store.getSnapshot(),epoch+now)),expected);
    assert.equal(store.getSnapshot().revision,1);await store.destroy();
});
test('jump forward and backward reconciles without remembered activation',async t=>{
    const h=await harness(t);await h.store.insert(event(),0);
    for(const [now,expected] of [[7000,['A']],[30000,[]],[7000,['A']],[-500,[]]]){
        h.clock.now=epoch+now;h.fire();assert.deepEqual(ids(h.authority.getSnapshot()),expected);assert.equal(h.timers.size,1);
    }
});
test('mutations activate edit disable and delete at current time',async t=>{
    const h=await harness(t,5000);assert.equal((await h.store.insert(event(),0)).ok,true);
    assert.deepEqual(ids(h.authority.getSnapshot()),['A']);
    await h.store.update('A',{startAt:iso(6000)},1);assert.deepEqual(ids(h.authority.getSnapshot()),[]);
    await h.store.update('A',{startAt:iso(0)},2);assert.deepEqual(ids(h.authority.getSnapshot()),['A']);
    await h.store.setEnabled('A',false,3);assert.deepEqual(ids(h.authority.getSnapshot()),[]);
    await h.store.setEnabled('A',true,4);await h.store.delete('A',5);assert.deepEqual(ids(h.authority.getSnapshot()),[]);
    assert.equal(h.store.getEvent('A'),null);
});
test('future edit and priority mutation replace deadline/winner',async t=>{
    const h=await harness(t,-1000);await h.store.insert(event(),0);await h.store.update('A',{startAt:iso(2000)},1);
    assert.equal(h.authority.getSnapshot().nextDeadline,epoch+2000);
    h.clock.now=epoch+3000;h.fire();await h.store.insert(event({id:'B',priority:0}),2);
    await h.store.update('B',{priority:30},3);assert.deepEqual(ids(h.authority.getSnapshot()),['B']);
});
test('concurrent same-revision writes cannot silently overwrite',async t=>{
    const h=await harness(t);const r=await Promise.all([h.store.insert(event(),0),h.store.insert(event({id:'B'}),0)]);
    assert.equal(r.filter(x=>x.ok).length,1);assert.equal(r.find(x=>!x.ok).code,'REVISION_CONFLICT');assert.equal(h.store.listEvents().length,1);
});
test('duplicate ID and invalid write preserve revision and bytes',async t=>{
    const h=await harness(t);await h.store.insert(event(),0);const before=await readFile(h.path,'utf8');
    assert.equal((await h.store.insert(event(),1)).code,'DUPLICATE_ID');
    assert.equal((await h.store.update('A',{endAt:iso(-1)},1)).ok,false);
    assert.equal(await readFile(h.path,'utf8'),before);assert.equal(h.store.getSnapshot().revision,1);
});
test('corruption is preserved and mutations fail closed',async t=>{
    const h=await harness(t);await writeFile(h.path,'{invalid');const store=new ScheduleStore({path:h.path});
    assert.equal(await store.initialize(),null);assert.equal(store.getStatus().status,'UNAVAILABLE');
    assert.equal((await store.insert(event(),0)).code,'SCHEDULE_UNAVAILABLE');assert.equal(await readFile(h.path,'utf8'),'{invalid');await store.destroy();
});
test('missing persistence remains absent until explicit mutation',async t=>{
    const h=await harness(t);assert.deepEqual(await readdir(h.dir),[]);assert.equal(h.store.getSnapshot().revision,0);
});
test('atomic rename failure keeps original disk and in-memory state',async t=>{
    const h=await harness(t);await h.store.insert(event(),0);const before=await readFile(h.path,'utf8');
    h.store.fs.rename=async()=>{throw new Error('disk failure');};
    assert.equal((await h.store.delete('A',1)).code,'PERSISTENCE_FAILED');assert.equal(h.store.getSnapshot().revision,1);
    assert.equal(await readFile(h.path,'utf8'),before);assert.deepEqual(await readdir(h.dir),['schedule.json']);
});
test('atomic write flushes and closes before rename and notification',async t=>{
    const h=await harness(t);const seen=[],open=h.store.fs.open,rename=h.store.fs.rename;
    h.store.fs.open=async(...a)=>{const f=await open(...a);return {writeFile:async(...x)=>{seen.push('write');await f.writeFile(...x);},sync:async()=>{seen.push('sync');await f.sync();},close:async()=>{seen.push('close');await f.close();}};};
    h.store.fs.rename=async(...a)=>{seen.push('rename');await rename(...a);};h.store.subscribe(()=>seen.push('notify'));
    await h.store.insert(event(),0);assert.deepEqual(seen,['write','sync','close','rename','notify']);
});
test('next deadline includes all enabled boundaries',()=>{
    const s=schedule([event(),event({id:'B',startAt:iso(10000),endAt:iso(15000),priority:20})]);
    for(const [now,next] of [[-1,0],[0,10000],[12000,15000],[16000,20000],[21000,null]])
        assert.equal(resolveSchedule(s,epoch+now).nextDeadline,next===null?null:epoch+next);
});
test('missed deadline converges with one bounded timer and no repeated publications',async t=>{
    const h=await harness(t);let changes=0;h.authority.subscribe(()=>changes++);await h.store.insert(event(),0);
    assert.equal([...h.timers.values()][0].delay,RECONCILIATION_INTERVAL_MS);
    h.clock.now=epoch+7000;h.fire();assert.deepEqual(ids(h.authority.getSnapshot()),['A']);
    for(let n=0;n<10;n++){h.clock.now++;h.fire();}assert.equal(changes,1);assert.equal(h.timers.size,1);
});
test('stop destroys timer/subscription and rejects stale callbacks; restart works',async t=>{
    const h=await harness(t);await h.store.insert(event(),0);const stale=[...h.timers.values()][0].fn;
    h.authority.stop();assert.equal(h.timers.size,0);assert.equal(h.store.listeners.size,0);
    h.clock.now=epoch+5000;stale();assert.equal(h.timers.size,0);
    await h.authority.start();assert.deepEqual(ids(h.authority.getSnapshot()),['A']);assert.equal(h.timers.size,1);
});
test('stop while hydration pending cannot arm a timer',async()=>{
    let finish;const store={initialize:()=>new Promise(r=>finish=r),subscribe:()=>{throw Error('late subscribe');}};
    const a=new ScheduleAuthority({store});const p=a.start();a.stop();finish();await p;assert.equal(a.timer,null);
});
test('diagnostics are bounded and never contain payload text or asset IDs',async t=>{
    const h=await harness(t);await h.store.insert(event(),0);for(let i=0;i<300;i++)h.authority.reconcile();
    assert.ok(h.authority.diagnostics.snapshot().length<=100);
    assert.ok(!JSON.stringify(h.authority.diagnostics.snapshot()).includes('asset-example'));
});
test('malformed insert is rejected without throwing or writing',async t=>{
    const h=await harness(t);for(const input of [null,undefined,{},[],42]){
        assert.equal((await h.store.insert(input,0)).ok,false);
    }assert.equal(h.store.getSnapshot().revision,0);assert.deepEqual(await readdir(h.dir),[]);
});
test('caller mutation cannot alter a queued event',async t=>{
    const h=await harness(t);const e=event();const pending=h.store.insert(e,0);e.payload.opacity=0;e.id='changed';
    assert.equal((await pending).ok,true);assert.equal(h.store.getEvent('A').payload.opacity,1);
});
test('unknown schema and duplicate persisted IDs fail closed without boot rewrite',async t=>{
    const h=await harness(t);for(const data of [{version:2,revision:1,events:[]},{version:1,revision:1,events:[event(),event()]}]){
        const raw=JSON.stringify(data);await writeFile(h.path,raw);const s=new ScheduleStore({path:h.path});
        assert.equal(await s.initialize(),null);assert.equal(await readFile(h.path,'utf8'),raw);await s.destroy();
    }
});
test('observer failure cannot roll back persistence or leave multiple timers',async t=>{
    const h=await harness(t,1000);h.store.subscribe(()=>{throw Error('observer');});
    h.authority.subscribe(()=>{throw Error('observer');});assert.equal((await h.store.insert(event(),0)).ok,true);
    assert.equal(JSON.parse(await readFile(h.path,'utf8')).revision,1);assert.equal(h.timers.size,1);
});
test('destroy drains accepted writes and rejects later mutations',async t=>{
    const h=await harness(t);const p=h.store.insert(event(),0);await h.store.destroy();assert.equal((await p).ok,true);
    assert.equal((await h.store.delete('A',1)).code,'STORE_CLOSED');
});
