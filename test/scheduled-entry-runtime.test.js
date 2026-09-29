import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdtemp,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {harness,START,END,event} from '../test-support/ScheduledEntryHarness.js';
import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';
import {scheduledLiveProgramIdentity} from '../server/scheduler/ScheduledLiveProgramIdentity.js';
import {initializeEntryLedger} from '../server/scheduler/ScheduledEntryRuntime.js';
const count=h=>h.owner.scheduledEntry.ledger.snapshot?.entries.length??0;
const epoch=Date.parse(event.startAt)-START;
const stamp=n=>new Date(epoch+n).toISOString();

for(const offset of [START,START+1,START+20,START+1000,END-1,END,END+1]){
    test(`C6F repeated timer/health evaluations at ${offset-START}ms: exactly one entry inside [START,END)`,async t=>{
        const h=await harness(t);h.fire(offset);await h.settle();
        for(let i=0;i<30;i++){h.owner.scheduler.runtime.reconcile();h.health({});await h.settle();}
        const expected=offset<END?1:0;
        assert.equal(count(h),expected);assert.equal(h.captures.length,expected);assert.equal(h.acceptedLive().length,expected);
        assert.ok(h.owner.scheduledEntry.diagnostics().length<20,'stable decisions do not log every callback');
        if(expected){
            const identity=identityForScheduledEvent(h.owner.scheduler.store.getEvent(event.id));
            const results=await Promise.all(Array.from({length:8},()=>h.owner.scheduledEntry.ledger.consume(identity,{
                consumedAt:stamp(offset),authorityEpoch:1,authorityProcessSession:'retry'})));
            assert.ok(results.every(r=>r.status==='ALREADY_CONSUMED'));assert.equal(count(h),1);
        }
    });
}

test('C6F durable consumption at END-1 cannot commit LIVE after END',async t=>{
    const h=await harness(t);const hold=h.holdPreroll();h.fire(END-1);await hold.entered;
    assert.equal(count(h),1);h.advance(END);hold.release();await h.settle();
    assert.equal(h.acceptedLive().length,0);await h.unchanged();assert.equal(count(h),1);
});

for(const phase of ['before-replace','durable']){
    for(const fence of ['manual','end','authority','descriptor']){
        test(`C6F ${fence} changes at ledger ${phase}`,async t=>{
            let h,armed=false,finish;
            h=await harness(t,{serverOptions:{scheduledEntryLedgerOptions:{hook(stage){
                if(!armed||stage!==phase)return;armed=false;
                if(fence==='manual')finish=h.owner.scheduledLiveExecution.reconciliation.beginManualIntent();
                if(fence==='end')h.advance(END);
                if(fence==='authority')h.owner.executionOwnership.restartBlocked=true;
                if(fence==='descriptor')h.owner.liveAutomation.resolveSource=()=>({descriptor:{fingerprint:'changed'}});
            }}}});
            armed=true;h.fire(START+20);await h.settle();finish?.();
            assert.equal(count(h),phase==='durable'?1:0);assert.equal(h.owner.scheduledEntry.ledger.status,'READY');assert.equal(h.captures.length,0);
            assert.equal(h.acceptedLive().length,0);await h.unchanged();
            if(fence==='manual')await h.manual();
        });
    }
}

for(const patch of [{state:'OFFLINE'},{freshness:'STALE'},{validUntil:epoch+START},
    {playlistProgressing:false},{segmentReachable:false},{sourceId:'stale-source'},{sourceFingerprint:'stale-descriptor'}]){
    test(`C6F health ${JSON.stringify(patch)} never consumes`,async t=>{
        const h=await harness(t);h.health(patch);h.fire(START+1);await h.settle();
        assert.equal(count(h),0);assert.equal(h.captures.length,0);await h.unchanged();
    });
}
test('C6F health becoming ready after START permits first eligible late entry',async t=>{
    const h=await harness(t,{ready:false});h.fire(START+1);await h.settle();assert.equal(count(h),0);
    h.advance(START+20);h.health({state:'ONLINE',freshness:'FRESH',playlistProgressing:true,segmentReachable:true});
    await h.settle();assert.equal(count(h),1);assert.equal(h.acceptedLive().length,1);
});
for(const change of ['disabled','deleted','superseded']){
    test(`C6F ${change} event is not consumed`,async t=>{
        const h=await harness(t);const store=h.owner.scheduler.store,rev=store.getSnapshot().revision;
        if(change==='disabled')assert.equal((await store.setEnabled(event.id,false,rev)).ok,true);
        if(change==='deleted')assert.equal((await store.delete(event.id,rev)).ok,true);
        if(change==='superseded')assert.equal((await store.insert({...event,id:'winner',priority:99},rev)).ok,true);
        h.fire(START+1000);await h.settle();
        assert.equal(h.owner.scheduledEntry.ledger.snapshot.entries.filter(r=>r.identity.eventId===event.id).length,0);
        assert.equal(h.captures.filter(c=>c.input.eventId===event.id).length,0);
    });
}

