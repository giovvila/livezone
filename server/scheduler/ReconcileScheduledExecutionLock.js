// Module only: no CLI or real-runtime invocation. Proof injection is for fixtures.
import {readFile, lstat, realpath, open, rename} from 'node:fs/promises';
import {resolve, dirname, basename, join, isAbsolute} from 'node:path';
import {createServer} from 'node:net';
import {proveWindowsOffline} from '../autolive/ReconcileAuthorityLock.js';
import {acquireMaintenanceGate} from '../autolive/AuthorityMaintenanceGate.js';
import {digest, repositoryIdentity, validateLock, journalMatchesLock, refuse} from './ScheduledExecutionProvenance.js';

async function ordinary(path) {
    try {
        const stat=await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size>1024*1024) refuse('ORDINARY_EVIDENCE_REQUIRED');
        return await readFile(path,'utf8');
    } catch(error) { if(error.code==='ENOENT') return null; throw error; }
}
async function exclusive(path,value) {
    const file=await open(path,'wx',0o600);
    try {await file.writeFile(JSON.stringify(value)); await file.sync();} finally {await file.close();}
}
async function reservePort() {
    const socket=createServer();
    await new Promise((ok,no)=>{socket.once('error',no);socket.listen({host:'0.0.0.0',port:8080,exclusive:true},ok);});
    return ()=>new Promise(ok=>socket.close(ok));
}
const alive=pid=>{try {process.kill(pid,0);return true;} catch(error) {if(error.code==='ESRCH')return false;throw error;}};
const sha=bytes=>bytes===null ? null : digest(bytes);

export function classifyScheduledLock(lock,journalPresent,repositoryId) {
    const classification=validateLock(lock,repositoryId);
    return classification==='LEGACY_UNVERIFIABLE' && journalPresent
        ? 'LEGACY_JOURNAL_REVIEW_REQUIRED' : classification;
}

