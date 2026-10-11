import {createHash, randomUUID} from 'node:crypto';
import {readdir, open, unlink} from 'node:fs/promises';
import {readdirSync, openSync, closeSync, fsyncSync, renameSync} from 'node:fs';
import {dirname, basename, join} from 'node:path';
import {repositoryIdentity} from './ScheduledExecutionProvenance.js';
import {ledgerSnapshot, validateLedgerSnapshot} from './ScheduledEntryLedgerContract.js';
import {directorySync,createLedgerV2Durability} from './LedgerV2Durability.js';
import {readEvidence,readEvidenceSync} from '../recovery/PersistentEvidence.js';
import {namespaceStarts,namespaceEnds,assertCanonicalNames} from '../recovery/RecoveryNamespace.js';
export {directorySync} from './LedgerV2Durability.js';

export const fail = code => {throw Object.assign(Error(code), {code});};
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const equal = (a,b) => canonical(a) === canonical(b);
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0;
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
// Only recoverV2 can enable reuse of an empty stage, after canonical inspection.
const emptyStageRecovery = Symbol('verified pending Ledger transaction');
const exact = (v,keys) => v && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
export const seal = payload => ({...payload, checksum:hash(payload)});
function unseal(value) {
    if (!value || typeof value !== 'object') fail('LEDGER_V2_CORRUPT');
    const {checksum,...payload}=value;
    if (!sha(checksum) || checksum !== hash(payload)) fail('LEDGER_V2_CHECKSUM');
    return payload;
}
export function validateV2Lock(lock,path) {
    if (lock?.version === 1) fail('LEGACY_LEDGER_LOCK_UNVERIFIABLE');
    if (!exact(lock,['schemaVersion','repositoryId','ledgerId','pid','processSession','authorityEpoch',
        'authorityProcessSession','initialGeneration','initialLedgerHash','createdAt',...(lock?.executionEraId!==undefined?['executionEraId','retirementHash']:[])]) || lock.schemaVersion !== 2 ||
        (lock.executionEraId!==undefined&&(!uuid(lock.executionEraId)||!sha(lock.retirementHash))) ||
        lock.repositoryId !== repositoryIdentity(path) || !uuid(lock.ledgerId) || !positive(lock.pid) ||
        !uuid(lock.processSession) || !positive(lock.authorityEpoch) || !id(lock.authorityProcessSession) ||
        !Number.isSafeInteger(lock.initialGeneration) || lock.initialGeneration < 0 || !sha(lock.initialLedgerHash) ||
        typeof lock.createdAt !== 'string' || !Number.isFinite(Date.parse(lock.createdAt))) fail('LEDGER_V2_LOCK_INVALID');
    return lock;
}
export function makeLock(path,snapshot,authority) {
    return Object.freeze(validateV2Lock({schemaVersion:2, repositoryId:repositoryIdentity(path), ledgerId:snapshot.ledgerId,
        pid:process.pid, processSession:randomUUID(), authorityEpoch:authority.authorityEpoch,
        authorityProcessSession:authority.authorityProcessSession, initialGeneration:snapshot.generation,
        initialLedgerHash:hash(snapshot), createdAt:new Date().toISOString(),
        ...(snapshot.executionEraId?{executionEraId:snapshot.executionEraId,retirementHash:snapshot.retirementHash}:{})},path));
}
export function envelope(path,snapshot) {
    return seal({schemaVersion:2, repositoryId:repositoryIdentity(path), snapshot:validateLedgerSnapshot(snapshot)});
}
export function decodeEnvelope(path,value) {
    return validateEnvelope(value,repositoryIdentity(path));
}
export function validateEnvelope(value,expectedRepositoryId=value?.repositoryId) {
    const p=unseal(value);
    if (!exact(p,['schemaVersion','repositoryId','snapshot']) || p.schemaVersion !== 2 ||
        !sha(p.repositoryId) || p.repositoryId !== expectedRepositoryId)
        fail('LEDGER_V2_REPOSITORY_MISMATCH');
    return validateLedgerSnapshot(p.snapshot);
}
export async function ordinary(path,{optional=false,encoding='utf8'}={}) {
    if (encoding!==null && encoding!=='utf8') throw new TypeError('EVIDENCE_ENCODING_REQUIRED');
    const evidence=await readEvidence(path,{optional,text:encoding!==null,
        ordinaryError:'LEDGER_V2_ORDINARY_FILE_REQUIRED'});
    return evidence===null ? null : encoding===null ? evidence.bytes : evidence.text;
}
export function requireDirectory(path,syncDirectory) {
    if(syncDirectory(path)!=='DIRECTORY_SYNCED')fail('LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN');
}
export async function append(path,records,type,data,{hook=()=>{},fs={open},syncDirectory=directorySync}={}) {
    const record=seal({schemaVersion:2,type,previous:records.at(-1)?.checksum??null,data});
    const file=await fs.open(path+'.wal',records.length?'a':'wx',0o600);
    try {
        hook(type.toLowerCase()+'-opened');
        await file.writeFile(JSON.stringify(record)+'\n'); hook(type.toLowerCase()+'-written');
        await file.sync(); hook(type.toLowerCase()+'-flushed');
    } finally {await file.close();}
    requireDirectory(path,syncDirectory); records.push(record);
    return record;
}

