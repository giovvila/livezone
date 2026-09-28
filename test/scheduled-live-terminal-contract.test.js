import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProgramOutputServer} from '../server/program-output-server.js';
import {createInitializedState} from '../server/studio/AuthoritativeStateContract.js';
import {createScheduledLiveProgram,createScheduledLiveBlack} from '../server/scheduler/ScheduledLiveProgramFactory.js';
import {evaluateLiveAutomation} from '../server/scheduler/LiveAutomationShadow.js';
import {createScheduledLiveTransaction,transitionScheduledLiveTransaction,
    inspectScheduledLiveTransaction} from '../server/scheduler/ScheduledLiveExecutionTransaction.js';
import {reconcileScheduledLiveRecovery} from '../server/scheduler/ScheduledLiveRecovery.js';

const epoch=Date.parse('2026-09-28T18:00:00.000Z');
const stamp=offset=>new Date(epoch+offset).toISOString();
const event={id:'event',version:1,type:'source.live',enabled:true,
    startAt:stamp(300000),endAt:stamp(600000),priority:10,
    payload:{sourceId:'source',precheckSeconds:180,unavailableAction:'KEEP_PROGRAM',
        unavailableSceneId:null,endAction:'RETURN',endSceneId:null},createdAt:stamp(0),updatedAt:stamp(0)};
const live=publisherSessionId=>createScheduledLiveProgram({eventId:'event',sourceId:'source',
    sourceUrl:'https://example.test/live.m3u8',publisherSessionId,revision:1,now:epoch});

async function harness(t){
    const dir=await mkdtemp(join(tmpdir(),'lz-d10-terminal-'));
    const studioStatePath=join(dir,'studio.json');
    const studio=createInitializedState({sources:[{id:'source',name:'Live',kind:'hls',enabled:true,
        url:'https://example.test/live.m3u8'}],scenes:[],
        scheduler:{version:1,timezone:'Europe/Rome',items:[],enabled:false},
        globalOverlays:{textCrawl:null},dominantLive:{armed:false,authorizedSourceId:null}},
        {stateId:'studio',updatedAt:stamp(0)});
    await writeFile(studioStatePath,JSON.stringify(studio));
    let now=epoch,timer=0;
    const leases=[];
    const options={publisherToken:'d10-terminal-test-token',studioStatePath,
        schedulePath:join(dir,'schedule.json'),mediaLibraryRoot:join(dir,'media'),
        mediaAssetRepository:{initialize:async()=>{},list:()=>[],get:()=>null},
        scheduleClock:()=>now,scheduleSetTimer:()=>++timer,scheduleClearTimer:()=>{},
        autoLiveHealthRegistry:{acquire(descriptor,listener){
            const lease={listener,current:{sourceId:descriptor.sourceId,sourceFingerprint:descriptor.fingerprint,
                state:'CHECKING',reason:'INITIAL',freshness:'FRESH',validUntil:now+60000,
                playlistProgressing:null,segmentReachable:null},
                getSnapshot(){return this.current;},release(){}};
            leases.push(lease);return lease;
        }}};
    let owner=createProgramOutputServer(options);
    t.after(async()=>{
        await new Promise(resolve=>owner.server.close(()=>resolve()));
        await rm(dir,{recursive:true,force:true});
    });
    const ready=()=>Promise.all([owner.scheduler.ready,owner.studioStateCoordinator.ready,
        owner.programReady,owner.scheduledLiveHydrationReady]);
    await ready();
    const retained=live('retained');
    assert.equal((await owner.programCommits.accept(retained,{check:()=>true})).accepted,true);
    const jobs=new Set();
    for(const [target,method] of [[owner.scheduledLivePersistence,'persist'],[owner.scheduledLiveExecution,'commit']]){
        const original=target[method].bind(target);
        target[method]=(...args)=>{
            const pending=original(...args);jobs.add(pending);
            pending.then(()=>jobs.delete(pending),()=>jobs.delete(pending));return pending;
        };
    }
    const settle=async()=>{
        do {await Promise.all([...jobs]);await owner.assetMutations.run(()=>{});}while(jobs.size);
    };
    const fire=offset=>{now=epoch+offset;owner.scheduler.runtime.reconcile();};
    const healthy=()=>{
        const lease=leases.at(-1);
        lease.current={...lease.current,state:'ONLINE',reason:'PLAYLIST_ADVANCING',
            validUntil:now+60000,playlistProgressing:true,segmentReachable:true};
        lease.listener(lease.current);
    };
    return {get owner(){return owner;},retained,fire,settle,
        path:studioStatePath+'.program-output.json',journal:studioStatePath+'.scheduled-live-execution.json',
        async start(){
            await owner.scheduler.store.insert(event,0);
            fire(120000);healthy();fire(300000);healthy();await settle();
            assert.equal(owner.scheduledLiveOwnership.transaction().state,'LIVE');
            assert.equal(owner.store.getCurrent().publisherSessionId,'scheduled:event');
        },
        async manual(){
            const finish=owner.scheduledLiveExecution.reconciliation.beginManualIntent();
            try{
                const payload=live('manual-newer');
                assert.equal((await owner.assetMutations.run(()=>owner.programCommits.accept(payload,
                    {check:()=>true,afterInstall:()=>owner.executionOwnership.revokeForManual('manual-newer')}))).accepted,true);
                return owner.store.getCurrent();
            }finally{finish();}
        },
        async restart(){
            await new Promise(resolve=>owner.server.close(()=>resolve()));
            owner=createProgramOutputServer(options);await ready();await owner.assetMutations.run(()=>{});
            return owner;
        }};
}

