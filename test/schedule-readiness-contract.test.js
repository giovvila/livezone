import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ScheduleStore from '../server/scheduler/ScheduleStore.js';
import {controlledSchedule} from '../server/scheduler/ScheduleContract.js';
import {verifyMigration} from '../server/recovery/RecoveryContract.js';
const cutoff='2026-10-02T12:00:00.000Z';
const live={id:'live',version:1,type:'source.live',enabled:true,startAt:'2099-01-01T00:00:00.000Z',endAt:'2099-01-01T01:00:00.000Z',priority:1,
    payload:{sourceId:'camera',precheckSeconds:0,unavailableAction:'KEEP_PROGRAM',unavailableSceneId:null,endAction:'RETURN',endSceneId:null},createdAt:cutoff,updatedAt:cutoff};
for(const version of [1,2])for(const kind of ['empty','disabled','expired','future'])test(`R14 v${version} ${kind}: presence controls migration and ready contract`,async t=>{
    const dir=await mkdtemp(join(tmpdir(),'lz-r14-schedule-')),path=join(dir,'schedule.json');
    const events=kind==='empty'?[]:[{...live,...(kind==='disabled'?{enabled:false}:{}),...(kind==='expired'?{startAt:'2026-01-01T00:00:00.000Z',endAt:'2026-01-01T01:00:00.000Z'}:{})}];
    const before={version,revision:4,events,...(version===2?{programPlan:{version:1,timezone:'Europe/Rome',items:[]}}:{})};
    await writeFile(path,JSON.stringify(before));const bytes=await readFile(path);
    const store=new ScheduleStore({path,clock:()=>Date.parse(cutoff)});
    t.after(async()=>{await store.destroy();assert.ok(dir.startsWith(join(tmpdir(),'lz-r14-schedule-')));await rm(dir,{recursive:true,force:true});});
    assert.equal(controlledSchedule(before).migrationRequired,kind!=='empty');
    if(kind!=='empty')assert.throws(()=>controlledSchedule(before,{ready:true}),{code:'SCHEDULE_V3_REQUIRED'});
    await store.initialize();const after=store.getSnapshot();assert.equal(verifyMigration(before,after,{earliest:cutoff,latest:cutoff}),true);
    assert.equal(controlledSchedule(after,{ready:true}).migrationRequired,false);
    if(kind==='empty'){assert.deepEqual(await readFile(path),bytes);assert.equal(after.version,version);
        assert.throws(()=>verifyMigration(before,{...before,revision:5}),{code:'SCHEDULE_CHANGED_DURING_START'});
        assert.throws(()=>verifyMigration(before,{...before,version:3,revision:5,liveIdentityMigration:null}),{code:'SCHEDULE_CHANGED_DURING_START'});
    }else{assert.equal(after.version,3);assert.equal(after.revision,5);assert.equal(after.events[0].entryMigration.disposition,kind==='expired'?'EXCLUDED':'FUTURE');}
});
