import test from 'node:test';
import assert from 'node:assert/strict';

import ScheduledLivePersistenceCoordinator
    from '../server/scheduler/ScheduledLivePersistenceCoordinator.js';

import {
    createScheduledLiveTransaction
} from '../server/scheduler/ScheduledLiveExecutionTransaction.js';

import {
    createProgramOutputEnvelope
} from '../public/js/program-output/ProgramOutputEnvelope.js';

function program(){
    const at='2026-09-25T06:00:00.000Z';

    const envelope=createProgramOutputEnvelope({
        version:1,
        publisherSessionId:'publisher-a',
        revision:7,
        publishedAt:at,
        committedAt:at,

        scene:{
            id:'scene-a',
            name:'PROGRAM A',
            type:'MEDIA'
        },

        source:{
            id:'media-a',
            kind:'media',
            url:'https://example.test/source.mp4'
        },

        playback:{
            initialTime:27,
            duration:120,
            playing:true,
            ended:false,
            state:'playing',
            startedAt:at
        },

        graphics:{items:[]},

        transition:{
            type:'cut',
            durationMs:0
        }
    });

    assert.ok(envelope);
    return envelope;
}

function transaction(){
    return createScheduledLiveTransaction({
        eventId:'scheduled-live-1',
        sourceId:'live-a',
        program:program(),
        manualIntentRevision:11,
        capturedAt:590000
    });
}

function repository(change={}){
    const writes=[];

    return {
        status:'READY',
        record:null,

        async write(record){
            writes.push(record);
            this.record=record;
            return record;
        },

        writes,

        ...change
    };
}

test('captured scheduled transaction persists through repository',async()=>{
    const repo=repository();

    const coordinator=
        new ScheduledLivePersistenceCoordinator({
            repository:repo
        });

    const tx=transaction();

    const result=await coordinator.persist(tx);

    assert.equal(result.persisted,true);
    assert.equal(result.eventId,'scheduled-live-1');
    assert.equal(result.sourceId,'live-a');
    assert.equal(result.state,'CAPTURED');

    assert.equal(result.executionAllowed,false);
    assert.equal(result.serverTake,false);

    assert.equal(repo.writes.length,1);
    assert.deepEqual(repo.writes[0],tx);
});

test('persistence fails closed when repository is unavailable',async()=>{
    const coordinator=
        new ScheduledLivePersistenceCoordinator({
            repository:repository({
                status:'CORRUPT'
            })
        });

    await assert.rejects(
        coordinator.persist(transaction()),
        /SCHEDULED_LIVE_PERSISTENCE_UNAVAILABLE/
    );
});

test('persistence propagates repository write failure',async()=>{
    const coordinator=
        new ScheduledLivePersistenceCoordinator({
            repository:repository({
                async write(){
                    throw Object.assign(
                        new Error(
                            'SCHEDULED_LIVE_TRANSACTION_UNAVAILABLE'
                        ),
                        {
                            code:
                                'SCHEDULED_LIVE_TRANSACTION_UNAVAILABLE'
                        }
                    );
                }
            })
        });

    await assert.rejects(
        coordinator.persist(transaction()),
        /SCHEDULED_LIVE_TRANSACTION_UNAVAILABLE/
    );
});

test('hydrate restores canonical transaction without execution authority',()=>{
    const tx=transaction();

    const coordinator=
        new ScheduledLivePersistenceCoordinator({
            repository:repository({
                record:structuredClone(tx)
            })
        });

    const hydrated=coordinator.hydrate();

    assert.deepEqual(hydrated,tx);
    assert.equal(hydrated.executionAllowed,false);
    assert.equal(hydrated.serverTake,false);

    const snapshot=coordinator.snapshot();

    assert.equal(snapshot.eventId,'scheduled-live-1');
    assert.equal(snapshot.state,'CAPTURED');
    assert.equal(snapshot.executionAllowed,false);
    assert.equal(snapshot.serverTake,false);
});

test('hydrate returns null when repository has no transaction',()=>{
    const coordinator=
        new ScheduledLivePersistenceCoordinator({
            repository:repository()
        });

    assert.equal(coordinator.hydrate(),null);
    assert.equal(coordinator.snapshot().eventId,null);
});

test('closed coordinator cannot persist or hydrate',async()=>{
    const coordinator=
        new ScheduledLivePersistenceCoordinator({
            repository:repository({
                record:transaction()
            })
        });

    coordinator.close();

    assert.equal(coordinator.hydrate(),null);

    await assert.rejects(
        coordinator.persist(transaction()),
        /SCHEDULED_LIVE_PERSISTENCE_CLOSED/
    );
});

test('coordinator never exposes execution authority',async()=>{
    const coordinator=
        new ScheduledLivePersistenceCoordinator({
            repository:repository()
        });

    await coordinator.persist(transaction());

    const snapshot=coordinator.snapshot();

    assert.equal(snapshot.executionAllowed,false);
    assert.equal(snapshot.serverTake,false);

    assert.equal(
        Object.hasOwn(snapshot,'programCommits'),
        false
    );
});