// All records are retained. A damaged tail is NOT truncated or ignored.
export function parseWal(path,bytes) {
    if (!bytes || !bytes.endsWith('\n')) fail('LEDGER_V2_PARTIAL_WAL');
    const records=bytes.slice(0,-1).split('\n').map(line=>JSON.parse(line));
    let current=null,owner=null,pending=null,base=null;
    const sessions=new Set(),transactions=new Set();
    for (let i=0;i<records.length;i++) {
        const r=records[i],p=unseal(r),d=p.data;
        if (!exact(p,['schemaVersion','type','previous','data']) || p.schemaVersion!==2 || p.previous!==(records[i-1]?.checksum??null))
            fail('LEDGER_V2_WAL_CHAIN');
        if(i===0) {
            if(p.type!=='BASE' || !exact(d,['repositoryId','snapshot','namespaceDurability']) ||
                !['DIRECTORY_SYNCED','FILE_SYNC_ONLY'].includes(d.namespaceDurability) || d.repositoryId!==repositoryIdentity(path)) fail('LEDGER_V2_BASE_INVALID');
            current=validateLedgerSnapshot(d.snapshot);base=current;continue;
        }
        if(p.type==='BEGIN') {
            validateV2Lock(d,path);
            if(owner || pending || sessions.has(d.processSession) || d.ledgerId!==current.ledgerId ||
                d.initialGeneration!==current.generation || d.initialLedgerHash!==hash(current)||d.executionEraId!==current.executionEraId||d.retirementHash!==current.retirementHash) fail('LEDGER_V2_BEGIN_MISMATCH');
            sessions.add(d.processSession);owner=d;
        } else if(p.type==='INTENT') {
            if(!exact(d,['transactionId','entryKey','owner','previousGeneration','previousHash','nextGeneration','nextHash','next','createdAt']) ||
                !owner || pending || !equal(d.owner,owner) || !uuid(d.transactionId) || transactions.has(d.transactionId) || !sha(d.entryKey) ||
                d.previousGeneration!==current.generation || d.previousHash!==hash(current) ||
                d.nextGeneration!==current.generation+1 || typeof d.createdAt!=='string' || !Number.isFinite(Date.parse(d.createdAt))) fail('LEDGER_V2_INTENT_LINKAGE');
            const next=validateLedgerSnapshot(d.next),added=next.entries.filter(e=>!current.entries.some(old=>old.identity.entryKey===e.identity.entryKey));
            if(next.ledgerId!==current.ledgerId || next.generation!==d.nextGeneration || hash(next)!==d.nextHash || added.length!==1 ||
                added[0].identity.entryKey!==d.entryKey || added[0].authorityEpoch!==owner.authorityEpoch ||
                added[0].authorityProcessSession!==owner.authorityProcessSession ||
                !equal(next,ledgerSnapshot({...current,ledgerId:current.ledgerId,generation:next.generation,entries:[...current.entries,added[0]]})))
                fail('LEDGER_V2_INTENT_CONTENT');
            transactions.add(d.transactionId);pending={...d,next};
        } else if(p.type==='COMMIT') {
            if(!pending || !exact(d,['transactionId','nextHash']) || d.transactionId!==pending.transactionId || d.nextHash!==pending.nextHash)
                fail('LEDGER_V2_COMMIT_MISMATCH');
            current=pending.next;pending=null;
        } else if(p.type==='END') {
            if(!owner || pending || !exact(d,['processSession','snapshotHash','recovered']) || typeof d.recovered!=='boolean' ||
                d.processSession!==owner.processSession || d.snapshotHash!==hash(current)) fail('LEDGER_V2_END_MISMATCH');
            owner=null;
        } else fail('LEDGER_V2_RECORD_UNSUPPORTED');
    }
    return {records,current,owner,pending,base};
}

