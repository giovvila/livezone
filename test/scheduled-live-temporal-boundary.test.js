import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProgramOutputServer} from '../server/program-output-server.js';
import {createInitializedState} from '../server/studio/AuthoritativeStateContract.js';
import ScheduledLiveExecutionCoordinator from '../server/scheduler/ScheduledLiveExecutionCoordinator.js';
import ProgramCommitCoordinator from '../server/program-output/ProgramCommitCoordinator.js';
import ProgramOutputStore from '../server/program-output/ProgramOutputStore.js';
import DurableProgramRepository from '../server/program-output/DurableProgramRepository.js';
import AssetMutationCoordinator from '../server/media-library/AssetMutationCoordinator.js';
import {createScheduledLiveProgram,createScheduledLiveBlack} from '../server/scheduler/ScheduledLiveProgramFactory.js';

const epoch=Date.parse('2026-09-28T18:00:00.000Z');
const stamp=offset=>new Date(epoch+offset).toISOString();
function deferred(){
    let resolve;
    const promise=new Promise(done=>{resolve=done;});
    return {promise,resolve};
}
function black(publisherSessionId='retained',revision=1){
    return createScheduledLiveBlack({eventId:'event',publisherSessionId,revision,now:epoch});
}
function live(publisherSessionId='scheduled:event',revision=1){
    return createScheduledLiveProgram({eventId:'event',sourceId:'source',
        sourceUrl:'https://example.test/live.m3u8',publisherSessionId,revision,now:epoch});
}
async function verifyProgram(path,store,expected,bytes){
    assert.deepEqual(store.getCurrent(),expected);
    assert.equal(await readFile(path,'utf8'),bytes,'aborted action must preserve exact durable bytes');
    const restored=new ProgramOutputStore();
    await new ProgramCommitCoordinator({repository:new DurableProgramRepository({path}),
        store:restored,validate:async()=>true}).initialize();
    assert.deepEqual(restored.getCurrent(),expected,'restart must not replay the aborted action');
}

// Real serializer, PROGRAM staging, disk commit and restart. Only the authority
// inputs are controlled; no wall-clock delays determine the race outcome.
for(const action of ['LIVE','POSTROLL']){
    for(const boundary of ['queue','bind','stage']){
        for(const change of ['phase','release','event','source','manual','pending','restart']){
            test(`${action} at ${boundary}: ${change} preserves latest PROGRAM and restart`,{timeout:10000},async t=>{
                const dir=await mkdtemp(join(tmpdir(),'lz-d9-commit-'));
                t.after(()=>rm(dir,{recursive:true,force:true}));
                const path=join(dir,'program.json');
                const store=new ProgramOutputStore(),repository=new DurableProgramRepository({path});
                const commits=new ProgramCommitCoordinator({store,repository,validate:async()=>true});
                await commits.initialize();
                const before=action==='POSTROLL'?live():black();
                assert.equal((await commits.accept(before,{check:()=>true})).accepted,true);
                let transaction={version:1,eventId:'event',sourceId:'source',state:action,
                    executionAllowed:false,serverTake:false};
                const ownership={available:true,closed:false,restartBlocked:false};
                const reconciliation={manualIntentRevision:7,manualPending:false};
                const mutations=new AssetMutationCoordinator();
                const coordinator=new ScheduledLiveExecutionCoordinator({ownership,reconciliation,
                    scheduledOwnership:{transaction:()=>transaction},mutations,commits});
                const entered=deferred(),resume=deferred();
                t.after(()=>resume.resolve());
                let blocker;
                if(boundary==='queue')blocker=mutations.run(async()=>{entered.resolve();await resume.promise;});
                else {
                    const target=boundary==='bind'?commits:repository;
                    const method=boundary==='bind'?'bind':'stage';
                    const original=target[method].bind(target);
                    target[method]=async(...args)=>{
                        const value=await original(...args);
                        entered.resolve();await resume.promise;
                        return value;
                    };
                }
                const pending=coordinator.commit({eventId:'event',sourceId:'source',expectedState:action,
                    manualIntentRevision:7,payload:action==='LIVE'?live():black('scheduled:event',2),
                    fence:{version:1,allowed:true,scheduledOwnsSequence:true,suppressBrowser:true,
                        executionAllowed:false,serverTake:false}});
                await entered.promise;
                if(change==='phase')transaction={...transaction,state:action==='LIVE'?'POSTROLL':'RETURN_PENDING'};
                if(change==='release')transaction=null;
                if(change==='event')transaction={...transaction,eventId:'new-event'};
                if(change==='source')transaction={...transaction,sourceId:'new-source'};
                if(change==='manual')reconciliation.manualIntentRevision++;
                if(change==='pending')reconciliation.manualPending=true;
                if(change==='restart')ownership.restartBlocked=true;
                const bytes=await readFile(path,'utf8');
                resume.resolve();
                assert.equal((await pending).accepted,false);
                await blocker;
                await verifyProgram(path,store,before,bytes);
                // A subsequent authoritative publication must also remain protected
                // from a retry of the invalidated Scheduled action.
                const newer=live('manual-newer');
                assert.equal((await mutations.run(()=>commits.accept(newer,{check:()=>true}))).accepted,true);
                const latestBytes=await readFile(path,'utf8');
                assert.equal((await coordinator.commit({eventId:'event',sourceId:'source',expectedState:action,
                    manualIntentRevision:7,payload:action==='LIVE'?live():black('scheduled:event',2),
                    fence:{version:1,allowed:true,scheduledOwnsSequence:true,suppressBrowser:true,
                        executionAllowed:false,serverTake:false}})).accepted,false);
                await verifyProgram(path,store,newer,latestBytes);
            });
        }
    }
}

