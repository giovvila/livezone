import test from 'node:test';
import assert from 'node:assert/strict';

import {
    mkdtemp,
    rm,
    readFile,
    writeFile
} from 'node:fs/promises';

import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

import Repository
    from '../server/scheduler/ScheduledLiveExecutionRepository.js';

import {
    createScheduledLiveTransaction,
    scheduledLiveTransactionEnvelope
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
        sourceId:'primecast',
        program:program(),
        manualIntentRevision:11,
        capturedAt:590000
    });
}

async function fixture(t){
    const dir=await mkdtemp(
        join(tmpdir(),'lz-scheduled-live-')
    );

    t.after(
        ()=>rm(
            dir,
            {recursive:true,force:true}
        )
    );

    return {
        dir,
        path:resolve(
            join(dir,'scheduled-live-transaction.json')
        )
    };
}

test('repository requires private absolute path',()=>{
    assert.throws(
        ()=>new Repository({
            path:'relative.json'
        }),
        /PRIVATE_SCHEDULED_LIVE_PATH_REQUIRED/
    );
});

test('empty repository initializes READY with no record',async t=>{
    const h=await fixture(t);

    const repository=
        new Repository({path:h.path});

    await repository.initialize();

    assert.equal(repository.status,'READY');
    assert.equal(repository.record,null);

    await repository.close();
});

test('transaction persists atomically and hydrates after clean restart',async t=>{
    const h=await fixture(t);

    const first=
        new Repository({path:h.path});

    await first.initialize();

    const tx=transaction();

    await first.write(tx);

    assert.deepEqual(
        first.record,
        tx
    );

    const disk=
        JSON.parse(
            await readFile(h.path,'utf8')
        );

    assert.deepEqual(
        disk,
        scheduledLiveTransactionEnvelope(tx)
    );

    await first.close();

    const second=
        new Repository({path:h.path});

    await second.initialize();

    assert.equal(second.status,'READY');

    assert.deepEqual(
        second.record,
        tx
    );

    /*
     * Hydration restores data only.
     * It grants no execution authority.
     */
    assert.equal(
        second.record.executionAllowed,
        false
    );

    assert.equal(
        second.record.serverTake,
        false
    );

    await second.close();
});

test('second simultaneous repository is LOCKED',async t=>{
    const h=await fixture(t);

    const first=
        new Repository({path:h.path});

    const second=
        new Repository({path:h.path});

    await first.initialize();
    await second.initialize();

    assert.equal(first.status,'READY');
    assert.equal(second.status,'LOCKED');
    assert.equal(second.record,null);

    await second.close();
    await first.close();
});

test('tampered persisted transaction fails closed as CORRUPT',async t=>{
    const h=await fixture(t);

    const first=
        new Repository({path:h.path});

    await first.initialize();

    await first.write(
        transaction()
    );

    await first.close();

    const disk=
        JSON.parse(
            await readFile(h.path,'utf8')
        );

    disk.record.capturedProgram.snapshot.scene.name=
        'TAMPERED';

    await writeFile(
        h.path,
        JSON.stringify(disk)
    );

    const second=
        new Repository({path:h.path});

    await second.initialize();

    assert.equal(second.status,'CORRUPT');
    assert.equal(second.record,null);

    await second.close();
});

test('failed replacement enters RECOVERY_BLOCKED',async t=>{
    const h=await fixture(t);

    const repository=
        new Repository({
            path:h.path,
            hook(stage){
                if(stage==='replaced')
                    throw new Error('simulated-after-replace-failure');
            }
        });

    await repository.initialize();

    await assert.rejects(
        repository.write(
            transaction()
        )
    );

    assert.equal(
        repository.status,
        'RECOVERY_BLOCKED'
    );

    await repository.close();
});

test('close removes exclusive lock after queued writes drain',async t=>{
    const h=await fixture(t);

    const first=
        new Repository({path:h.path});

    await first.initialize();

    await first.write(
        transaction()
    );

    await first.close();

    const second=
        new Repository({path:h.path});

    await second.initialize();

    assert.equal(
        second.status,
        'READY'
    );

    await second.close();
});
