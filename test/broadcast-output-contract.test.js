import test from 'node:test';
import assert from 'node:assert/strict';

import {
    defaultBroadcastOutputs,
    normalizeBroadcastOutput,
    outputCanPublish
} from '../server/broadcast-output/BroadcastOutputContract.js';

test('default outputs expose four independent destinations without authority', () => {
    const outputs = defaultBroadcastOutputs();

    assert.equal(outputs.length, 4);
    assert.deepEqual(
        outputs.map(value => value.type),
        ['primecast', 'youtube', 'facebook', 'custom-rtmp']
    );

    for (const output of outputs) {
        assert.equal(output.broadcastAuthority, false);
        assert.equal(output.enabled, false);
        assert.equal(output.state, 'DISABLED');
    }
});

test('configured and enabled do not grant publishing authority', () => {
    const output = normalizeBroadcastOutput({
        id: 'output-1',
        name: 'Primecast',
        type: 'primecast',
        configured: true,
        enabled: true,
        state: 'IDLE'
    });

    const decision = outputCanPublish(output);

    assert.equal(decision.requested, true);
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, 'BROADCAST_AUTHORITY_DISABLED');
});

test('browser-facing output contract cannot persist credentials', () => {
    const output = normalizeBroadcastOutput({
        id: 'output-1',
        name: 'Primecast',
        type: 'primecast',
        configured: true,
        enabled: true,
        streamKey: 'SECRET',
        publishUrl: 'rtmp://example.invalid/live/SECRET'
    });

    assert.equal(Object.hasOwn(output, 'streamKey'), false);
    assert.equal(Object.hasOwn(output, 'publishUrl'), false);
});