async function serverHarness(t){
    const dir=await mkdtemp(join(tmpdir(),'lz-d9-server-'));
    const studioStatePath=join(dir,'studio.json');
    const studio=createInitializedState({sources:[{id:'source',name:'Live',kind:'hls',enabled:true,
        url:'https://example.test/live.m3u8'}],scenes:[],
        scheduler:{version:1,timezone:'Europe/Rome',items:[],enabled:false},
        globalOverlays:{textCrawl:null},dominantLive:{armed:false,authorizedSourceId:null}},
        {stateId:'studio',updatedAt:stamp(0)});
    await writeFile(studioStatePath,JSON.stringify(studio));
    let now=epoch,timer=0;
    const leases=[];
    const options={publisherToken:'d9-temporal-test-token',studioStatePath,
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
    const releases=[];
    t.after(async()=>{
        for(const release of releases)release();
        await new Promise(resolve=>owner.server.close(()=>resolve()));
        await rm(dir,{recursive:true,force:true});
    });
    await Promise.all([owner.scheduler.ready,owner.studioStateCoordinator.ready,
        owner.programReady,owner.scheduledLiveHydrationReady]);
    const before=black();
    assert.equal((await owner.programCommits.accept(before,{check:()=>true})).accepted,true);
    const jobs=new Set();
    for(const [target,method] of [[owner.scheduledLivePersistence,'persist'],[owner.scheduledLiveExecution,'commit']]){
        const original=target[method].bind(target);
        target[method]=(...args)=>{
            const promise=original(...args);
            jobs.add(promise);
            promise.then(()=>jobs.delete(promise),()=>jobs.delete(promise));
            return promise;
        };
    }
    const settle=async()=>{
        // Drain explicit operations and the real mutation queue, not elapsed time.
        do {await Promise.allSettled([...jobs]);await owner.assetMutations.run(()=>{});}while(jobs.size);
    };
    const fire=offset=>{now=epoch+offset;owner.scheduler.runtime.reconcile();};
    const healthy=()=>{
        const lease=leases[0];
        lease.current={...lease.current,state:'ONLINE',reason:'PLAYLIST_ADVANCING',
            validUntil:now+60000,playlistProgressing:true,segmentReachable:true};
        lease.listener(lease.current);
    };
    await owner.scheduler.store.insert({id:'event',version:1,type:'source.live',enabled:true,
        startAt:stamp(300000),endAt:stamp(600000),priority:10,
        payload:{sourceId:'source',precheckSeconds:180,unavailableAction:'KEEP_PROGRAM',
            unavailableSceneId:null,endAction:'RETURN',endSceneId:null},createdAt:stamp(0),updatedAt:stamp(0)},0);
    fire(120000);healthy();
    return {owner,fire,settle,jobs,releases,path:studioStatePath+'.program-output.json',
        async restart(){
            await new Promise(resolve=>owner.server.close(()=>resolve()));
            owner=createProgramOutputServer(options);
            await Promise.all([owner.scheduler.ready,owner.studioStateCoordinator.ready,
                owner.programReady,owner.scheduledLiveHydrationReady]);
            await owner.assetMutations.run(()=>{});
            return owner;
        },
        start(){fire(300000);healthy();assert.equal(owner.liveAutomation.getSnapshot().state,'TAKE_REQUESTED');}};
}

for(const phase of ['PREROLL','LIVE','POSTROLL']){
    for(const change of ['return','manual','replacement-event','replacement-source',
        ...(phase==='PREROLL'||phase==='LIVE'?['postroll']:[])]){
        test(`server persistence ${phase} delayed past ${change} cannot publish obsolete PROGRAM`,{timeout:10000},async t=>{
            const h=await serverHarness(t),{owner}=h;
            const entered=deferred(),resume=deferred();
            h.releases.push(()=>resume.resolve());
            const persist=owner.scheduledLivePersistence.persist.bind(owner.scheduledLivePersistence);
            owner.scheduledLivePersistence.persist=tx=>{
                const pending=(async()=>{
                    const result=await persist(tx);
                    if(tx.state===phase){entered.resolve();await resume.promise;}
                    return result;
                })();
                h.jobs.add(pending);
                pending.then(()=>h.jobs.delete(pending),()=>h.jobs.delete(pending));
                return pending;
            };
            h.start();
            if(phase==='POSTROLL'){await h.settle();h.fire(600000);}
            await entered.promise;
            if(change==='postroll'){
                const installed=deferred();
                const off=owner.store.subscribe(()=>{
                    if(owner.store.getCurrent()?.revision===2)installed.resolve();
                });
                h.fire(600000);
                assert.equal(owner.liveAutomation.getSnapshot().state,'POSTROLL_REQUESTED');
                // With LIVE already durable, BLACK is the legitimate successor.
                // Let it finish before releasing the old TAKE continuation.
                if(phase==='LIVE')await installed.promise;
                off();
            }
            if(change==='return'){
                h.fire(600000);h.fire(603000);
                assert.equal(owner.liveAutomation.getSnapshot().state,'RETURN_REQUESTED');
                assert.equal(owner.scheduledLiveOwnership.transaction(),null);
            }
            if(change==='manual')owner.scheduledLiveExecution.reconciliation.beginManualIntent()();
            let replacement;
            if(change.startsWith('replacement-')){
                assert.equal(owner.scheduledLiveOwnership.release('event'),true);
                assert.equal(owner.scheduledLiveOwnership.capture({
                    eventId:change==='replacement-event'?'replacement':'event',
                    sourceId:change==='replacement-source'?'replacement-source':'source'
                }).accepted,true);
                owner.scheduledLiveOwnership.transition('begin-preroll');
                if(phase!=='PREROLL')owner.scheduledLiveOwnership.transition('begin-live');
                if(phase==='POSTROLL')owner.scheduledLiveOwnership.transition('begin-postroll');
                replacement=owner.scheduledLiveOwnership.transaction();
            }
            let newer=owner.store.getCurrent();
            if(change!=='postroll' && !replacement){
                // RETURN has released Scheduled ownership, or manual intent has
                // invalidated it. Install the subsequent authoritative PROGRAM.
                newer=live('manual-newer');
                assert.equal((await owner.assetMutations.run(()=>owner.programCommits.accept(newer,{check:()=>true}))).accepted,true);
            }
            const bytes=await readFile(h.path,'utf8');
            resume.resolve();
            await h.settle();
            if(replacement)assert.deepEqual(owner.scheduledLiveOwnership.transaction(),replacement,
                'old persistence continuation must not advance or release replacement ownership');
            await verifyProgram(h.path,owner.store,newer,bytes);
            const restarted=await h.restart();
            assert.deepEqual(restarted.store.getCurrent(),newer);
            assert.equal(await readFile(h.path,'utf8'),bytes);
            assert.equal(restarted.scheduledLiveOwnership.transaction(),null,
                'hydrated Scheduled journal must not reacquire execution authority');
        });
    }
}

for(const change of ['postroll','return','replacement-source']){
    test(`server readiness delayed past ${change} cannot advance a stale TAKE`,{timeout:10000},async t=>{
        const h=await serverHarness(t),{owner}=h;
        const entered=deferred(),resume=deferred();
        h.releases.push(()=>resume.resolve());
        const ready=owner.scheduledLiveExecutionReady;
        const then=ready.then.bind(ready);
        let continuation;
        ready.then=(callback,onRejected)=>{
            continuation=then(async value=>{
                entered.resolve();await resume.promise;return callback(value);
            },onRejected);
            return continuation;
        };
        h.start();
        await entered.promise;
        let replacement;
        if(change==='replacement-source'){
            owner.scheduledLiveOwnership.release('event');
            assert.equal(owner.scheduledLiveOwnership.capture({eventId:'event',sourceId:'replacement-source'}).accepted,true);
            replacement=owner.scheduledLiveOwnership.transaction();
        }else{
            h.fire(600000);
            if(change==='return')h.fire(603000);
        }
        const before=owner.store.getCurrent(),bytes=await readFile(h.path,'utf8');
        // Explicitly await the readiness callback before draining downstream work.
        const originalTransition=owner.scheduledLiveOwnership.transition.bind(owner.scheduledLiveOwnership);
        let transitions=0;
        owner.scheduledLiveOwnership.transition=(...args)=>{transitions++;return originalTransition(...args);};
        resume.resolve();
        await continuation;
        await h.settle();
        assert.equal(transitions,0);
        if(replacement)assert.deepEqual(owner.scheduledLiveOwnership.transaction(),replacement);
        await verifyProgram(h.path,owner.store,before,bytes);
    });
}
