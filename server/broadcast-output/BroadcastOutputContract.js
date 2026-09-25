const ID = /^[a-zA-Z0-9_-]{1,64}$/;

export const OUTPUT_TYPES = Object.freeze([
    'primecast',
    'youtube',
    'facebook',
    'custom-rtmp'
]);

export const OUTPUT_STATES = Object.freeze([
    'DISABLED',
    'IDLE',
    'STARTING',
    'PUBLISHING',
    'STOPPING',
    'ERROR'
]);

function fail(code) {
    throw Object.assign(new Error(code), { code });
}

function cleanString(value, max = 128) {
    if (typeof value !== 'string') return null;
    const result = value.trim();
    return result && result.length <= max ? result : null;
}

export function normalizeBroadcastOutput(value) {
    if (!value || typeof value !== 'object') fail('OUTPUT_INVALID');

    const id = cleanString(value.id, 64);
    const name = cleanString(value.name, 128);
    const type = cleanString(value.type, 32);

    if (!id || !ID.test(id)) fail('OUTPUT_ID_INVALID');
    if (!name) fail('OUTPUT_NAME_INVALID');
    if (!OUTPUT_TYPES.includes(type)) fail('OUTPUT_TYPE_INVALID');

    /*
     * Credentials, stream keys and complete publishing URLs are deliberately
     * absent from this contract. They belong to private server configuration.
     */
    return Object.freeze({
        id,
        name,
        type,
        configured: value.configured === true,
        enabled: value.enabled === true,
        state: OUTPUT_STATES.includes(value.state)
            ? value.state
            : value.enabled === true
                ? 'IDLE'
                : 'DISABLED',

        /*
         * 1003.9A1 foundation is observation/configuration only.
         * No caller can grant publishing authority through persisted/UI data.
         */
        broadcastAuthority: false
    });
}

export function outputCanPublish(output) {
    const value = normalizeBroadcastOutput(output);

    return Object.freeze({
        outputId: value.id,
        configured: value.configured,
        enabled: value.enabled,
        requested: value.configured && value.enabled,
        authorized: false,
        reason: !value.configured
            ? 'OUTPUT_NOT_CONFIGURED'
            : !value.enabled
                ? 'OUTPUT_DISABLED'
                : 'BROADCAST_AUTHORITY_DISABLED'
    });
}

export function defaultBroadcastOutputs() {
    return Object.freeze([
        normalizeBroadcastOutput({
            id: 'output-1',
            name: 'Primecast',
            type: 'primecast'
        }),
        normalizeBroadcastOutput({
            id: 'output-2',
            name: 'YouTube',
            type: 'youtube'
        }),
        normalizeBroadcastOutput({
            id: 'output-3',
            name: 'Facebook',
            type: 'facebook'
        }),
        normalizeBroadcastOutput({
            id: 'output-4',
            name: 'Custom RTMP',
            type: 'custom-rtmp'
        })
    ]);
}