test('C6F legacy FUTURE uses persisted classification and normal pipeline',async t=>{
    const h=await harness(t,{beforeBoot:async({schedulePath})=>writeFile(schedulePath,JSON.stringify({version:1,revision:1,events:[event]}))});
    assert.equal(h.owner.scheduler.store.getEvent(event.id).entryMigration.disposition,'FUTURE');
    h.fire(START+1000);await h.settle();assert.equal(h.acceptedLive().length,1);
});
test('C6F legacy EXCLUDED stays excluded after a future edit and restart',async t=>{
    const h=await harness(t,{beforeBoot:async({schedulePath})=>writeFile(schedulePath,JSON.stringify({version:1,revision:1,events:[{...event,startAt:stamp(0)}]}))});
    const store=h.owner.scheduler.store;
    assert.equal(store.getEvent(event.id).entryMigration.disposition,'EXCLUDED');
    assert.equal((await store.update(event.id,{startAt:event.startAt},store.getSnapshot().revision)).ok,true);
    h.fire(START+1);await h.settle();assert.equal(count(h),0);await h.restart(START+20);
    h.owner.executionOwnership.restartBlocked=false;h.owner.scheduler.runtime.reconcile();await h.settle();
    assert.equal(count(h),0);assert.equal(h.captures.length,0);
});

for(const stage of ['consumed','captured','committed','aborted','completed']){
    test(`C6F restart after ${stage} cannot replay, even after restart fence is cleared`,async t=>{
        let h,armed=false,finish;
        h=await harness(t,{serverOptions:{scheduledEntryLedgerOptions:{hook(phase){
            if(armed&&stage==='consumed'&&phase==='durable'){
                armed=false;finish=h.owner.scheduledLiveExecution.reconciliation.beginManualIntent();
            }
        }}}});
        armed=true;
        const hold=['captured','aborted'].includes(stage)?h.holdPreroll():null;
        h.fire(START+1);
        if(hold){
            await hold.entered;
            if(stage==='aborted'){
                finish=h.owner.scheduledLiveExecution.reconciliation.beginManualIntent();
                const aborted=h.owner.scheduledLiveOwnership.transition('begin-live');
                assert.equal(aborted.state,'ABORTED');await h.owner.scheduledLivePersistence.persist(aborted);
            }else h.owner.scheduledLiveOwnership.release(event.id);
            hold.release();
        }
        await h.settle();finish?.();assert.equal(count(h),1);
        if(stage==='completed'){h.fire(END+3001);await h.settle();}
        const captures=h.captures.length,commits=h.acceptedLive().length;
        await h.restart(stage==='completed'?END+4000:START+1000);
        await h.owner.autoLive.store.patch({enabled:true,armed:true,sourceId:'source'},h.owner.autoLive.store.getSnapshot().revision);
        const reconciliation=h.owner.scheduledLiveExecution.reconciliation;
        const binding={ownerInstanceId:'reconciled-browser',publisherSessionId:'reconciled-publisher'};
        const prepared=reconciliation.execute({...binding,operation:'prepare-reconciliation'},'operator');
        reconciliation.execute({...binding,...prepared,operation:'reconcile'},'operator');
        assert.equal(h.owner.executionOwnership.restartBlocked,false);
        for(let i=0;i<3;i++){h.owner.scheduler.runtime.reconcile();await h.settle();}
        assert.equal(count(h),1);assert.equal(h.captures.length,captures);assert.equal(h.acceptedLive().length,commits);
    });
}

test('C6F a legitimate future revision gets a distinct publisher and may enter once',async t=>{
    const h=await harness(t);h.fire(START+1);await h.settle();const first=h.owner.store.getCurrent().publisherSessionId;
    await h.manual();
    const store=h.owner.scheduler.store;
    assert.equal((await store.update(event.id,{startAt:stamp(START+2000),endAt:stamp(END+2000)},store.getSnapshot().revision)).ok,true);
    h.fire(START+2001);await h.settle();
    assert.equal(h.acceptedLive().length,2);assert.equal(count(h),2);
    assert.notEqual(h.owner.store.getCurrent().publisherSessionId,first);
    const identity=identityForScheduledEvent(store.getEvent(event.id));
    assert.equal(h.owner.store.getCurrent().publisherSessionId,scheduledLiveProgramIdentity({...identity,revision:1}).publisherSessionId);
    await h.restart(START+3000);assert.equal(h.owner.store.getCurrent().publisherSessionId,scheduledLiveProgramIdentity({...identity,revision:1}).publisherSessionId);
});

