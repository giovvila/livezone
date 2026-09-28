import assert from 'node:assert/strict';

import ScheduledLiveExecutionCoordinator from
    '../server/scheduler/ScheduledLiveExecutionCoordinator.js';

function transaction(overrides={}){
    return {
        version:1,
        eventId:'event-1',
        sourceId:'source-1',
        state:'LIVE',
        executionAllowed:false,
        serverTake:false,
        ...overrides
    };
}

function fence(overrides={}){
    return {
        version:1,
        allowed:true,
        reason:'SCHEDULED_SEQUENCE_OWNS',
        scheduledOwnsSequence:true,
        suppressBrowser:true,
        executionAllowed:false,
        serverTake:false,
        ...overrides
    };
}

function createHarness({
    manualIntentRevision=7,
    manualPending=false,
    authorityAvailable=true,
    authorityClosed=false,
    restartBlocked=false
}={}){
    const calls=[];

    const ownership={
        available:authorityAvailable,
        closed:authorityClosed,
        restartBlocked
    };

    const reconciliation={
        manualIntentRevision,
        manualPending
    };

    const activeTransaction=transaction();

    const scheduledOwnership={
        transaction:()=>structuredClone(activeTransaction)
    };

    const mutations={
        async run(callback){
            calls.push('mutation:start');
            const result=await callback();
            calls.push('mutation:end');
            return result;
        }
    };

    const commits={
        async accept(payload,{check}={}){
            calls.push('commit:accept');

            assert.equal(
                typeof check,
                'function',
                'scheduled commit must supply final authority check'
            );

            if(!check()){
                return {
                    accepted:false,
                    reason:'execution-owner-required'
                };
            }

            calls.push('commit:checked');

            return {
                accepted:true,
                reason:'accepted',
                envelope:{
                    snapshot:payload
                }
            };
        }
    };

    const coordinator=
        new ScheduledLiveExecutionCoordinator({
            ownership,
            reconciliation,
            scheduledOwnership,
            mutations,
            commits
        });

    return {
        coordinator,
        ownership,
        reconciliation,
        scheduledOwnership,
        mutations,
        commits,
        calls,
        activeTransaction
    };
}

async function testAcceptedCommitUsesSharedMutationAndCommitPath(){
    const h=createHarness();

    const payload={
        version:1,
        publisherSessionId:'scheduled:event-1',
        revision:1
    };

    const result=await h.coordinator.commit({
        expectedState:'LIVE',
        eventId:'event-1',
        sourceId:'source-1',
        fence:fence(),
        manualIntentRevision:7,
        payload
    });

    assert.equal(result.accepted,true);

    assert.deepEqual(
        h.calls,
        [
            'mutation:start',
            'commit:accept',
            'commit:checked',
            'mutation:end'
        ]
    );
}

async function testManualRevisionChangeBeforeCommitFailsInitialFence(){
    const h=createHarness();

    /*
     * Manual intent already changed before Scheduled enters
     * the shared mutation path. Initial fence must reject
     * without touching mutations or PROGRAM commits.
     */
    h.reconciliation.manualIntentRevision=8;

    const result=await h.coordinator.commit({
        expectedState:'LIVE',
        eventId:'event-1',
        sourceId:'source-1',
        fence:fence(),
        manualIntentRevision:7,
        payload:{
            version:1,
            publisherSessionId:'scheduled:event-1',
            revision:1
        }
    });

    assert.equal(result.accepted,false);
    assert.equal(result.reason,'execution-owner-required');

    assert.deepEqual(
        h.calls,
        []
    );
}

