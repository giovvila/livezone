import test from 'node:test';
import assert from 'node:assert/strict';
import Registry from '../server/autolive/AutoLiveHealthRegistry.js';
import Coordinator from '../server/scheduler/LiveAutomationCoordinator.js';
import Entry from '../server/scheduler/ScheduledEntryRuntime.js';
import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';
import sourceManager from '../public/js/studio/StudioSourceManager.js';
import {managedFixture} from '../test-support/ManagedHealthFixture.js';
import {harness,START,END,event as scheduledEvent} from '../test-support/ScheduledEntryHarness.js';

// 2C6G characterized HEALTH_BLOCKED even with an ONLINE publisher. 2C6H must
// reach the unchanged gate through two actual transport observations.
// Only the MediaMTX HTTP boundary is substituted; no health values are injected.
test('managed transport progression satisfies late Scheduled transport gate', async t => {
    const {config,client,http,state}=managedFixture();
    const now = Date.parse('2026-09-30T16:30:23.426Z');
    const source = {id:'fixture-live',kind:'hls',enabled:true,url:config.playbackHlsUrl};
    const event = {
        id:'fixture-event',version:1,type:'source.live',enabled:true,priority:10,
        startAt:'2026-09-30T16:29:13.000Z',endAt:'2026-09-30T16:32:13.000Z',
        createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),
        incarnationId:'060ba5ab-0983-4c13-9c79-bbd248598f9c',entryRevision:1,entryMigration:null,
        payload:{sourceId:source.id,precheckSeconds:180,unavailableAction:'KEEP_PROGRAM',
            unavailableSceneId:null,endAction:'RETURN',endSceneId:null}
    };
    const preview = new sourceManager.constructor();
    preview.initialize({});
    preview.registerSource(source);
    assert.equal(preview.getSource(source.id).url,source.url);
    const registry = new Registry({managedClient:client,managedTransportHttp:http,clock:()=>now,setTimer:()=>0,clearTimer:()=>{}});
    t.after(()=>registry.close());
    const schedule = {version:3,revision:1,events:[event],liveIdentityMigration:null};
    const scheduler = {available:()=>true,store:{getSnapshot:()=>schedule,getEvent:()=>event},
        runtime:{getSnapshot:()=>({activeEvents:[event]}),subscribeEvaluation:()=>()=>{}}};
    const automation = new Coordinator({scheduler,healthRegistry:registry,
        catalog:()=>({sources:[source]}),managedConfig:config,clock:()=>now});
    t.after(()=>automation.close());
    await automation.start();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(automation.health.authority,'managed-ingest');
    assert.equal(automation.health.state,'UNCERTAIN');
    assert.equal(automation.health.reason,'PLAYLIST_FIRST_OBSERVATION');
    assert.equal(automation.health.playlistProgressing,null);
    assert.equal(automation.health.segmentReachable,true);
    assert.equal(automation.getSnapshot().healthStatus,'UNCERTAIN');
    assert.deepEqual(state.calls,['/v3/paths/list','/camera/index.m3u8','/camera/segment-10.mp4']);
    const entry = new Entry({scheduler,automation,clock:()=>now,
        ready:Promise.resolve({status:'READY'}),ownership:{available:true,authorityEpoch:1,authorityProcessSession:'fixture'},
        reconciliation:{manualIntentRevision:0},scheduledOwnership:{transaction:()=>null},mutations:{}});
    t.after(()=>entry.close());
    await entry.ready;
    const ticket={...identityForScheduledEvent(event),eventId:event.id,authorityEpoch:1,
        authorityProcessSession:'fixture',manualIntentRevision:0,
        sourceFingerprint:automation.resolveSource(event).descriptor.fingerprint};
    assert.equal(entry.gate(ticket,{capture:true}),'HEALTH_BLOCKED');
    state.sequence++;
    await registry.poll([...registry.entries.values()][0]);
    assert.equal(automation.health.reason,'TRANSPORT_READY');
    assert.equal(automation.getSnapshot().healthStatus,'TRANSPORT_READY');
    assert.equal(entry.gate(ticket,{capture:true}),null);
});

