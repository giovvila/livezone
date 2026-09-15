// Control-plane contracts only. These policies do not introduce an executor.
export const POLICY = Object.freeze({ entryHealthyPlaybackMs: 30000,
    externalConfirmedLossMs: 15000, managedLegacyLossGraceMs: 5000,
    entryBasis: 'healthy-playback', editable: false });
export const PHASES = Object.freeze(['DISABLED','ARMED','ENTRY_PENDING','LIVE','LOSS_PENDING','RETURNING','ERROR','UNCERTAIN']);
export const error = code => Object.assign(new Error(code), { code });
export const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value);
export const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
export const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const revision = value => Number.isSafeInteger(value) && value >= 0;
const selection = value => typeof value.enabled === 'boolean' && typeof value.armed === 'boolean' && (value.sourceId === null || id(value.sourceId));

export function defaultConfig() {
    return normalizeConfig({ version:1, revision:0, enabled:false, armed:false, sourceId:null,
        updatedAt:null, migration:null });
}
export function normalizeConfig(value) {
    if (!exact(value,['version','revision','enabled','armed','sourceId','updatedAt','migration']) ||
        value.version !== 1 || !revision(value.revision) || !selection(value) ||
        !(value.updatedAt === null && value.revision === 0 || timestamp(value.updatedAt)) ||
        !(value.migration === null || exact(value.migration,['version','completedAt']) &&
            value.migration.version === 1 && timestamp(value.migration.completedAt)) ||
        value.revision === 0 && (value.enabled || value.armed || value.sourceId !== null || value.migration !== null)) throw error('INVALID_CONFIG');
    return freeze({ version:1, revision:value.revision, enabled:value.enabled, armed:value.armed,
        sourceId:value.sourceId, updatedAt:value.updatedAt,
        migration:value.migration === null ? null : {version:1,completedAt:value.migration.completedAt} });
}
export function normalizePatch(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length ||
        Object.keys(value).some(key => !['enabled','armed','sourceId'].includes(key)) ||
        Object.hasOwn(value,'enabled') && typeof value.enabled !== 'boolean' ||
        Object.hasOwn(value,'armed') && typeof value.armed !== 'boolean' ||
        Object.hasOwn(value,'sourceId') && value.sourceId !== null && !id(value.sourceId)) throw error('INVALID_PATCH');
    return Object.fromEntries(['enabled','armed','sourceId'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
}
export function normalizeLegacy(value) {
    if (!exact(value,['version','enabled','armed','sourceId']) || value.version !== 1 || !selection(value)) throw error('INVALID_MIGRATION');
    return { enabled:value.enabled, armed:value.armed, sourceId:value.sourceId };
}
function activation(value) {
    if (!exact(value,['publisherSessionId','committedAt','sceneId','sourceId']) || !id(value.publisherSessionId) ||
        !timestamp(value.committedAt) || !(value.sceneId===null&&value.sourceId===null || id(value.sceneId)&&id(value.sourceId))) throw error('INVALID_ACTIVATION');
    return {publisherSessionId:value.publisherSessionId,committedAt:value.committedAt,sceneId:value.sceneId,sourceId:value.sourceId};
}
export function normalizeRecovery(value) {
    const empty=value?.sceneId===null&&value?.sourceId===null&&value?.sourceKind===null&&value?.sourceVersion===null;
    if (!exact(value,['version','sessionId','stage','capturedActivation','programRevision','sceneId','sourceId',
        'sourceKind','sourceVersion','cueAtInterruption','playbackState','assets','createdAt','updatedAt','expectedCurrentActivation','actionKey']) ||
        value.version !== 1 || !id(value.sessionId) || !['CAPTURED','ENTRY_PENDING','LIVE','RETURN_PENDING','RETURNED'].includes(value.stage) ||
        !(value.programRevision === null || Number.isSafeInteger(value.programRevision) && value.programRevision > 0) ||
        !(empty || id(value.sceneId)&&id(value.sourceId)&&['media','audio','image','hls','break'].includes(value.sourceKind)&&id(value.sourceVersion)) ||
        !['playing','paused','ended','ready'].includes(value.playbackState) ||
        !(value.cueAtInterruption === null || Number.isFinite(value.cueAtInterruption) && value.cueAtInterruption >= 0) ||
        ['media','audio'].includes(value.sourceKind) && value.cueAtInterruption === null ||
        !Array.isArray(value.assets) || value.assets.length > 128 || !id(value.actionKey) ||
        !timestamp(value.createdAt) || !timestamp(value.updatedAt) || value.updatedAt < value.createdAt ||
        empty&&(value.cueAtInterruption!==null||value.playbackState!=='ready'||value.assets.length!==0)) throw error('INVALID_RECOVERY');
    const captured = activation(value.capturedActivation);
    if (captured.sceneId !== value.sceneId || captured.sourceId !== value.sourceId) throw error('INVALID_ACTIVATION');
    const assets = value.assets.map(asset => {
        if (!exact(asset,['assetId','kind']) || !/^asset-[0-9a-f-]{36}$/i.test(asset.assetId) ||
            !['video','audio','image'].includes(asset.kind)) throw error('INVALID_RECOVERY_ASSET');
        return {assetId:asset.assetId,kind:asset.kind};
    }).sort((a,b)=>a.assetId.localeCompare(b.assetId));
    if (new Set(assets.map(a=>a.assetId)).size !== assets.length) throw error('INVALID_RECOVERY_ASSET');
    return freeze({version:1,sessionId:value.sessionId,stage:value.stage,capturedActivation:captured,
        programRevision:value.programRevision,sceneId:value.sceneId,sourceId:value.sourceId,sourceKind:value.sourceKind,
        sourceVersion:value.sourceVersion,cueAtInterruption:value.cueAtInterruption,playbackState:value.playbackState,
        assets,createdAt:value.createdAt,updatedAt:value.updatedAt,
        expectedCurrentActivation:value.expectedCurrentActivation === null ? null : activation(value.expectedCurrentActivation),actionKey:value.actionKey});
}
export function normalizeRecoveryState(value) {
    if (!exact(value,['version','revision','record']) || value.version !== 1 || !revision(value.revision)) throw error('INVALID_RECOVERY_STATE');
    return freeze({version:1,revision:value.revision,record:value.record === null ? null : normalizeRecovery(value.record)});
}

export function runtimeSnapshot({config,sessionId,generation,now,sourceValid,available,recoveryAvailable}) {
    const active = config?.enabled && config?.armed;
    const invalid = Boolean(config && (config.sourceId !== null || active) && !sourceValid);
    return freeze({version:1,sessionId,generation,configRevision:config?.revision ?? null,
        executionAuthority:'browser-legacy',phaseScope:'configuration-only',
        phase:!available || !recoveryAvailable ? 'ERROR' : invalid ? 'UNCERTAIN' : active && sourceValid ? 'ARMED' : 'DISABLED',
        sourceId:config?.sourceId ?? null,resolvedSourceFingerprint:null,healthAuthority:null,healthState:'UNKNOWN',
        healthSequence:null,healthCheckedAt:null,healthValidUntil:null,phaseStartedAt:now,
        entryHealthyMs:0,deadline:null,lastAction:null,lastError:!available ? 'STORE_UNAVAILABLE' : !recoveryAvailable ? 'RECOVERY_UNAVAILABLE' : invalid ? 'SOURCE_UNRESOLVED' : null,
        overrideSuppressed:null,expectedProgramActivation:null});
}