function* inspectV2Evidence(path,names) {
    assertCanonicalNames(names,[basename(path),basename(path)+'.wal'],{code:'LEDGER_V2_STAGING_AMBIGUOUS'});
    const walBytes=yield path+'.wal';
    const state=parseWal(path,walBytes);
    const canonicalBytes=yield path;
    const snapshot=decodeEnvelope(path,JSON.parse(canonicalBytes));
    if(!equal(snapshot,state.current) && !(state.pending && equal(snapshot,state.pending.next))) fail('LEDGER_V2_CANONICAL_MISMATCH');
    const prefix=basename(path)+'.';
    const stages=names.filter(n=>namespaceStarts(n,prefix) && ['.tmp','.stage'].some(s=>namespaceEnds(n,s)));
    const expected=state.pending ? basename(path)+'.'+state.pending.transactionId+'.stage' : null;
    if(stages.length>1||stages.some(name=>name!==expected))fail('LEDGER_V2_STAGING_AMBIGUOUS');
    for(const name of stages) {
        const bytes=yield join(dirname(path),name);
        // The name is already bound to the sole validated WAL INTENT. Empty is
        // the pre-write install checkpoint, not a source of snapshot evidence.
        if(bytes==='')continue;
        const staged=decodeEnvelope(path,JSON.parse(bytes));
        if(!equal(staged,state.pending.next)) fail('LEDGER_V2_STAGING_MISMATCH');
    }
    return {...state,snapshot,canonicalBytes,walBytes,stages};
}

// Both readers drive one inspection contract; synchronous grant/consume fences
// cannot await without changing the existing authorization predicate contract.
export async function inspectV2(path) {
    const inspection=inspectV2Evidence(path,await readdir(dirname(path)));
    let step=inspection.next();
    while(!step.done)step=inspection.next(await ordinary(step.value));
    return step.value;
}
export function inspectV2Sync(path) {
    const inspection=inspectV2Evidence(path,readdirSync(dirname(path)));
    let step=inspection.next();
    while(!step.done)step=inspection.next(readEvidenceSync(step.value,{
        ordinaryError:'LEDGER_V2_ORDINARY_FILE_REQUIRED'}).text);
    return step.value;
}

// END is linked to its BEGIN, which contains the complete original writer
// lock. Only the last, resolved writer END qualifies; recovered END is not a
// runtime shutdown proof. Durability must still be established by the caller.
export function terminalShutdown(state,lock) {
    const end=state.records.at(-1),owner=state.records.filter(r=>r.type==='BEGIN').at(-1)?.data;
    return !state.owner&&!state.pending&&end?.type==='END'&&end.data.recovered===false&&
        state.records[0].data.namespaceDurability==='DIRECTORY_SYNCED'&&equal(owner,lock)&&
        state.current.ledgerId===lock.ledgerId&&equal(state.snapshot,state.current)&&
        end.data.processSession===lock.processSession&&end.data.snapshotHash===hash(state.current);
}

export async function install(path,next,transactionId,{hook=()=>{},fs={open,renameSync,openSync,fsyncSync,closeSync,unlink},syncDirectory=directorySync,durability=createLedgerV2Durability({syncDirectory,fs}),[emptyStageRecovery]:reviewedPending}={}) {
    const stage=path+'.'+transactionId+'.stage',bytes=JSON.stringify(envelope(path,next))+'\n';
    const existing=await ordinary(stage,{optional:true});
    const resumeEmpty=existing===''&&reviewedPending!==undefined;
    if(existing!==null && existing!==bytes && !resumeEmpty) fail('LEDGER_V2_STAGING_MISMATCH');
    if(resumeEmpty){
        const verified=await inspectV2(path);
        if(!equal(verified.pending,reviewedPending)||verified.pending?.transactionId!==transactionId||
            !equal(verified.pending.next,next))fail('LEDGER_V2_STAGING_MISMATCH');
    }
    if(existing===null || resumeEmpty) {
        // r+ preserves the existing empty file; never truncate or unlink stage
        // evidence. All writes retain the original install durability barriers.
        const file=await fs.open(stage,resumeEmpty?'r+':'wx',0o600);
        try {
            if(resumeEmpty){const stat=await file.stat();if(!stat.isFile()||stat.size!==0||stat.nlink!==1)fail('LEDGER_V2_STAGING_MISMATCH');}
            hook('opened');await file.writeFile(bytes);hook('written');await file.sync();hook('flushed');
        }
        finally {await file.close();}
    }
    requireDirectory(path,syncDirectory);hook('staged');hook('before-replace');
    durability.replace(stage,path);hook('replaced');
    const fd=fs.openSync(path,'r+');
    try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    requireDirectory(path,syncDirectory);hook('durable');
}

// Caller must hold the writer lock or audited offline exclusivity. Never capture.
export async function recoverV2(path,options={}) {
    const state=await inspectV2(path);
    if(state.pending) {
        await install(path,state.pending.next,state.pending.transactionId,{...options,[emptyStageRecovery]:state.pending});
        await append(path,state.records,'COMMIT',{transactionId:state.pending.transactionId,nextHash:state.pending.nextHash},options);
    }
    return inspectV2(path);
}
