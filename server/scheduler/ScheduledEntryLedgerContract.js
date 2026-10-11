import {createHash, randomUUID} from 'node:crypto';
import {scheduledEntryIdentity, entryTimestamp} from './ScheduledEntryIdentity.js';

const fail = () => { throw new TypeError('INVALID_SCHEDULED_ENTRY_LEDGER'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export function entryConsumption(identity, context) {
    if (!object(context) || !Number.isSafeInteger(context.authorityEpoch) || context.authorityEpoch < 1 ||
        typeof context.authorityProcessSession !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(context.authorityProcessSession)) fail();
    return freeze({identity:scheduledEntryIdentity(identity), consumptionId:randomUUID(),
        consumedAt:entryTimestamp(context.consumedAt), authorityEpoch:context.authorityEpoch,
        authorityProcessSession:context.authorityProcessSession, state:'ENTRY_CONSUMED'});
}

export function ledgerSnapshot({ledgerId=randomUUID(), generation=0, entries=[],executionEraId,retirementHash} = {}) {
    const era=executionEraId!==undefined;
    if(era&&(!uuid(executionEraId)||typeof retirementHash!=='string'||!/^[a-f0-9]{64}$/.test(retirementHash)))fail();
    if(!era&&retirementHash!==undefined)fail();
    if (!uuid(ledgerId) || !Number.isSafeInteger(generation) || generation < 0 || !Array.isArray(entries) || generation !== entries.length) fail();
    const canonicalEntries = entries.map(record => {
        if (!exact(record,['identity','consumptionId','consumedAt','authorityEpoch','authorityProcessSession','state']) ||
            record.state !== 'ENTRY_CONSUMED' || !uuid(record.consumptionId)) fail();
        const identity = scheduledEntryIdentity(record.identity);
        if(era?identity.identitySchema!==2||identity.executionEraId!==executionEraId:identity.identitySchema!==1)fail();
        if (!exact(record.identity,Object.keys(identity)) ||
            Object.keys(identity).some(key=>record.identity[key] !== identity[key])) fail();
        // Validate context without adding outcome/authority semantics to the ledger.
        if (!Number.isSafeInteger(record.authorityEpoch) || record.authorityEpoch < 1 ||
            typeof record.authorityProcessSession !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(record.authorityProcessSession) ||
            entryTimestamp(record.consumedAt) !== record.consumedAt) fail();
        return {identity, consumptionId:record.consumptionId, consumedAt:record.consumedAt,
            authorityEpoch:record.authorityEpoch, authorityProcessSession:record.authorityProcessSession, state:'ENTRY_CONSUMED'};
    }).sort((a,b)=>a.identity.entryKey < b.identity.entryKey ? -1 : a.identity.entryKey > b.identity.entryKey ? 1 : 0);
    if (new Set(canonicalEntries.map(r=>r.identity.entryKey)).size !== entries.length ||
        new Set(canonicalEntries.map(r=>r.consumptionId)).size !== entries.length) fail();
    const payload = {schemaVersion:era?2:1,...(era?{executionEraId,retirementHash}:{}), ledgerId, generation, entries:canonicalEntries};
    return freeze({...payload, checksum:{algorithm:'sha256', value:digest(payload)}});
}

export function validateLedgerSnapshot(value) {
    if (!exact(value,['schemaVersion','ledgerId','generation','entries','checksum',...(value?.schemaVersion===2?['executionEraId','retirementHash']:[])]) || ![1,2].includes(value.schemaVersion) ||
        !exact(value.checksum,['algorithm','value']) || value.checksum.algorithm !== 'sha256') fail();
    const canonical = ledgerSnapshot(value);
    if (canonical.schemaVersion!==value.schemaVersion||canonical.checksum.value !== value.checksum.value) fail();
    return canonical;
}
