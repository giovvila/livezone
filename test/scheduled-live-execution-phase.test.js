import test from 'node:test';
import assert from 'node:assert/strict';
import ScheduledLiveExecutionCoordinator from '../server/scheduler/ScheduledLiveExecutionCoordinator.js';
import ProgramCommitCoordinator from '../server/program-output/ProgramCommitCoordinator.js';
import ProgramOutputStore from '../server/program-output/ProgramOutputStore.js';
import DurableProgramRepository from '../server/program-output/DurableProgramRepository.js';
import {createScheduledLiveProgram,createScheduledLiveBlack} from '../server/scheduler/ScheduledLiveProgramFactory.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function gate(){
    let resolve;
    const promise=new Promise(done=>{resolve=done;});
    return {promise,resolve};
}

function harness(state='LIVE'){
    const transaction={version:1,eventId:'event',sourceId:'source',state,
        executionAllowed:false,serverTake:false};
    const ownership={available:true,closed:false,restartBlocked:false};
    const reconciliation={manualIntentRevision:7,manualPending:false};
    const installed=[];
    const mutations={run:callback=>callback()};
    const commits={async accept(payload,{check}){
        if(!check())return {accepted:false};
        if(!check())return {accepted:false};
        installed.push(payload);
        return {accepted:true};
    }};
    const coordinator=new ScheduledLiveExecutionCoordinator({ownership,reconciliation,
        scheduledOwnership:{transaction:()=>({...transaction})},mutations,commits});
    const request=expectedState=>({eventId:'event',sourceId:'source',expectedState,
        manualIntentRevision:7,payload:{action:expectedState},
        fence:{version:1,allowed:true,scheduledOwnsSequence:true,suppressBrowser:true,
            executionAllowed:false,serverTake:false}});
    return {transaction,ownership,reconciliation,installed,mutations,commits,coordinator,request};
}

test('TAKE delayed before commit is rejected after POSTROLL starts',async()=>{
    const h=harness('POSTROLL');
    assert.equal((await h.coordinator.commit(h.request('LIVE'))).accepted,false);
    assert.deepEqual(h.installed,[]);
});

test('TAKE waiting in mutation queue cannot install after phase advances',async()=>{
    const h=harness();
    const queued=gate();
    h.mutations.run=async callback=>{await queued.promise;return callback();};
    const pending=h.coordinator.commit(h.request('LIVE'));
    h.transaction.state='POSTROLL';
    queued.resolve();
    assert.equal((await pending).accepted,false);
    assert.deepEqual(h.installed,[]);
});

test('final phase fence rejects staged TAKE and permits canonical BLACK successor',async()=>{
    const h=harness();
    const staging=gate(),resume=gate();
    h.commits.accept=async(payload,{check})=>{
        if(!check())return {accepted:false};
        staging.resolve();
        await resume.promise;
        if(!check())return {accepted:false};
        h.installed.push(payload);
        return {accepted:true};
    };
    const pending=h.coordinator.commit(h.request('LIVE'));
    await staging.promise;
    h.transaction.state='POSTROLL';
    resume.resolve();
    assert.equal((await pending).accepted,false);
    assert.equal((await h.coordinator.commit(h.request('POSTROLL'))).accepted,true);
    assert.deepEqual(h.installed,[{action:'POSTROLL'}]);
});

for(const state of ['CAPTURED','PREROLL','LIVE','POSTROLL','RETURN_PENDING']){
    test(`execution requires exact action phase in ${state}`,async()=>{
        const h=harness(state);
        for(const expected of ['LIVE','POSTROLL']){
            assert.equal((await h.coordinator.commit(h.request(expected))).accepted,state===expected);
        }
    });
}

for(const expectedState of [undefined,'CAPTURED','PREROLL','RETURN_PENDING','INVALID']){
    test(`missing or non-executable phase ${expectedState} fails closed`,async()=>{
        const h=harness();
        assert.equal((await h.coordinator.commit(h.request(expectedState))).accepted,false);
        assert.deepEqual(h.installed,[]);
    });
}

for(const change of ['manual','restart','return']){
    test(`BLACK suspended during staging is invalidated by ${change}`,async()=>{
        const h=harness('POSTROLL');
        const staging=gate(),resume=gate();
        h.commits.accept=async(payload,{check})=>{
            assert.equal(check(),true);
            staging.resolve();
            await resume.promise;
            if(!check())return {accepted:false};
            h.installed.push(payload);
            return {accepted:true};
        };
        const pending=h.coordinator.commit(h.request('POSTROLL'));
        await staging.promise;
        if(change==='manual')h.reconciliation.manualIntentRevision++;
        if(change==='restart')h.ownership.restartBlocked=true;
        if(change==='return')h.transaction.state='RETURN_PENDING';
        resume.resolve();
        assert.equal((await pending).accepted,false);
        assert.deepEqual(h.installed,[]);
    });
}

test('durable PROGRAM rejects staged obsolete TAKE, converges to BLACK and restores BLACK on restart',async t=>{
    const directory=await mkdtemp(join(tmpdir(),'lz-scheduled-phase-'));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const path=join(directory,'program.json');
    const store=new ProgramOutputStore();
    const repository=new DurableProgramRepository({path});
    const commits=new ProgramCommitCoordinator({repository,store,validate:async()=>true});
    await commits.initialize();
    const before=createScheduledLiveBlack({eventId:'previous',publisherSessionId:'manual',revision:1,now:1000});
    assert.equal((await commits.accept(before,{check:()=>true})).accepted,true);
    const h=harness();
    h.coordinator.commits=commits;
    const staged=gate(),resume=gate();
    const stage=repository.stage.bind(repository);
    repository.stage=async record=>{
        const result=await stage(record);
        staged.resolve();
        await resume.promise;
        return result;
    };
    const pending=h.coordinator.commit({...h.request('LIVE'),payload:createScheduledLiveProgram({
        eventId:'event',sourceId:'source',sourceUrl:'https://example.test/live.m3u8',
        publisherSessionId:'scheduled:event',revision:1,now:2000
    })});
    await staged.promise;
    h.transaction.state='POSTROLL';
    resume.resolve();
    assert.equal((await pending).accepted,false);
    assert.deepEqual(store.getCurrent(),before);
    assert.deepEqual(JSON.parse(await readFile(path,'utf8')).envelope,before);
    const black=createScheduledLiveBlack({eventId:'event',publisherSessionId:'scheduled:event',revision:2,now:3000});
    assert.equal((await h.coordinator.commit({...h.request('POSTROLL'),payload:black})).accepted,true);
    assert.deepEqual(store.getCurrent(),black);
    assert.deepEqual(JSON.parse(await readFile(path,'utf8')).envelope,black);
    const restored=new ProgramOutputStore();
    await new ProgramCommitCoordinator({repository:new DurableProgramRepository({path}),
        store:restored,validate:async()=>true}).initialize();
    assert.deepEqual(restored.getCurrent(),black);
});
