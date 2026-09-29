import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {harness,START,event} from '../test-support/ScheduledEntryHarness.js';

for(const field of ['startAt','endAt','source'])test(`C6F consumed active ${field} edit cannot rearm`,async t=>{
    const h=await harness(t);h.fire(START+20);await h.settle();
    const store=h.owner.scheduler.store,previous=store.getEvent(event.id);
    const patch=field==='source'?{payload:{...previous.payload,sourceId:'other'}}:
        {[field]:new Date(Date.parse(previous[field])+(field==='startAt'?1:1000)).toISOString()};
    const bytes=await readFile(store.path,'utf8');
    assert.equal((await store.update(event.id,patch,store.getSnapshot().revision)).code,'ACTIVE_REARM_NOT_ALLOWED');
    assert.equal(await readFile(store.path,'utf8'),bytes);
    h.fire(START+2000);await h.settle();assert.equal(h.acceptedLive().length,1);
});

test('C6F cosmetic and policy edits never create a second entry',async t=>{
    const h=await harness(t);h.fire(START+1);await h.settle();
    const store=h.owner.scheduler.store,previous=store.getEvent(event.id);
    for(const patch of [{name:'Edited title'},{priority:20},{enabled:false},{enabled:true},
        {payload:{...previous.payload,endAction:'HOLD'}}]){
        assert.equal((await store.update(event.id,patch,store.getSnapshot().revision)).ok,true);
        h.owner.scheduler.runtime.reconcile();await h.settle();
    }
    assert.equal(store.getEvent(event.id).entryRevision,previous.entryRevision);
    assert.equal(h.owner.scheduledEntry.ledger.snapshot.entries.length,1);
    assert.equal(h.acceptedLive().length,1);
});

for(const phase of ['before','after'])test(`C6F manual intent ${phase} synchronous capture fences LIVE`,async t=>{
    const h=await harness(t);let finish;
    const original=h.owner.scheduledLiveOwnership.capture.bind(h.owner.scheduledLiveOwnership);
    h.owner.scheduledLiveOwnership.capture=input=>{
        if(phase==='before')finish=h.owner.scheduledLiveExecution.reconciliation.beginManualIntent();
        const result=original(input);
        if(phase==='after')finish=h.owner.scheduledLiveExecution.reconciliation.beginManualIntent();
        return result;
    };
    h.fire(START+1);await h.settle();finish?.();
    assert.equal(h.owner.scheduledEntry.ledger.snapshot.entries.length,1);
    assert.equal(h.acceptedLive().length,0);await h.unchanged();
    const newer=await h.manual();h.fire(START+2000);await h.settle();await h.unchanged(newer);
});

test('C6F diagnostics reconstruct one consumed entry and remain bounded',async t=>{
    const h=await harness(t);h.fire(START+20);await h.settle();
    const records=h.owner.scheduledEntry.diagnostics();
    const consumed=records.find(r=>r.decision==='CONSUMED');
    assert.ok(consumed?.consumptionId);assert.match(consumed.entryKey,/^[a-f0-9]{64}$/);
    for(const decision of ['CANDIDATE','CAPTURE','TRANSITION','PROGRAM_COMMIT']){
        const record=records.find(r=>r.decision===decision);
        assert.equal(record.eventId,event.id);assert.ok(Number.isFinite(record.at));
        assert.ok(record.entryKey===consumed.entryKey||record.consumptionId===consumed.consumptionId);
    }
    assert.equal(records.find(r=>r.decision==='CAPTURE').accepted,true);
    assert.equal(records.find(r=>r.decision==='PROGRAM_COMMIT').accepted,true);
    const entry=h.owner.scheduledEntry;
    for(let i=0;i<600;i++)entry.record({id:'diagnostic-'+i},'TEST',{sequence:i});
    assert.equal(entry.diagnostics().length,200);assert.equal(entry.decisions.size,500);
});

test('C6F close during ledger staging drains work and releases the isolated lock',async t=>{
    let h,armed=false;
    h=await harness(t,{serverOptions:{scheduledEntryLedgerOptions:{hook(phase){
        if(armed&&phase==='staged'){armed=false;h.owner.scheduledEntry.close();}
    }}}});
    armed=true;h.fire(START+1);await h.settle();
    assert.equal(h.owner.scheduledEntry.ledger.snapshot.entries.length,0);
    assert.equal(h.captures.length,0);assert.equal(h.acceptedLive().length,0);
    const ledger=h.owner.scheduledEntry.ledger;
    await new Promise(resolve=>h.owner.server.close(resolve));
    await assert.rejects(access(ledger.path+'.lock'),{code:'ENOENT'});
});

test('C6F changing a captured LIVE event to an overlay revokes its entry ticket',async t=>{
    const h=await harness(t);h.fire(START+1);await h.settle();
    const installed=h.owner.store.getCurrent(),bytes=await readFile(h.path,'utf8');
    const store=h.owner.scheduler.store;
    const result=await store.update(event.id,{type:'overlay.crawl',payload:{text:'News',position:'bottom',
        direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true}},store.getSnapshot().revision);
    assert.equal(result.ok,true);
    h.owner.scheduler.runtime.reconcile();await h.settle();
    assert.equal(h.owner.scheduledLiveOwnership.transaction(),null);
    assert.equal(h.owner.scheduledEntry.tickets.has(event.id),false);
    assert.equal(h.owner.scheduledEntry.ledger.snapshot.entries.length,1);
    await h.unchanged(installed,bytes);
});
