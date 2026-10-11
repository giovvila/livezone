import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {executionEraStartup,publishEraReady,eraAdmits} from '../server/recovery/ExecutionEraContract.js';
import BrowserExecutionOwnership from '../server/autolive/BrowserExecutionOwnership.js';
import AutoLiveAuthority from '../server/autolive/AutoLiveAuthority.js';
import RestartReconciliation from '../server/autolive/RestartReconciliation.js';
import DurableProgramRepository from '../server/program-output/DurableProgramRepository.js';
import ProgramRestoreValidation from '../server/program-output/ProgramRestoreValidation.js';
import ProgramCommitCoordinator from '../server/program-output/ProgramCommitCoordinator.js';
import ProgramOutputStore from '../server/program-output/ProgramOutputStore.js';
import SchedulerServer from '../server/scheduler/SchedulerServer.js';
import ScheduledEntryRuntime from '../server/scheduler/ScheduledEntryRuntime.js';
import Ledger from '../server/scheduler/ScheduledEntryLedgerV2Repository.js';
import ScheduledLiveOwnershipCoordinator from '../server/scheduler/ScheduledLiveOwnershipCoordinator.js';
import ScheduledLiveExecutionCoordinator from '../server/scheduler/ScheduledLiveExecutionCoordinator.js';
import {createScheduledLiveProgram} from '../server/scheduler/ScheduledLiveProgramFactory.js';
import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';
import {inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import AssetMutationCoordinator from '../server/media-library/AssetMutationCoordinator.js';
import {createLedgerV2Durability} from '../server/scheduler/LedgerV2Durability.js';

test('native production scheduler consumes new future identity before capture; PROGRAM restore, AutoLive and no replay across restart',
    {skip:process.platform!=='win32'},async t=>{
    let runtime,owner,scheduler,ledger,autoLive,scheduledOwnership;
    // Close production owners before fixture cleanup (after hooks run in order).
    t.after(async()=>{runtime?.close();scheduledOwnership?.close();if(scheduler)await scheduler.close();if(ledger)await ledger.close();if(autoLive)await autoLive.close();if(owner)await owner.close();});
    const f=await eraFixture(t,{native:true});
    const retainedBytes=await readFile(f.paths.program),autoBytes=await readFile(f.paths.autoLive);
    const retained=JSON.parse(retainedBytes),autoConfig=JSON.parse(autoBytes),sourceId=autoConfig.sourceId;
    const catalog={initialized:true,sources:[{...retained.identity.catalog.source,enabled:true},{id:sourceId,kind:'hls',enabled:true,url:'https://example.test/era.m3u8'}],scenes:[retained.identity.catalog.scene]};
    const assets={list:()=>[],get:()=>null};
    const validator=new ProgramRestoreValidation({catalog:()=>catalog,assets});
    assert.equal(await validator.validate(retained),true);
    await f.writer.transition(f.authorization);assert.deepEqual(await readFile(f.paths.program),retainedBytes);
    let now=Date.parse('2030-01-01T11:50:00.000Z'),captures=0,store,commits,reconciliation,execution;
    const mutations=new AssetMutationCoordinator();
    const diagnostics=[];
    const boot=async()=>{
        const era=executionEraStartup(f.paths.ledger);
        owner=new BrowserExecutionOwnership({path:f.paths.authority,eraLedgerPath:f.paths.ledger,clock:()=>now});await owner.ready;
        assert.equal(owner.available,true,owner.initializationError);
        store=new ProgramOutputStore();const program=new DurableProgramRepository({path:f.paths.program});
        commits=new ProgramCommitCoordinator({repository:program,store,bind:s=>validator.bind(s),validate:r=>validator.validate(r),authorityEpoch:()=>owner.authorityEpoch});
        await commits.initialize();assert.equal(program.status,'PRESENT');
        autoLive=new AutoLiveAuthority({path:f.paths.autoLive,recoveryPath:f.paths.autoLive+'.recovery',catalog:()=>catalog,clock:()=>now});await autoLive.ready;
        assert.deepEqual(await readFile(f.paths.autoLive),autoBytes);assert.equal(autoLive.store.state.armed,false);
        ledger=new Ledger({path:f.paths.ledger,authority:owner});await ledger.initialize();assert.equal(ledger.status,'READY',ledger.error);
        reconciliation=new RestartReconciliation({ownership:owner,store,durable:()=>({status:program.status,generation:program.record.generation}),
            configuration:()=>({available:autoLive.available(),revision:autoLive.store.state.revision,sourceFingerprint:autoLive.healthRuntime().resolvedSourceFingerprint})});
        const binding={ownerInstanceId:'TEMP-operator',publisherSessionId:'TEMP-publisher'},prepared=reconciliation.execute({...binding,operation:'prepare-reconciliation'},'TEMP');
        reconciliation.execute({...binding,...prepared,operation:'reconcile'},'TEMP');
        await publishEraReady({era,authority:owner,program,autoLive,validateProgram:()=>validator.validate(program.record)});
        scheduler=new SchedulerServer({path:f.paths.schedule,executionEra:era,authority:owner,clock:()=>now,setTimer:()=>({unref(){}}),clearTimer:()=>{}});await scheduler.ready;
        scheduledOwnership=new ScheduledLiveOwnershipCoordinator({ownership:owner,reconciliation,program:()=>store.getCurrent(),clock:()=>now});
        const capture=scheduledOwnership.capture.bind(scheduledOwnership);
        scheduledOwnership.capture=input=>{
            // Capture is synchronous. Durable COMMIT must already be visible.
            assert.equal(ledger.snapshot.entries.filter(e=>e.identity.eventId===input.eventId).length,1);
            assert.equal(ledger.records.at(-1).type,'COMMIT');captures++;return capture(input);
        };
        const automation={resolveSource:()=>({descriptor:{fingerprint:'TEMP-verified-health'}}),health:{sourceId,sourceFingerprint:'TEMP-verified-health',state:'ONLINE',freshness:'FRESH',validUntil:Date.parse('2031-01-01T00:00:00Z'),playlistProgressing:true,segmentReachable:true}};
        runtime=new ScheduledEntryRuntime({scheduler,automation,ownership:owner,reconciliation,scheduledOwnership,mutations,clock:()=>now,ready:Promise.resolve(ledger),logger:e=>diagnostics.push(e)});
        execution=new ScheduledLiveExecutionCoordinator({ownership:owner,reconciliation,scheduledOwnership,mutations,commits,entryCheck:c=>runtime.checkCommit(c)});
        scheduler.runtime.subscribeEvaluation(snapshot=>{
            const event=snapshot.activeEvents.find(e=>e.type==='source.live');
            if(event)runtime.request({eventId:event.id},async ticket=>{
                scheduledOwnership.transition('begin-preroll');const live=scheduledOwnership.transition('begin-live');
                const payload=createScheduledLiveProgram({eventId:ticket.eventId,sourceId,sourceUrl:catalog.sources[1].url,publisherSessionId:'era-live-'+ticket.incarnationId,revision:1,now});
                const result=await execution.commit({eventId:ticket.eventId,sourceId,expectedState:'LIVE',fence:scheduledOwnership.snapshot().fence,manualIntentRevision:live.manualIntentRevision,payload});
                assert.equal(result.accepted,true,result.reason);
            });
        });
        return {era,program};
    };
    const first=await boot();assert.equal(first.program.record.generation,47);assert.equal(first.program.record.acceptedAuthorityEpoch,20);
    assert.deepEqual(await readFile(f.paths.program),retainedBytes);
    const oldEvents=scheduler.store.listEvents().filter(e=>e.type==='source.live');assert.equal(oldEvents.length,2);
    for(const old of oldEvents){
        assert.equal(eraAdmits(first.era,identityForScheduledEvent(old)),false);
        assert.equal((await ledger.consume(identityForScheduledEvent(old),{consumedAt:new Date(now).toISOString(),authorityEpoch:owner.authorityEpoch,authorityProcessSession:owner.authorityProcessSession})).status,'OLD_EXECUTION_DOMAIN_RETIRED');
    }
    const event={...oldEvents[0],id:'entirely-new-era-future-live',payload:{...oldEvents[0].payload,sourceId},startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:03:00.000Z'};
    for(const k of ['incarnationId','entryRevision','entryMigration'])delete event[k];
    assert.equal((await scheduler.store.insert(event,scheduler.store.state.revision)).ok,true);
    const identity=identityForScheduledEvent(scheduler.store.getEvent(event.id));assert.equal(identity.identitySchema,2);
    now=Date.parse(event.startAt)+1;scheduler.runtime.reconcile();await runtime.idle();
    assert.equal(captures,1,JSON.stringify(diagnostics));assert.equal(ledger.snapshot.generation,1);
    assert.equal((await inspectV2(f.paths.ledger)).current.entries[0].identity.entryKey,identity.entryKey);
    assert.equal(first.program.record.programState,'PRESENT');assert.equal(store.getCurrent().snapshot.source.id,sourceId);
    // Explicit RETURN uses the production PROGRAM commit path and the captured content.
    scheduledOwnership.release(event.id);
    const returnEnvelope={...retained.envelope,publisherSessionId:'era-return',revision:1,publishedAt:new Date(now).toISOString(),snapshot:{...retained.envelope.snapshot,publisherSessionId:'era-return',revision:1,publishedAt:new Date(now).toISOString()}};
    assert.equal((await commits.accept(returnEnvelope,{check:()=>owner.available})).accepted,true);
    assert.equal(first.program.record.envelope.snapshot.source.id,retained.envelope.snapshot.source.id);
    runtime.close();await scheduler.close();await ledger.close();await autoLive.close();await owner.close();
    await boot();assert.equal(owner.authorityEpoch,24);assert.equal(ledger.snapshot.generation,1);
    scheduler.runtime.reconcile();await runtime.idle();assert.equal(captures,1);
    for(const old of oldEvents){
        now=Date.parse(old.startAt)+1;scheduler.runtime.reconcile();await runtime.idle();
        assert.equal(eraAdmits(executionEraStartup(f.paths.ledger),identityForScheduledEvent(scheduler.store.getEvent(old.id))),false);
    }
    assert.equal(captures,1);assert.deepEqual(await readFile(f.paths.autoLive),autoBytes);
    assert.equal(store.getCurrent().snapshot.source.id,retained.envelope.snapshot.source.id);
});
