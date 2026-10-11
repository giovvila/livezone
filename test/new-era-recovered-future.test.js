import test from 'node:test';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
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

for(const boundary of ['authority/epoch-durable','controlled-start/reservation','runtime/ownership','READY/durable','controlled-start/ready-durable'])test('recovered canonical future event and no replay: '+boundary,
    {skip:process.platform!=='win32'},async t=>{
    let runtime,owner,scheduler,ledger,autoLive,scheduledOwnership;
    // Close production owners before fixture cleanup (after hooks run in order).
    t.after(async()=>{await component?.close();runtime?.close();scheduledOwnership?.close();if(scheduler)await scheduler.close();if(ledger)await ledger.close();if(autoLive)await autoLive.close();if(owner)await owner.close();});
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
    let workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization}),component;
    const boot=async()=>{
        const era=executionEraStartup(f.paths.ledger);
        component=componentLaunch(f,{native:true,clock:()=>now});
        const result=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:component.launch,timeoutMs:300000});
        const app=result.owner;owner=app.executionOwnership;store=app.store;commits=app.programCommits;
        const program=app.durableProgram;autoLive=app.autoLive;ledger=app.ledger;scheduler=app.scheduler;reconciliation=app.restartReconciliation;
        assert.equal(program.status,'PRESENT');assert.equal(autoLive.store.state.armed,false);
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
    const input=join(f.root,'future-crash.json');
    await writeFile(input,JSON.stringify({root:f.root,paths:f.paths,authorization:f.authorization,native:true,operation:'start',boundary}));
    const env={...process.env,LIVEZONE_NATIVE_TEST_ROOTS:JSON.stringify([f.root])};delete env.NODE_TEST_CONTEXT;
    const child=await new Promise((ok,no)=>{
        const processChild=spawn(process.execPath,[fileURLToPath(new URL('../test-support/new-era-abrupt-child.mjs',import.meta.url)),input],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';processChild.stdout.on('data',b=>stdout+=b);processChild.stderr.on('data',b=>stderr+=b);
        processChild.once('error',no);processChild.once('close',status=>ok({status,stdout,stderr}));
    });
    assert.equal(child.status,73,child.stderr);assert.ok(child.stdout.includes('"abrupt":true'));
    f.writer.host.proveOffline=async()=>({absent:true,services:[{State:'Stopped',StartMode:'Disabled'}],processes:[]});
    if(['RUNTIME_OWNED','READY'].includes((await workflow.journal()).records.at(-1)?.body.state)){
        const review=await workflow.recoveryReview();await workflow.recoverStart({authorizeRecovery:true,authorizeCompletedOwnerRecovery:true,expectedReviewHash:review.hash});
    }
    if(await workflow.completedStart()){
        const review=await workflow.recoveryReview();
        workflow=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:review.hash,principal:'TEMP-post-ready-start'});
    }
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
    await component.close();
    const review=await workflow.recoveryReview();
    workflow=await workflow.prepareRestart({authorizeRestart:true,expectedReviewHash:review.hash,principal:'TEMP-restart-operator'});
    for(const key of ['authority','program','autoLive']){
        const approved=workflow.startAuthorization.inventory.find(item=>item.key===key),bytes=await readFile(f.paths[key]);
        assert.equal(approved.byteLength,bytes.length);assert.equal(Buffer.from(approved.bytes,'base64').length,bytes.length);
    }
    await boot();assert.equal(owner.authorityEpoch,boundary.includes('ready-durable')||boundary==='READY/durable'?25:24);assert.equal(ledger.snapshot.generation,1);
    scheduler.runtime.reconcile();await runtime.idle();assert.equal(captures,1);
    for(const old of oldEvents){
        now=Date.parse(old.startAt)+1;scheduler.runtime.reconcile();await runtime.idle();
        assert.equal(eraAdmits(executionEraStartup(f.paths.ledger),identityForScheduledEvent(scheduler.store.getEvent(old.id))),false);
    }
    assert.equal(captures,1);assert.deepEqual(await readFile(f.paths.autoLive),autoBytes);
    assert.equal(store.getCurrent().snapshot.source.id,retained.envelope.snapshot.source.id);
});
