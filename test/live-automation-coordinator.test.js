import test from 'node:test';
import assert from 'node:assert/strict';

import LiveAutomationCoordinator
    from '../server/scheduler/LiveAutomationCoordinator.js';

const iso = ms => new Date(ms).toISOString();

function live({
    id='live-a',
    sourceId='source-a',
    start=10000,
    end=20000,
    precheckSeconds=3,
    priority=0
}={}) {
    return {
        id,
        version:1,
        type:'source.live',
        enabled:true,
        startAt:iso(start),
        endAt:iso(end),
        priority,
        payload:{
            sourceId,
            precheckSeconds,
            unavailableAction:'KEEP_PROGRAM',
            unavailableSceneId:null,
            endAction:'RETURN',
            endSceneId:null
        },
        createdAt:iso(1000),
        updatedAt:iso(1000)
    };
}

function harness({now=0,events=[]}={}) {
    let clock=now;
    let evaluationListener=null;

    const schedule={version:1,revision:1,events};

    const scheduler={
        store:{
            getSnapshot:()=>schedule
        },
        runtime:{
            subscribeEvaluation(fn){
                evaluationListener=fn;
                return ()=>{ evaluationListener=null; };
            },
            getSnapshot(){
                const active=schedule.events
                    .filter(event =>
                        event.enabled &&
                        Date.parse(event.startAt)<=clock &&
                        clock<Date.parse(event.endAt)
                    )
                    .sort((a,b) =>
                        b.priority-a.priority ||
                        Date.parse(b.startAt)-Date.parse(a.startAt) ||
                        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
                    );

                const winners=new Map();

                for(const event of active){
                    if(!winners.has(event.type))
                        winners.set(event.type,event);
                }

                return {
                    activeEvents:[...winners.values()]
                };
            }
        }
    };

    const leases=[];
    const releases=[];

    const healthRegistry={
        acquire(descriptor,listener){
            const lease={
                descriptor,
                listener,
                current:{
                    sourceId:descriptor.sourceId,
                    sourceFingerprint:descriptor.fingerprint,
                    state:'CHECKING',
                    freshness:'FRESH',
                    validUntil:clock+10000,
                    playlistProgressing:null,
                    segmentReachable:null
                },
                getSnapshot(){ return this.current; },
                release(){ releases.push(descriptor.sourceId); }
            };

            leases.push(lease);
            listener(lease.current);
            return lease;
        }
    };

    const catalogState={
        sources:[
            {
                id:'source-a',
                kind:'hls',
                enabled:true,
                url:'https://example.com/a.m3u8'
            },
            {
                id:'source-b',
                kind:'hls',
                enabled:true,
                url:'https://example.com/b.m3u8'
            }
        ]
    };

    const coordinator=new LiveAutomationCoordinator({
        scheduler,
        healthRegistry,
        catalog:()=>catalogState,
        clock:()=>clock
    });

    return {
        coordinator,
        leases,
        releases,
        setNow(value){clock=value;},
        evaluate(){
            evaluationListener?.(
                scheduler.runtime.getSnapshot()
            );
        },
        health(index,value){
            const lease=leases[index];
            lease.current={
                ...lease.current,
                ...value,
                validUntil:clock+10000
            };
            lease.listener(lease.current);
        }
    };
}

test('no health demand exists before precheck window', async () => {
    const h=harness({
        now:1000,
        events:[live()]
    });

    await h.coordinator.start();

    assert.equal(h.leases.length,0);
    assert.equal(h.coordinator.getSnapshot().state,'IDLE');

    h.coordinator.close();
});

test('entering precheck acquires exactly one health lease', async () => {
    const h=harness({
        now:8000,
        events:[live()]
    });

    await h.coordinator.start();

    assert.equal(h.leases.length,1);
    assert.equal(
        h.leases[0].descriptor.sourceId,
        'source-a'
    );

    h.coordinator.close();

    assert.deepEqual(h.releases,['source-a']);
});

test('healthy precheck becomes transport ready but cannot TAKE', async () => {
    const h=harness({
        now:8000,
        events:[
            live({
                start:20000,
                end:30000,
                precheckSeconds:15
            })
        ]
    });

    await h.coordinator.start();

    h.health(0,{
        state:'ONLINE',
        freshness:'FRESH',
        playlistProgressing:true,
        segmentReachable:true
    });

    const state=h.coordinator.getSnapshot();

    assert.equal(state.state,'TRANSPORT_READY');
    assert.equal(state.serverTake,false);
    assert.equal(state.executionAllowed,false);

    h.coordinator.close();
});