test('SHOW_BLACK is an intent in POSTROLL; RETURN is advisory; pure completion has no action',()=>{
    for(const [offset,state,kind] of [[600000,'POSTROLL_REQUESTED','SHOW_BLACK'],
        [602999,'POSTROLL_REQUESTED','SHOW_BLACK'],[603000,'RETURN_REQUESTED','RESTORE_PROGRAM'],
        [603001,'COMPLETED',null]]){
        const value=evaluateLiveAutomation({event,now:epoch+offset});
        assert.equal(value.state,state);assert.equal(value.intent?.kind??null,kind);
        assert.equal(value.executionAllowed,false);assert.equal(value.serverTake,false);
        if(kind==='SHOW_BLACK')assert.equal(value.intent.durationMs,3000);
        if(kind==='RESTORE_PROGRAM')assert.deepEqual(value.intent,{kind,action:'RETURN',sceneId:null});
    }
});

for(const scenario of ['black','manual-before-black','manual-after-black','skip-return-boundary','skip-postroll']){
    test(`server terminal contract: ${scenario} retains latest PROGRAM and never replays`,{timeout:10000},async t=>{
        const h=await harness(t);await h.start();
        const {owner}=h;
        const captured=owner.scheduledLiveOwnership.transaction().capturedProgram;
        assert.deepEqual(captured,h.retained);
        const staleFence=owner.scheduledLiveOwnership.snapshot().fence;
        const manualRevision=owner.scheduledLiveOwnership.transaction().manualIntentRevision;
        let expected=owner.store.getCurrent();
        if(scenario==='manual-before-black')expected=await h.manual();
        if(scenario!=='skip-postroll'){
            h.fire(600000);await h.settle();
            assert.equal(owner.liveAutomation.getSnapshot().state,'POSTROLL_REQUESTED');
            assert.equal(owner.liveAutomation.getSnapshot().intent.kind,'SHOW_BLACK');
            if(scenario!=='manual-before-black'){
                assert.equal(owner.scheduledLiveOwnership.transaction().state,'POSTROLL');
                assert.equal(owner.executionOwnership.snapshot().scheduledSuppressed,true);
                expected=owner.store.getCurrent();
                assert.equal(expected.publisherSessionId,'scheduled:event');assert.equal(expected.revision,2);
                assert.equal(expected.snapshot.scene,null);assert.equal(expected.snapshot.source,null);
                assert.equal(expected.snapshot.playback.playing,false);
                assert.equal(owner.scheduledLiveExecutionRepository.record.state,'POSTROLL');
                assert.deepEqual(owner.scheduledLiveExecutionRepository.record.capturedProgram,captured);
            }
        }
        if(scenario==='manual-after-black')expected=await h.manual();
        const programBytes=await readFile(h.path,'utf8');
        const journalBytes=await readFile(h.journal,'utf8');
        const skip=scenario==='skip-return-boundary'||scenario==='skip-postroll';
        h.fire(skip?603001:603000);await h.settle();
        assert.equal(owner.liveAutomation.getSnapshot().state,skip?'IDLE':'RETURN_REQUESTED');
        assert.equal(owner.scheduledLiveOwnership.transaction(),null);
        assert.equal(owner.executionOwnership.snapshot().scheduledSuppressed,false);
        assert.deepEqual(owner.store.getCurrent(),expected);
        assert.equal(await readFile(h.path,'utf8'),programBytes);
        // Runtime release does not invent a durable RETURN_PENDING/COMPLETED.
        assert.equal(await readFile(h.journal,'utf8'),journalBytes);
        const grant=await owner.executionOwnership.operate({operation:'acquire',
            ownerInstanceId:'after-terminal',publisherSessionId:'after-terminal'},'operator');
        assert.equal(Boolean(grant.grant),!scenario.startsWith('manual-'));
        for(const expectedState of ['LIVE','POSTROLL']){
            const result=await owner.scheduledLiveExecution.commit({eventId:'event',sourceId:'source',
                expectedState,manualIntentRevision:manualRevision,fence:staleFence,
                payload:expectedState==='LIVE'?live('scheduled:event'):createScheduledLiveBlack({
                    eventId:'event',publisherSessionId:'scheduled:event',revision:2,now:epoch+603000})});
            assert.equal(result.accepted,false);
        }
        h.fire(603001);await h.settle();assert.equal(owner.liveAutomation.getSnapshot().state,'IDLE');
        assert.deepEqual(owner.store.getCurrent(),expected);
        assert.equal(await readFile(h.path,'utf8'),programBytes);
        const restarted=await h.restart();
        assert.deepEqual(restarted.store.getCurrent(),expected);
        assert.equal(await readFile(h.path,'utf8'),programBytes);
        assert.equal(await readFile(h.journal,'utf8'),journalBytes);
        assert.equal(restarted.scheduledLiveOwnership.transaction(),null);
        assert.equal(restarted.liveAutomation.getSnapshot().state,'IDLE');
        assert.equal(restarted.scheduledLivePersistence.snapshot().executionAllowed,false);
    });
}

