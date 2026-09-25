import assert from 'node:assert/strict';

import {
    scheduledLivePublisherSessionId,
    scheduledLiveProgramIdentity
} from '../server/scheduler/ScheduledLiveProgramIdentity.js';

const tests=[];

function test(name,fn){
    tests.push([name,fn]);
}

test(
    'publisher identity is deterministic and event scoped',
    ()=>{
        assert.equal(
            scheduledLivePublisherSessionId('event-1'),
            'scheduled:event-1'
        );

        assert.equal(
            scheduledLivePublisherSessionId('event-1'),
            scheduledLivePublisherSessionId('event-1')
        );

        assert.notEqual(
            scheduledLivePublisherSessionId('event-1'),
            scheduledLivePublisherSessionId('event-2')
        );
    }
);

test(
    'first Scheduled PROGRAM generation starts at revision one',
    ()=>{
        assert.deepEqual(
            scheduledLiveProgramIdentity({
                eventId:'event-1',
                revision:1
            }),
            {
                publisherSessionId:'scheduled:event-1',
                revision:1
            }
        );
    }
);

test(
    'same event may advance monotonically inside its own publisher session',
    ()=>{
        const first=
            scheduledLiveProgramIdentity({
                eventId:'event-1',
                revision:1
            });

        const second=
            scheduledLiveProgramIdentity({
                eventId:'event-1',
                revision:2
            });

        assert.equal(
            first.publisherSessionId,
            second.publisherSessionId
        );

        assert.equal(first.revision,1);
        assert.equal(second.revision,2);
    }
);

test(
    'different events do not share publisher identity',
    ()=>{
        const first=
            scheduledLiveProgramIdentity({
                eventId:'event-1',
                revision:1
            });

        const second=
            scheduledLiveProgramIdentity({
                eventId:'event-2',
                revision:1
            });

        assert.notEqual(
            first.publisherSessionId,
            second.publisherSessionId
        );

        assert.equal(first.revision,1);
        assert.equal(second.revision,1);
    }
);

test(
    'invalid event identity fails closed',
    ()=>{
        for(const eventId of [
            undefined,
            null,
            '',
            ' ',
            '../event',
            'event/child',
            'x'.repeat(97)
        ]){
            assert.throws(
                ()=>scheduledLivePublisherSessionId(eventId),
                {
                    name:'TypeError',
                    message:
                        'INVALID_SCHEDULED_LIVE_EVENT_ID'
                }
            );
        }
    }
);

test(
    'invalid revision fails closed',
    ()=>{
        for(const revision of [
            undefined,
            null,
            0,
            -1,
            1.5,
            Number.MAX_SAFE_INTEGER+1
        ]){
            assert.throws(
                ()=>scheduledLiveProgramIdentity({
                    eventId:'event-1',
                    revision
                }),
                {
                    name:'TypeError',
                    message:
                        'INVALID_SCHEDULED_LIVE_PROGRAM_REVISION'
                }
            );
        }
    }
);

let passed=0;

for(const [name,fn] of tests){
    try{
        await fn();
        passed++;
        console.log(`PASS ${name}`);
    }
    catch(error){
        console.error(`FAIL ${name}`);
        console.error(error);
        process.exitCode=1;
    }
}

console.log(
    `scheduled-live-program-identity: ${passed}/${tests.length} PASS`
);

if(passed!==tests.length)
    process.exitCode=1;