test('start boundary emits advisory TAKE intent only', async () => {
    const h=harness({
        now:8000,
        events:[live()]
    });

    await h.coordinator.start();

    h.health(0,{
        state:'ONLINE',
        freshness:'FRESH',
        playlistProgressing:true,
        segmentReachable:true
    });

    h.setNow(10000);
    h.evaluate();

    const state=h.coordinator.getSnapshot();

    assert.equal(state.state,'TAKE_REQUESTED');
    assert.equal(state.intent.kind,'TAKE_LIVE');
    assert.equal(state.intent.sourceId,'source-a');
    assert.equal(state.automaticTakeAuthority,false);
    assert.equal(state.serverTake,false);

    h.coordinator.close();
});

test('winner replacement releases old lease before acquiring new source', async () => {
    const a=live({
        id:'a',
        sourceId:'source-a',
        start:10000,
        end:20000,
        priority:1
    });

    const b=live({
        id:'b',
        sourceId:'source-b',
        start:12000,
        end:20000,
        priority:20
    });

    const h=harness({
        now:10000,
        events:[a,b]
    });

    await h.coordinator.start();

    assert.equal(h.leases.length,1);
    assert.equal(h.leases[0].descriptor.sourceId,'source-a');

    h.setNow(12000);
    h.evaluate();

    assert.equal(h.leases.length,2);
    assert.deepEqual(h.releases,['source-a']);
    assert.equal(h.leases[1].descriptor.sourceId,'source-b');

    h.coordinator.close();
});

test('LIVE end releases health but retains sequence for post-roll', async () => {
    const h=harness({
        now:10000,
        events:[live()]
    });

    await h.coordinator.start();

    assert.equal(h.leases.length,1);

    h.setNow(20000);
    h.evaluate();

    assert.deepEqual(h.releases,['source-a']);
    assert.equal(
        h.coordinator.getSnapshot().state,
        'POSTROLL_REQUESTED'
    );
    assert.equal(
        h.coordinator.getSnapshot().intent.kind,
        'SHOW_BLACK'
    );

    h.coordinator.close();
});

test('unresolved source never acquires health and remains fail closed', async () => {
    const h=harness({
        now:8000,
        events:[
            live({sourceId:'missing-source'})
        ]
    });

    await h.coordinator.start();

    assert.equal(h.leases.length,0);

    const state=h.coordinator.getSnapshot();

    assert.equal(state.serverTake,false);
    assert.equal(state.executionAllowed,false);

    h.coordinator.close();
});

test('coordinator publishes advisory pre-roll at T-10 when transport is ready', async () => {
    const h=harness({
        now:5000,
        events:[
            live({
                start:20000,
                end:30000,
                precheckSeconds:15
            })
        ]
    });

    await h.coordinator.start();

    h.health(0,{
        state:'ONLINE',
        freshness:'FRESH',
        playlistProgressing:true,
        segmentReachable:true
    });

    h.setNow(10000);
    h.evaluate();

    const state=h.coordinator.getSnapshot();

    assert.equal(state.state,'PREROLL_REQUESTED');
    assert.equal(state.intent.kind,'SHOW_LIVE_PREROLL');
    assert.equal(state.executionAllowed,false);
    assert.equal(state.serverTake,false);

    h.coordinator.close();
});

test('coordinator retains LIVE after end without reacquiring health', async () => {
    const h=harness({
        now:10000,
        events:[live()]
    });

    await h.coordinator.start();

    h.setNow(20000);
    h.evaluate();

    assert.equal(
        h.coordinator.getSnapshot().state,
        'POSTROLL_REQUESTED'
    );

    assert.deepEqual(h.releases,['source-a']);
    assert.equal(h.leases.length,1);

    h.setNow(22000);
    h.evaluate();

    assert.equal(
        h.coordinator.getSnapshot().state,
        'POSTROLL_REQUESTED'
    );

    assert.equal(h.leases.length,1);

    h.coordinator.close();
});

test('coordinator emits RETURN at END+3s then drops sequence', async () => {
    const h=harness({
        now:10000,
        events:[live()]
    });

    await h.coordinator.start();

    h.setNow(20000);
    h.evaluate();

    h.setNow(23000);
    h.evaluate();

    assert.equal(
        h.coordinator.getSnapshot().state,
        'RETURN_REQUESTED'
    );

    assert.deepEqual(
        h.coordinator.getSnapshot().intent,
        {
            kind:'RESTORE_PROGRAM',
            action:'RETURN',
            sceneId:null
        }
    );

    h.setNow(23001);
    h.evaluate();

    assert.equal(
        h.coordinator.getSnapshot().state,
        'IDLE'
    );

    h.coordinator.close();
});