for(const state of ['COMPLETED','ABORTED','RECOVERY_BLOCKED']){
    test(`persisted ${state} is diagnostic on server restart, never a RETURN command`,{timeout:10000},async t=>{
        const h=await harness(t);
        let tx=createScheduledLiveTransaction({eventId:'event',sourceId:'source',program:h.retained,
            manualIntentRevision:0,capturedAt:epoch+290000});
        if(state==='COMPLETED'){
            for(const operation of ['begin-preroll','begin-live','begin-postroll','prepare-return','complete']){
                tx=transitionScheduledLiveTransaction(tx,operation,{manualIntentRevision:0});
            }
        }else if(state==='ABORTED'){
            tx=transitionScheduledLiveTransaction(tx,'begin-preroll',{manualIntentRevision:1});
        }else tx={...tx,state,reason:'RECOVERY_RECONCILIATION_REQUIRED'};
        await h.owner.scheduledLivePersistence.persist(tx);
        const programBytes=await readFile(h.path,'utf8'),journalBytes=await readFile(h.journal,'utf8');
        const recovery=reconcileScheduledLiveRecovery({transaction:tx,event,currentProgram:h.retained,
            manualIntentRevision:0,now:epoch+603001});
        assert.equal(recovery.disposition,'SEQUENCE_TERMINAL');
        assert.equal(recovery.executionAllowed,false);assert.equal(recovery.serverTake,false);
        assert.equal(inspectScheduledLiveTransaction(tx,{manualIntentRevision:0}).returnProgram,null);
        assert.throws(()=>transitionScheduledLiveTransaction(tx,'begin-live',{manualIntentRevision:0}),/TRANSACTION_TERMINAL/);
        h.fire(603001);
        const restarted=await h.restart();
        assert.equal(restarted.scheduledLiveExecutionRepository.record.state,state);
        assert.equal(restarted.scheduledLiveOwnership.transaction(),null);
        assert.deepEqual(restarted.store.getCurrent(),h.retained);
        assert.equal(await readFile(h.path,'utf8'),programBytes);
        assert.equal(await readFile(h.journal,'utf8'),journalBytes);
    });
}
