import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

import BrowserExecutionOwnership
    from '../server/autolive/BrowserExecutionOwnership.js';

async function harness(t){
    const dir=await mkdtemp(
        join(tmpdir(),'lz-scheduled-owner-')
    );

    t.after(
        ()=>rm(dir,{recursive:true,force:true})
    );

    let now=1000;

    const owner=new BrowserExecutionOwnership({
        path:join(dir,'authority.json'),
        clock:()=>now,
        leaseMs:15000
    });

    await owner.ready;

    return {
        owner,
        advance:ms=>now+=ms,
        acquire:(instance='tab-a',publisher='publisher-a')=>
            owner.operate({
                operation:'acquire',
                ownerInstanceId:instance,
                publisherSessionId:publisher
            },'operator')
    };
}

test('scheduled suppression retires active browser grant without PROGRAM action',async t=>{
    const h=await harness(t);

    const acquired=await h.acquire();

    assert.ok(acquired.grant);

    const beforeRevision=
        h.owner.grantRevision;

    assert.equal(
        h.owner.suppressForScheduled('scheduled-live-1'),
        true
    );

    const state=h.owner.snapshot();

    assert.equal(state.state,'NO_OWNER');
    assert.equal(state.reason,'SCHEDULED_OVERRIDE');
    assert.equal(state.scheduledSuppressed,true);
    assert.equal(state.scheduledEventId,'scheduled-live-1');
    assert.equal(state.executionAllowed,false);
    assert.equal(state.serverTake,false);

    /*
     * Existing matches() contract may return null when no
     * active grant exists. Boolean normalization expresses
     * the security property we actually require: the retired
     * grant no longer matches.
     */
    assert.equal(
        Boolean(
            h.owner.matches(
                acquired.grant,
                'operator'
            )
        ),
        false
    );

    assert.ok(
        h.owner.grantRevision>beforeRevision
    );

    await h.owner.close();
});

test('browser cannot reacquire while scheduled sequence owns suppression',async t=>{
    const h=await harness(t);

    assert.equal(
        h.owner.suppressForScheduled('scheduled-live-1'),
        true
    );

    const attempt=await h.acquire(
        'tab-waiting',
        'publisher-waiting'
    );

    assert.equal(attempt.grant,null);

    assert.equal(
        h.owner.snapshot().scheduledSuppressed,
        true
    );

    await h.owner.close();
});

test('same scheduled event may idempotently retain suppression',async t=>{
    const h=await harness(t);

    assert.equal(
        h.owner.suppressForScheduled('scheduled-live-1'),
        true
    );

    const revision=h.owner.grantRevision;

    assert.equal(
        h.owner.suppressForScheduled('scheduled-live-1'),
        true
    );

    assert.equal(
        h.owner.snapshot().scheduledEventId,
        'scheduled-live-1'
    );

    assert.ok(
        h.owner.grantRevision>=revision
    );

    await h.owner.close();
});

test('different scheduled event cannot steal active scheduled suppression',async t=>{
    const h=await harness(t);

    assert.equal(
        h.owner.suppressForScheduled('scheduled-live-1'),
        true
    );

    assert.equal(
        h.owner.suppressForScheduled('scheduled-live-2'),
        false
    );

    assert.equal(
        h.owner.snapshot().scheduledEventId,
        'scheduled-live-1'
    );

    await h.owner.close();
});

test('only owning scheduled event can release suppression',async t=>{
    const h=await harness(t);

    h.owner.suppressForScheduled(
        'scheduled-live-1'
    );

    assert.equal(
        h.owner.releaseScheduled('scheduled-live-2'),
        false
    );

    assert.equal(
        h.owner.snapshot().scheduledSuppressed,
        true
    );

    assert.equal(
        h.owner.releaseScheduled('scheduled-live-1'),
        true
    );

    const state=h.owner.snapshot();

    assert.equal(state.scheduledSuppressed,false);
    assert.equal(state.scheduledEventId,null);
    assert.equal(state.reason,'NO_OWNER');

    const acquired=await h.acquire(
        'tab-new',
        'publisher-new'
    );

    assert.ok(acquired.grant);

    await h.owner.close();
});

test('manual override clears scheduled suppression and remains dominant',async t=>{
    const h=await harness(t);

    h.owner.suppressForScheduled(
        'scheduled-live-1'
    );

    h.owner.revokeForManual(
        'manual-publisher'
    );

    const state=h.owner.snapshot();

    assert.equal(state.scheduledSuppressed,false);
    assert.equal(state.scheduledEventId,null);
    assert.equal(state.manualSuppressed,true);
    assert.equal(state.reason,'MANUAL_OVERRIDE');

    const attempt=await h.acquire(
        'waiting',
        'waiting-publisher'
    );

    assert.equal(attempt.grant,null);

    await h.owner.close();
});

test('restart-blocked authority cannot enter scheduled suppression',async t=>{
    const h=await harness(t);

    h.owner.restartBlocked=true;
    h.owner.reason='RESTART_RECONCILIATION_REQUIRED';

    assert.equal(
        h.owner.suppressForScheduled('scheduled-live-1'),
        false
    );

    assert.equal(
        h.owner.snapshot().scheduledSuppressed,
        false
    );

    await h.owner.close();
});

test('invalid scheduled identity is rejected',async t=>{
    const h=await harness(t);

    assert.throws(
        ()=>h.owner.suppressForScheduled('bad id'),
        /INVALID_SCHEDULED_OWNER/
    );

    assert.equal(
        h.owner.releaseScheduled('bad id'),
        false
    );

    await h.owner.close();
});

test('scheduled suppression never advertises execution authority',async t=>{
    const h=await harness(t);

    h.owner.suppressForScheduled(
        'scheduled-live-1'
    );

    const state=h.owner.snapshot();

    assert.equal(state.executionAllowed,false);
    assert.equal(state.serverTake,false);

    await h.owner.close();
});