async function integrated(t,{late=true,beforeBoot}={}){
    const f=managedFixture();let h;
    const epoch=Date.parse(scheduledEvent.startAt)-START;
    const registry=new Registry({managedClient:f.client,managedTransportHttp:f.http,
        clock:()=>h?.owner.liveAutomation.clock()??epoch,setTimer:()=>0,clearTimer:()=>{}});
    t.after(()=>registry.close());
    h=await harness(t,{ready:false,sourceUrl:f.config.playbackHlsUrl,beforeBoot,
        serverOptions:{autoLiveHealthRegistry:registry,mediaIngestConfig:f.config,mediaIngestStatusClient:f.client}});
    await new Promise(setImmediate);await h.settle();
    if(late){
        const store=h.owner.scheduler.store;
        assert.equal((await store.delete(scheduledEvent.id,store.getSnapshot().revision)).ok,true);
        h.fire(START+70000);await h.settle();
        const createdAt=new Date(epoch+START+70000).toISOString();
        assert.equal((await store.insert({...scheduledEvent,id:'late-managed-created',createdAt,updatedAt:createdAt},store.getSnapshot().revision)).ok,true);
        await new Promise(setImmediate);await h.settle();
        // Deliver the first due health poll at the new clock. Precheck evidence
        // from before the jump is expired and cannot establish progression.
        for(const entry of registry.entries.values())await registry.poll(entry);
        await h.settle();
    }
    const poll=async({advance=true}={})=>{
        if(advance)f.state.sequence++;
        for(const entry of registry.entries.values())await registry.poll(entry);
        await h.settle();
    };
    return {...f,h,registry,poll,eventId:late?'late-managed-created':scheduledEvent.id,
        count:()=>h.owner.scheduledEntry.ledger.snapshot.entries.length};
}

test('late-created managed event: HEALTH_BLOCKED -> READY -> durable consume before capture exactly once, restart no replay',async t=>{
    const f=await integrated(t);const {h}=f;
    assert.equal(f.count(),0);assert.equal(h.owner.liveAutomation.health.reason,'PLAYLIST_FIRST_OBSERVATION');
    assert.ok(h.owner.scheduledEntry.diagnostics().some(e=>e.decision==='HEALTH_BLOCKED'&&e.healthReason==='PLAYLIST_FIRST_OBSERVATION'));
    await f.poll();assert.equal(f.count(),1);assert.equal(h.acceptedLive().length,1);
    const history=h.owner.scheduledEntry.diagnostics();
    assert.ok(history.findIndex(e=>e.decision==='CONSUMED')<history.findIndex(e=>e.decision==='CAPTURE'));
    for(let i=0;i<5;i++)await f.poll();assert.equal(f.count(),1);assert.equal(h.captures.length,1);
    await h.restart(START+71000);await new Promise(setImmediate);await h.clearRestart();await f.poll();await f.poll();
    assert.equal(f.count(),1);assert.equal(h.captures.length,1);assert.equal(h.acceptedLive().length,1);
});

test('existing transport history permits first eligible evaluation after START',async t=>{
    const f=await integrated(t,{late:false});await f.poll();await f.poll();
    assert.equal(f.h.owner.liveAutomation.getSnapshot().healthStatus,'TRANSPORT_READY');
    assert.equal(f.count(),0);f.h.fire(START+1);await f.h.settle();
    assert.equal(f.count(),1);assert.equal(f.h.acceptedLive().length,1);
});

for(const fence of ['never-ready','end','manual','wrong-source','wrong-fingerprint'])test('managed integration preserves '+fence+' fence',async t=>{
    const f=await integrated(t);let finish;
    if(fence==='end')f.h.advance(END);
    if(fence==='manual')finish=f.h.owner.scheduledLiveExecution.reconciliation.beginManualIntent();
    if(fence==='wrong-source'||fence==='wrong-fingerprint'){
        // Wrong health comes from another real producer lease, never a fabricated READY value.
        const descriptor=f.h.owner.liveAutomation.resolveSource(f.h.owner.scheduler.store.getEvent(f.eventId)).descriptor;
        const wrong={...descriptor,...(fence==='wrong-source'?{sourceId:'other'}:{fingerprint:'a'.repeat(64)})};
        const lease=f.registry.acquire(wrong,()=>{});await new Promise(setImmediate);
        f.state.sequence++;await f.registry.poll([...f.registry.entries.values()].find(e=>e.source===wrong));
        f.h.owner.liveAutomation.health=lease.getSnapshot();
        f.h.owner.liveAutomation.evaluate();await f.h.settle();lease.release();
    }else await f.poll({advance:fence!=='never-ready'});
    finish?.();assert.equal(f.count(),0);assert.equal(f.h.captures.length,0);await f.h.unchanged();
});

test('managed transport READY never re-enables a migrated EXCLUDED event',async t=>{
    const {writeFile}=await import('node:fs/promises');
    const f=await integrated(t,{late:false,beforeBoot:async({schedulePath})=>writeFile(schedulePath,JSON.stringify({
        version:1,revision:1,events:[{...scheduledEvent,startAt:new Date(Date.parse(scheduledEvent.startAt)-START).toISOString()}]}))});
    const store=f.h.owner.scheduler.store;
    assert.equal(store.getEvent(scheduledEvent.id).entryMigration.disposition,'EXCLUDED');
    assert.equal((await store.update(scheduledEvent.id,{startAt:scheduledEvent.startAt},store.getSnapshot().revision)).ok,true);
    await f.poll();await f.poll();f.h.fire(START+1);await f.h.settle();
    assert.equal(f.h.owner.liveAutomation.getSnapshot().healthStatus,'TRANSPORT_READY');
    assert.equal(f.count(),0);assert.equal(f.h.captures.length,0);
});
