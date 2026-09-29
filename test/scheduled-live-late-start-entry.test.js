import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {scheduledPublisher} from '../test-support/ScheduledEntryTestIdentity.js';
import {harness,START,END,event} from '../test-support/ScheduledEntryHarness.js';

for (const lateMs of [0, 1, 20, 1000]) {
    test(`C6A superseded event cannot TAKE at START+${lateMs}ms`, async t => {
        const h = await harness(t);
        const winner = {...event, id:'higher-priority', priority:20};
        const revision = h.owner.scheduler.store.getSnapshot().revision;
        assert.equal((await h.owner.scheduler.store.insert(winner, revision)).ok, true);
        h.fire(START + lateMs); await h.settle();
        assert.equal(h.owner.scheduler.runtime.getSnapshot().activeEvents[0].id, winner.id);
        assert.equal(h.owner.liveAutomation.getSnapshot().eventId, winner.id);
        h.fire(START + lateMs + 1000); await h.settle();
        assert.equal(h.captures.filter(c=>c.input.eventId === event.id).length, 0);
        assert.equal(h.commits.filter(c=>c.input.eventId === event.id).length, 0);
        if (lateMs === 0) {
            assert.equal(h.acceptedLive().length, 1, 'winner must actually enter at exact START');
            assert.equal(h.owner.store.getCurrent().publisherSessionId, scheduledPublisher(h.owner,'higher-priority'));
        }
    });
}

for (const lateMs of [0, 1, 20, 1000]) {
    test(`C6A first START callback +${lateMs}ms installs exactly one Scheduled LIVE`, {timeout:10000}, async t => {
        const h = await harness(t);
        h.fire(START + lateMs);
        await h.settle();
        const first = {
            state:h.owner.liveAutomation.getSnapshot().state,
            captures:h.captures.length, acceptedLive:h.acceptedLive().length,
            publisher:h.owner.store.getCurrent().publisherSessionId
        };
        // Further real timer evaluations must neither lose entry nor duplicate it.
        for (const offset of [START + lateMs + 1000, START + lateMs + 2000, END - 1]) {
            h.fire(offset); await h.settle();
        }
        t.diagnostic(JSON.stringify({lateMs, first, finalAcceptedLive:h.acceptedLive().length}));
        assert.equal(first.acceptedLive, 1,
            `first eligible callback must commit LIVE: ${JSON.stringify(first)}`);
        assert.equal(first.captures, 1);
        assert.equal(first.publisher, scheduledPublisher(h.owner,'late-entry'));
        assert.equal(h.captures.length, 1, 'repeated evaluations must not reacquire the event');
        assert.equal(h.acceptedLive().length, 1, 'no duplicate TAKE');
        assert.equal(h.owner.scheduledLiveOwnership.transaction().state, 'LIVE');
        assert.equal(h.owner.scheduledLiveExecutionRepository.record.state, 'LIVE');
        const durable = JSON.parse(await readFile(h.path, 'utf8'));
        assert.equal(durable.envelope.publisherSessionId, scheduledPublisher(h.owner,'late-entry'));
        assert.equal(durable.generation, 2, 'retained PROGRAM plus exactly one LIVE commit');
    });
}

for (const offset of [END, END + 1, END + 1000]) {
    test(`C6A first evaluation at END+${offset-END}ms cannot TAKE`, async t => {
        const h = await harness(t);
        h.fire(offset); await h.settle();
        assert.equal(h.captures.length, 0);
        assert.equal(h.commits.length, 0);
        await h.unchanged();
    });
}

for (const lateMs of [0, 1, 20, 1000]) {
    for (const guard of ['disabled', 'source-not-ready', 'restart-fence', 'manual-fence']) {
        test(`C6A ${guard} prevents first START+${lateMs}ms TAKE`, async t => {
            const h = await harness(t, {enabled:guard !== 'disabled', ready:guard !== 'source-not-ready'});
            let finish;
            if (guard === 'restart-fence') h.owner.executionOwnership.restartBlocked = true;
            if (guard === 'manual-fence') finish = h.owner.scheduledLiveExecution.reconciliation.beginManualIntent();
            try {
                h.fire(START + lateMs); await h.settle();
                h.fire(START + lateMs + 1000); await h.settle();
                assert.equal(h.captures.filter(c=>c.result.accepted).length, 0);
                assert.equal(h.commits.length, 0);
                await h.unchanged();
                // Exact START proves these fences are exercised, not just hidden
                // by the late-entry defect. Late cases protect the future fix.
                if (lateMs === 0 && guard.endsWith('fence')) {
                    assert.equal(h.captures.length, 0,'fences now reject before durable consumption/capture');
                    assert.equal(h.owner.scheduledEntry.ledger.snapshot.entries.length,0);
                    assert.ok(h.owner.scheduledEntry.diagnostics().some(e=>e.decision===
                        (guard === 'restart-fence' ? 'AUTHORITY_BLOCKED' : 'MANUAL_BLOCKED')));
                }
            } finally { finish?.(); }
        });
    }
}

test('C6A pending entry cannot overwrite a newer manual PROGRAM', {timeout:10000}, async t => {
    const h = await harness(t);
    const hold = h.holdPreroll();
    h.fire(START);
    await hold.entered;
    assert.equal(h.captures[0].result.accepted, true);
    const newer = await h.manual();
    const bytes = await readFile(h.path, 'utf8');
    h.fire(START + 1000);
    hold.release();
    await h.settle();
    h.fire(START + 2000); await h.settle();
    assert.equal(h.acceptedLive().length, 0);
    await h.unchanged(newer, bytes);
});

test('C6A restart during LIVE never replays the already executed event', {timeout:10000}, async t => {
    const h = await harness(t);
    h.fire(START); await h.settle();
    assert.equal(h.acceptedLive().length, 1, 'restart guard requires an actual successful entry');
    const before = h.owner.store.getCurrent();
    const bytes = await readFile(h.path, 'utf8');
    await h.restart(START + 20);
    assert.equal(h.owner.executionOwnership.restartBlocked, true);
    h.fire(START + 1020); await h.settle();
    assert.equal(h.acceptedLive().length, 1);
    assert.equal(h.captures.filter(c=>c.result.accepted).length, 1);
    assert.equal(h.owner.scheduledLiveOwnership.transaction(), null);
    await h.unchanged(before, bytes);
    // A real manual commit clears the restart block through canonical ownership.
    // Even then a subsequent tick must not replay the previously executed event.
    const newer = await h.manual();
    assert.equal(h.owner.executionOwnership.restartBlocked, false);
    const newerBytes = await readFile(h.path, 'utf8');
    h.fire(START + 2020); await h.settle();
    assert.equal(h.acceptedLive().length, 1);
    assert.equal(h.captures.filter(c=>c.result.accepted).length, 1);
    await h.unchanged(newer, newerBytes);
});