async function testManualRevisionChangeDuringCommitFailsFinalFence(){
    const calls=[];

    const ownership={
        available:true,
        closed:false,
        restartBlocked:false
    };

    const reconciliation={
        manualIntentRevision:7,
        manualPending:false
    };

    const activeTransaction=transaction();

    const scheduledOwnership={
        transaction:()=>structuredClone(activeTransaction)
    };

    const mutations={
        async run(callback){
            calls.push('mutation:start');

            const result=await callback();

            calls.push('mutation:end');

            return result;
        }
    };

    let releaseBind;

    const bindGate=
        new Promise(resolve=>{
            releaseBind=resolve;
        });

    let bindStarted;

    const bindStartedGate=
        new Promise(resolve=>{
            bindStarted=resolve;
        });

    /*
     * This fake models the relevant ProgramCommitCoordinator
     * double-check contract:
     *
     * check #1
     * await bind/staging
     * check #2
     * install
     */
    let installed=false;

    const commits={
        async accept(payload,{check}={}){
            calls.push('commit:accept');

            if(!check()){
                return {
                    accepted:false,
                    reason:'execution-owner-required'
                };
            }

            calls.push('commit:check-1');

            bindStarted();

            await bindGate;

            calls.push('commit:after-await');

            if(!check()){
                return {
                    accepted:false,
                    reason:'execution-owner-required'
                };
            }

            calls.push('commit:check-2');

            installed=true;
            calls.push('commit:install');

            return {
                accepted:true,
                reason:'accepted',
                envelope:{
                    snapshot:payload
                }
            };
        }
    };

    const coordinator=
        new ScheduledLiveExecutionCoordinator({
            ownership,
            reconciliation,
            scheduledOwnership,
            mutations,
            commits
        });

    const pending=
        coordinator.commit({
            expectedState:'LIVE',
            eventId:'event-1',
            sourceId:'source-1',
            fence:fence(),
            manualIntentRevision:7,
            payload:{
                version:1,
                publisherSessionId:'scheduled:event-1',
                revision:1
            }
        });

    /*
     * Wait until Scheduled has passed its first commit fence
     * and is suspended inside the asynchronous bind/stage phase.
     */
    await bindStartedGate;

    /*
     * Manual intent arrives while Scheduled is awaiting.
     */
    reconciliation.manualIntentRevision=8;

    releaseBind();

    const result=await pending;

    assert.equal(result.accepted,false);
    assert.equal(result.reason,'execution-owner-required');

    assert.equal(
        installed,
        false,
        'PROGRAM must not install after manual intent wins race'
    );

    assert.deepEqual(
        calls,
        [
            'mutation:start',
            'commit:accept',
            'commit:check-1',
            'commit:after-await',
            'mutation:end'
        ]
    );
}
async function testManualPendingFailsClosed(){
    const h=createHarness({
        manualPending:true
    });

    const result=await h.coordinator.commit({
        expectedState:'LIVE',
        eventId:'event-1',
        sourceId:'source-1',
        fence:fence(),
        manualIntentRevision:7,
        payload:{
            version:1,
            publisherSessionId:'scheduled:event-1',
            revision:1
        }
    });

    assert.equal(result.accepted,false);
    assert.equal(result.reason,'execution-owner-required');
}

async function testRestartBlockedFailsClosed(){
    const h=createHarness({
        restartBlocked:true
    });

    const result=await h.coordinator.commit({
        expectedState:'LIVE',
        eventId:'event-1',
        sourceId:'source-1',
        fence:fence(),
        manualIntentRevision:7,
        payload:{
            version:1,
            publisherSessionId:'scheduled:event-1',
            revision:1
        }
    });

    assert.equal(result.accepted,false);
    assert.equal(result.reason,'execution-owner-required');
}

async function testTransactionIdentityChangeFailsClosed(){
    const h=createHarness();

    h.scheduledOwnership.transaction=()=>transaction({
        eventId:'event-2'
    });

    const result=await h.coordinator.commit({
        expectedState:'LIVE',
        eventId:'event-1',
        sourceId:'source-1',
        fence:fence(),
        manualIntentRevision:7,
        payload:{
            version:1,
            publisherSessionId:'scheduled:event-1',
            revision:1
        }
    });

    assert.equal(result.accepted,false);
    assert.equal(result.reason,'execution-owner-required');
}

async function testRejectedFenceNeverEntersCommitPath(){
    const h=createHarness();

    const result=await h.coordinator.commit({
        expectedState:'LIVE',
        eventId:'event-1',
        sourceId:'source-1',
        fence:fence({
            allowed:false,
            reason:'MANUAL_INTENT_DOMINATES',
            scheduledOwnsSequence:false,
            suppressBrowser:false
        }),
        manualIntentRevision:7,
        payload:{
            version:1,
            publisherSessionId:'scheduled:event-1',
            revision:1
        }
    });

    assert.equal(result.accepted,false);

    assert.deepEqual(
        h.calls,
        []
    );
}

const tests=[
    testAcceptedCommitUsesSharedMutationAndCommitPath,
    testManualRevisionChangeBeforeCommitFailsInitialFence,
    testManualRevisionChangeDuringCommitFailsFinalFence,
    testManualPendingFailsClosed,
    testRestartBlockedFailsClosed,
    testTransactionIdentityChangeFailsClosed,
    testRejectedFenceNeverEntersCommitPath
];

let passed=0;

for(const test of tests){
    try{
        await test();
        passed++;
        console.log(`PASS ${test.name}`);
    }
    catch(error){
        console.error(`FAIL ${test.name}`);
        console.error(error);
        process.exitCode=1;
    }
}

if(process.exitCode){
    console.error(
        `scheduled-live-execution-coordinator: ${passed}/${tests.length} PASS`
    );
}
else{
    console.log(
        `scheduled-live-execution-coordinator: ${passed}/${tests.length} PASS`
    );
}