for(const failure of ['corruption','lock','missing-after-bootstrap','uncertain']){
    test(`C6F ${failure} blocks Scheduled only; manual PROGRAM remains available`,async t=>{
        let armed=false;
        const h=await harness(t,{serverOptions:{scheduledEntryLedgerOptions:{hook(stage){if(armed&&failure==='uncertain'&&stage==='replaced')throw Error('uncertain');}}},
            beforeBoot:async({studioStatePath})=>{
                const path=studioStatePath+'.scheduled-entry-ledger.json';
                if(failure==='corruption')await writeFile(path,'corrupt');
                if(failure==='lock')await writeFile(path+'.lock','other owner');
                if(failure==='missing-after-bootstrap')await writeFile(path+'.bootstrap','reserved');
            }});
        armed=true;h.fire(START+1);await h.settle();assert.equal(h.captures.length,0);
        assert.notEqual(h.owner.scheduledEntry.ledger.status,'READY');await h.unchanged();await h.manual();
        assert.equal(h.owner.store.getCurrent().publisherSessionId,'manual-newer');
    });
}

for(const scenario of ['fresh','upgrade-explicit','upgrade-implicit','native-history','incomplete-migration','journal-unavailable','lost-ledger']){
    test(`C6F bootstrap policy: ${scenario}`,async t=>{
        const dir=await mkdtemp(join(tmpdir(),'lz-c6f-bootstrap-'));const path=join(dir,'ledger.json');
        let ledger;
        t.after(async()=>{await ledger?.close();const child=relative(resolve(tmpdir()),resolve(dir));assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));await rm(dir,{recursive:true,force:true});});
        const options={path,ownership:{available:true,authorityEpoch:scenario==='fresh'?1:2},
            startupSchedule:{events:[]},executionRepository:{status:'READY',record:null},bootstrap:scenario==='upgrade-explicit'};
        if(scenario==='native-history'){
            options.ownership.authorityEpoch=1;
            options.startupSchedule.events=[{...event,incarnationId:'11111111-1111-4111-8111-111111111111',entryRevision:1,entryMigration:null}];
        }
        if(scenario==='incomplete-migration')options.startupSchedule=null;
        if(scenario==='journal-unavailable')options.executionRepository.status='UNAVAILABLE';
        if(scenario==='lost-ledger'){
            options.ownership.authorityEpoch=1;ledger=await initializeEntryLedger(options);await ledger.close();await unlink(path);options.bootstrap=true;
        }
        ledger=await initializeEntryLedger(options);
        assert.equal(ledger.status,['fresh','upgrade-explicit'].includes(scenario)?'READY':'UNAVAILABLE');
    });
}

for(const fence of ['end','manual','descriptor','health']){
    test('C6F '+fence+' fence during final PROGRAM staging preserves consumed entry without LIVE commit',async t=>{
        const h=await harness(t);let finish;
        h.owner.durableProgram.hook=phase=>{
            if(phase!=='staged')return;
            if(fence==='end')h.advance(END);
            if(fence==='manual')finish=h.owner.scheduledLiveExecution.reconciliation.beginManualIntent();
            if(fence==='descriptor')h.owner.liveAutomation.resolveSource=()=>({descriptor:{fingerprint:'changed'}});
            if(fence==='health')h.health({state:'OFFLINE'});
        };
        h.fire(END-1);await h.settle();finish?.();h.owner.durableProgram.hook=()=>{};
        assert.equal(count(h),1);assert.equal(h.captures.length,1);assert.equal(h.acceptedLive().length,0);await h.unchanged();
    });
}
test('C6F publisher namespace preserves legacy and separates event/version/incarnation/source/window',async t=>{
    const h=await harness(t);const original=h.owner.scheduler.store.getEvent(event.id);
    const variants=[original,{...original,id:'another-event'},{...original,entryRevision:2},
        {...original,incarnationId:'22222222-2222-4222-8222-222222222222'},
        {...original,payload:{...original.payload,sourceId:'other'}},
        {...original,startAt:stamp(START+1)},{...original,endAt:stamp(END+1)}];
    const publishers=variants.map(e=>scheduledLiveProgramIdentity({...identityForScheduledEvent(e),revision:1}).publisherSessionId);
    assert.equal(new Set(publishers).size,variants.length);
    assert.equal(scheduledLiveProgramIdentity({eventId:event.id,revision:1}).publisherSessionId,'scheduled:'+event.id);
});

test('C6F ledger deleted after initialization is never recreated by a callback',async t=>{
    const h=await harness(t);await unlink(h.owner.scheduledEntry.ledger.path);
    h.fire(START+1);await h.settle();assert.equal(h.captures.length,0);
    assert.equal(h.owner.scheduledEntry.ledger.status,'UNAVAILABLE');
    await assert.rejects(readFile(h.owner.scheduledEntry.ledger.path),{code:'ENOENT'});await h.manual();
});