export async function reconcileScheduledExecutionLock({path,authorityPath,operationId,expected,
    authorizeLegacyQuarantine=false,proveOffline=proveWindowsOffline,reserve=reservePort,
    isAlive=alive,hook=()=>{}}) {
    if(!isAbsolute(path || '') || !isAbsolute(authorityPath || '') ||
        !authorityPath.endsWith('.execution') || !/^[a-zA-Z0-9_-]{1,80}$/.test(operationId || ''))
        refuse('EXPLICIT_RECOVERY_IDENTITY_REQUIRED');
    path=resolve(path); authorityPath=resolve(authorityPath);
    for(const file of [path,authorityPath]) {
        const canonical=join(await realpath(dirname(file)),basename(file));
        if(repositoryIdentity(canonical)!==repositoryIdentity(file)) refuse('ALIASED_RECOVERY_PATH');
    }
    if(path===authorityPath) refuse('DISTINCT_AUTHORITY_REQUIRED');
    const repositoryId=repositoryIdentity(path);
    const archive=path+'.lock.quarantine-'+operationId;
    const audit=path+'.reconciliation-'+operationId+'.json';
    const proof=async()=>{const p=await proveOffline();if(p.absent!==true)refuse('CANONICAL_OFFLINE_PROOF_REQUIRED');return p;};
    await proof();
    const releaseGate=await acquireMaintenanceGate(authorityPath);
    let releasePort;
    try {
        releasePort=await reserve();
        const lockBytes=await ordinary(path+'.lock');
        const archived=await ordinary(archive);
        if((lockBytes===null)===(archived===null)) refuse('LOCK_ARCHIVE_STATE_AMBIGUOUS');
        const bytes=lockBytes ?? archived;
        const lock=JSON.parse(bytes);
        const journal=await ordinary(path);
        const epochBytes=await ordinary(authorityPath);
        const authorityLockBytes=await ordinary(authorityPath+'.lock');
        const classification=classifyScheduledLock(lock,journal!==null,repositoryId);
        if(classification==='LEGACY_JOURNAL_REVIEW_REQUIRED') refuse(classification);
        const evidence={lockHash:digest(bytes),repositoryId,processSession:lock.processSession,
            journalHash:sha(journal),authorityHash:sha(epochBytes),authorityLockHash:sha(authorityLockBytes)};
        if(!expected || Object.keys(evidence).some(k=>expected[k]!==evidence[k])) refuse('EXPECTED_EVIDENCE_MISMATCH');
        if(epochBytes===null || !Number.isSafeInteger(JSON.parse(epochBytes).epoch) || JSON.parse(epochBytes).epoch<1)
            refuse('AUTHORITY_EVIDENCE_REQUIRED');
        if(classification==='LEGACY_UNVERIFIABLE') {
            if(authorizeLegacyQuarantine!==true) refuse('EXPLICIT_LEGACY_AUTHORIZATION_REQUIRED');
            if(authorityLockBytes!==null) refuse('HANDLE_AUTOLIVE_AUTHORITY_SEPARATELY');
        } else {
            const authorityLock=authorityLockBytes===null ? null : JSON.parse(authorityLockBytes);
            if(lock.authorityId!==repositoryIdentity(authorityPath) ||
                lock.authorityEpoch!==JSON.parse(epochBytes).epoch ||
                authorityLock?.pid!==lock.processId ||
                authorityLock?.authorityProcessSession!==lock.authorityProcessSession)
                refuse('AUTHORITY_PROVENANCE_MISMATCH');
            if(isAlive(lock.processId)) refuse('SCHEDULED_OWNER_ALIVE_OR_AMBIGUOUS');
            journalMatchesLock(journal,lock);
        }
        const prepared={schemaVersion:1,state:'PREPARED',operationId,path,authorityPath,archive,
            reason:classification,expected:evidence,originalLock:lock,
            operator:process.env.USERNAME || process.env.USER || 'unknown',
            explicitLegacyAuthorization:authorizeLegacyQuarantine===true};
        const prior=await ordinary(audit);
        if(prior===null) {
            if(archived!==null) refuse('ARCHIVE_WITHOUT_PREPARED_AUDIT');
        } else {
            const saved=JSON.parse(prior);
            if(JSON.stringify(saved.contract)!==JSON.stringify(prepared)) refuse('PREPARED_AUDIT_MISMATCH');
        }
        const recheck=async()=>{
            const census=await proof();
            if(classification==='VERIFIABLE' && isAlive(lock.processId)) refuse('SCHEDULED_OWNER_ALIVE_OR_AMBIGUOUS');
            if(await ordinary(path)!==journal || await ordinary(authorityPath)!==epochBytes ||
                await ordinary(authorityPath+'.lock')!==authorityLockBytes ||
                await ordinary(lockBytes===null ? archive : path+'.lock')!==bytes ||
                await ordinary(lockBytes===null ? path+'.lock' : archive)!==null)
                refuse('RECOVERY_EVIDENCE_CHANGED');
            return census;
        };
        const census=await recheck();
        if(prior===null) await exclusive(audit,{contract:prepared,at:new Date().toISOString(),proof:census});
        await hook('prepared');
        await recheck();
        if(lockBytes!==null) await rename(path+'.lock',archive);
        await hook('archived');
        if(await ordinary(archive)!==bytes || await ordinary(path+'.lock')!==null ||
            await ordinary(path)!==journal || await ordinary(authorityPath)!==epochBytes ||
            await ordinary(authorityPath+'.lock')!==authorityLockBytes) refuse('POST_ARCHIVE_EVIDENCE_CHANGED');
        const completion={state:'COMPLETED',operationId,archive,lockHash:evidence.lockHash,
            auditHash:digest(await ordinary(audit)),reason:classification};
        const completed=await ordinary(audit+'.completed');
        if(completed===null) await exclusive(audit+'.completed',completion);
        else if(JSON.stringify(JSON.parse(completed))!==JSON.stringify(completion)) refuse('COMPLETION_MISMATCH');
        return {archive,audit,completion: audit+'.completed',reason:classification};
    } finally {if(releasePort)await releasePort();await releaseGate();}
}
