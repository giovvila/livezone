import {readFileSync,lstatSync,readdirSync,realpathSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {capturedEvidence,readEvidence,readEvidenceSync} from './PersistentEvidence.js';
import {hash,seal,equal,fail,inspectV2,inspectV2Sync,parseWal,validateV2Lock} from '../scheduler/ScheduledEntryLedgerV2Protocol.js';
import {createLedgerV2Durability} from '../scheduler/LedgerV2Durability.js';
import {phaseRecord} from './RecoveryLineage.js';
import {normalizeSchedule} from '../scheduler/ScheduleContract.js';
import {identityForScheduledEvent} from '../scheduler/ScheduledEventIdentity.js';
import {scheduledEntryIdentity} from '../scheduler/ScheduledEntryIdentity.js';

export const ERA_PHASES=Object.freeze(['authorized','forensic','retired','intent','archived','ledger','schedule','activated']);
// Bound once by the successfully initialized writer, never by disk inspection.
// Recovery readers deliberately do not acquire this operational capability.
const runtimeLedgers=new WeakMap();
export function bindEraLedgerRuntime(authority,repository){
    const previous=runtimeLedgers.get(authority);
    if(previous&&previous!==repository)fail('EXECUTION_ERA_LEDGER_RUNTIME_ALREADY_BOUND');
    runtimeLedgers.set(authority,repository);
}
export const eraDirectory=ledger=>join(dirname(resolve(ledger)),'execution-era');
export const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const eraRecordBytes=value=>Buffer.from(JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)+'\n');
export function unsealEra(record){
    const {checksum,...body}=record??{};
    if(checksum!==hash(body))fail('EXECUTION_ERA_CHECKSUM');
    return body;
}
function ordinarySync(path,{capture=false}={}){
    const s=lstatSync(path);
    if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>64*1024*1024)fail('EXECUTION_ERA_ORDINARY_FILE_REQUIRED');
    const evidence=capturedEvidence(readFileSync(path),{json:true});return capture?evidence:evidence.value;
}
// Synchronous pre-construction fence: no authority, Schedule or AutoLive writer
// may start while the maintenance transaction is partial or its evidence is lost.
export function executionEraStartup(ledger,{schedulePath}={}){
    const directory=eraDirectory(ledger);let names;
    try{const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||resolve(realpathSync(directory)).toLowerCase()!==resolve(directory).toLowerCase())fail('EXECUTION_ERA_ALIASED_PATH');names=readdirSync(directory);}
    catch(e){if(e.code!=='ENOENT')throw e;
        try{lstatSync(directory+'-forensic');fail('EXECUTION_ERA_EVIDENCE_MISSING');}catch(error){if(error.code!=='ENOENT')throw error;}
        for(const path of [ledger+'.bootstrap',schedulePath].filter(Boolean)){
            try{const value=ordinarySync(path);if(value.executionEraId||value.executionEra)fail('EXECUTION_ERA_EVIDENCE_MISSING');}
            catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
        }
        try{if(ordinarySync(ledger)?.snapshot?.executionEraId)fail('EXECUTION_ERA_EVIDENCE_MISSING');}
        catch(error){
            // Legacy corrupt ledgers remain a Scheduled-only failure under the
            // existing contract. Detect surviving era binding without accepting
            // corrupt JSON as authority; canonical era Schedule is fenced too.
            if(error instanceof SyntaxError){if(readFileSync(ledger).includes(Buffer.from('executionEraId')))fail('EXECUTION_ERA_EVIDENCE_MISSING');}
            else if(error.code!=='ENOENT')throw error;
        }
        return null;
    }
    if(names.length===0)fail('EXECUTION_ERA_RESUME_REQUIRED');
    let previous=null,authorization;
    for(const phase of ERA_PHASES){
        if(!names.includes(phase+'.json')||names.includes(phase+'.json.stage'))fail('EXECUTION_ERA_RESUME_REQUIRED');
        const record=ordinarySync(join(directory,phase+'.json')),body=unsealEra(record);
        if(phase==='authorized')authorization=body.authorization;
        if(body.version!==1||body.phase!==phase||body.previous!==previous||!equal(body.authorization,authorization))fail('EXECUTION_ERA_LINEAGE');
        if(!readFileSync(join(directory,phase+'.json')).equals(eraRecordBytes(seal({version:1,phase,previous,authorization}))))fail('EXECUTION_ERA_PHASE_BYTES_CHANGED');
        previous=record.checksum;
    }
    const allowed=new Set(ERA_PHASES.map(p=>p+'.json'));
    const startName=/^start-[a-f0-9-]{36}\.json(?:\.ready)?$/;
    const startStage=/^start-[a-f0-9-]{36}\.json(?:\.ready)?\.stage$/;
    const startArchive=/^start-[a-f0-9-]{36}\.json(?:\.ready)?(?:\.stage)?\.reconciled-[a-f0-9-]{36}-(?:owner-anchor|owner-stage|ready-anchor|ready-stage)$/;
    for(const name of names)if(!allowed.has(name)&&!/^grant-[a-f0-9-]{36}\.json(?:\.stage)?$/.test(name)&&!startName.test(name)&&!startStage.test(name)&&!startArchive.test(name))fail('EXECUTION_ERA_UNKNOWN_ARTIFACT');
    const a=authorization;
    if(!uuid(a?.executionEraId)||!uuid(a.ledgerId)||!uuid(a.transitionId)||a.ledgerPath!==resolve(ledger)||a.reason!=='LEGACY_LEDGER_LOCK_UNVERIFIABLE')fail('EXECUTION_ERA_CONTEXT');
    const snapshot=ordinarySync(ledger)?.snapshot;
    const schedule=ordinarySync(a.schedulePath),marker=ordinarySync(ledger+'.bootstrap');
    if(snapshot?.ledgerId!==a.ledgerId||snapshot.executionEraId!==a.executionEraId||snapshot.retirementHash!==a.retirementHash||
        !equal(schedule.executionEra,a.scheduleEra)||!equal(marker,a.marker))fail('EXECUTION_ERA_BINDING');
    const forensic=directory+'-forensic';
    const manifestEvidence=ordinarySync(join(forensic,'manifest.json'),{capture:true}),manifest=unsealEra(manifestEvidence.value);
    const expectedManifest=seal({version:1,reason:a.reason,repository:a.repository,approvedHead:a.approvedHead,
        authorizationHash:hash(a),principal:a.principal,transitionId:a.transitionId,executionEraId:a.executionEraId,oldEraId:a.oldEraId,
        historyAvailability:'UNAVAILABLE_HISTORY_NOT_RECONSTRUCTED',inventory:a.inventory.map(({bytes,...item})=>({...item,blob:item.present?'blob-'+item.sha256:null}))});
    if(!manifestEvidence.bytes.equals(eraRecordBytes(expectedManifest)))fail('EXECUTION_ERA_MANIFEST_BYTES_CHANGED');
    if(manifest.authorizationHash!==hash(a)||manifest.transitionId!==a.transitionId||manifest.reason!==a.reason)fail('EXECUTION_ERA_FORENSIC_BINDING');
    for(const item of a.inventory.filter(i=>i.present)){
        const path=join(forensic,'blob-'+item.sha256),stat=lstatSync(path);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||hash(readFileSync(path))!==item.sha256)fail('EXECUTION_ERA_FORENSIC_CHANGED');
        if(['ledger','ledgerLock','bootstrap','authorityLock','scheduledLock','scheduledJournal'].includes(item.key)){
            const retired=join(a.repository,item.name)+'.retired-era-'+a.transitionId,rs=lstatSync(retired);
            if(!rs.isFile()||rs.isSymbolicLink()||rs.nlink!==1||hash(readFileSync(retired))!==item.sha256)fail('EXECUTION_ERA_ARCHIVE_CHANGED');
        }
    }
    const forensicNames=new Set(['manifest.json',...a.inventory.filter(i=>i.present).map(i=>'blob-'+i.sha256)]);
    if(readdirSync(forensic).some(name=>!forensicNames.has(name)))fail('EXECUTION_ERA_FORENSIC_UNKNOWN_ARTIFACT');
    for(const name of names.filter(n=>startName.test(n))){
        const anchor=unsealEra(ordinarySync(join(directory,name)));
        if(!readFileSync(join(directory,name)).equals(eraRecordBytes(seal(anchor))))fail('EXECUTION_ERA_START_BYTES_CHANGED');
        if(anchor.executionEraId!==a.executionEraId||anchor.transitionId!==a.transitionId||anchor.activationHash!==previous||
            !['NEW_AUTHORITY_READY','READY'].includes(anchor.phase))fail('EXECUTION_ERA_START_CHAIN');
    }
    return Object.freeze({...a,directory,activationHash:previous,pendingStartStages:names.filter(n=>startStage.test(n))});
}
function validatedGrant(era,captured,incarnationId){
    const record=captured.value??JSON.parse(captured.bytes),grant=unsealEra(record);
    if(!captured.bytes.equals(eraRecordBytes(record))||grant.executionEraId!==era.executionEraId||
        grant.transitionId!==era.transitionId||grant.incarnationId!==incarnationId||era.oldEventIds.includes(grant.eventId))fail('EXECUTION_ERA_GRANT_CHANGED');
    if(grant.version===1)return grant;
    const before=Buffer.from(grant.scheduleBeforeBytes??'','base64'),predecessor=normalizeSchedule(JSON.parse(before));
    const key=hash({activationHash:grant.activationHash,eventId:grant.eventId,requestHash:grant.requestHash,scheduleBeforeHash:grant.scheduleBeforeHash});
    const expectedId=`${key.slice(0,8)}-${key.slice(8,12)}-${key.slice(12,16)}-${key.slice(16,20)}-${key.slice(20,32)}`;
    if(grant.version!==2||grant.activationHash!==era.activationHash||grant.retirementHash!==era.retirementHash||
        grant.repository!==era.repository||grant.approvedHead!==era.approvedHead||grant.operationId!==incarnationId||incarnationId!==expectedId||
        hash(before)!==grant.scheduleBeforeHash||predecessor.revision!==grant.scheduleRevision||!equal(predecessor.executionEra,era.scheduleEra)||
        !/^[a-f0-9]{64}$/.test(grant.requestHash)||!/^[a-f0-9]{64}$/.test(grant.scheduleBeforeHash))fail('EXECUTION_ERA_GRANT_CHANGED');
    return grant;
}
const targetPredecessor=(schedule,eventId)=>{
    const event=schedule.events.find(e=>e.id===eventId);
    if(!event)return null;
    const {name,createdAt,updatedAt,...target}=event;return target;
};
const publishedGrants=schedule=>new Set([...(schedule.publishedEraGrants??[]),...schedule.events.filter(e=>e.executionEraId).map(e=>e.incarnationId)]);
function pendingGrants(era,schedule){
    const published=publishedGrants(schedule),pending=[];
    for(const name of readdirSync(era.directory).filter(n=>/^grant-.*\.json$/.test(n))){
        const id=name.slice(6,-5),captured=ordinarySync(join(era.directory,name),{capture:true});
        const grant=validatedGrant(era,captured,id);
        if(!published.has(id))pending.push({grant,captured});
    }
    return pending;
}
export function eraAdmits(era,identity,{requirePublished=true}={}){
    if(!era)return identity.identitySchema===1;
    if(identity.identitySchema!==2||identity.executionEraId!==era.executionEraId||!uuid(identity.incarnationId))return false;
    try{
        try{lstatSync(join(era.directory,'grant-'+identity.incarnationId+'.json.stage'));return false;}
        catch(error){if(error.code!=='ENOENT')return false;}
        const captured=ordinarySync(join(era.directory,'grant-'+identity.incarnationId+'.json'),{capture:true});
        const grant=validatedGrant(era,captured,identity.incarnationId);
        const schedule=normalizeSchedule(ordinarySync(era.schedulePath));
        if(!equal(schedule.executionEra,era.scheduleEra))return false;
        const pending=pendingGrants(era,schedule).filter(p=>p.grant.eventId===grant.eventId);
        if(pending.length>1)return false;
        const target=schedule.events.find(e=>e.id===grant.eventId&&e.executionEraId);
        if(requirePublished&&(target?.incarnationId!==grant.incarnationId||
            target.executionEraId!==era.executionEraId||target.entryGrantHash!==captured.sha256))return false;
        if(requirePublished&&scheduledEntryIdentity({...identity,sourceId:identity.sourceId??identity.payload?.sourceId}).entryKey!==
            identityForScheduledEvent(target).entryKey)return false;
        if(publishedGrants(schedule).has(grant.incarnationId)&&target?.incarnationId!==grant.incarnationId)return false;
        if(!publishedGrants(schedule).has(grant.incarnationId)){
            if(target)return false;
            if(grant.version===2&&!equal(targetPredecessor(normalizeSchedule(JSON.parse(Buffer.from(grant.scheduleBeforeBytes,'base64'))),grant.eventId),targetPredecessor(schedule,grant.eventId)))return false;
        }
        return captured.sha256===identity.entryGrantHash&&grant.eventId===identity.eventId;
    }catch{return false;}
}
// READY describes an immutable Ledger prefix, not today's mutable generation.
// Both live authorization and completed Start use the same canonical binding.
export function validateEraReadyLedger(era,anchor,{snapshot,walBytes,code='EXECUTION_ERA_READY_LEDGER_CHANGED'}){
    if(anchor.version!==1||anchor.phase!=='READY'||anchor.ledgerId!==era.ledgerId||
        anchor.executionEraId!==era.executionEraId||anchor.transitionId!==era.transitionId||anchor.activationHash!==era.activationHash||
        snapshot.ledgerId!==era.ledgerId||snapshot.executionEraId!==era.executionEraId||snapshot.retirementHash!==era.retirementHash)fail(code);
    const prefix=Buffer.from(anchor.walBytes,'base64'),wal=Buffer.from(walBytes);
    const state=parseWal(era.ledgerPath,prefix.toString('utf8'));
    if(hash(prefix)!==anchor.walHash||!wal.subarray(0,prefix.length).equals(prefix)||state.pending||
        state.current.ledgerId!==era.ledgerId||state.current.executionEraId!==era.executionEraId||
        state.current.retirementHash!==era.retirementHash||hash(state.current)!==anchor.snapshotHash||
        state.owner?.authorityEpoch!==anchor.authorityEpoch||state.owner?.authorityProcessSession!==anchor.authorityProcessSession)fail(code);
    return state;
}
export function assertEraAuthority(era,authority,{ready=false,operational=false}={}){
    if(!authority?.available||authority.closed||authority.executionEraId!==era.executionEraId||
        executionEraStartup(era.ledgerPath)?.activationHash!==era.activationHash)fail('EXECUTION_ERA_AUTHORITY_REQUIRED');
    const lock=ordinarySync(era.paths.authorityLock),epoch=ordinarySync(era.paths.authority);
    const start=unsealEra(ordinarySync(join(era.directory,'start-'+authority.authorityProcessSession+'.json')));
    const controlled=authority.controlledStartBinding;
    if(controlled&&(hash(readFileSync(controlled.reservationPath))!==controlled.reservationHash||
        hash(readFileSync(controlled.claimPath))!==controlled.claimHash||start.startReservationHash!==controlled.reservationHash||
        start.recoveryClaimHash!==controlled.claimHash||start.successorId!==controlled.successorId))fail('EXECUTION_ERA_CONTROLLED_START_CHANGED');
    if(lock.executionEraId!==era.executionEraId||lock.activationHash!==era.activationHash||
        lock.authorityProcessSession!==authority.authorityProcessSession||epoch.epoch!==authority.authorityEpoch||
        start.activationHash!==era.activationHash||start.authorityEpoch!==authority.authorityEpoch||
        start.authorityProcessSession!==authority.authorityProcessSession||start.previousEpoch+1!==start.authorityEpoch||
        start.lockBytesHash!==hash(readFileSync(era.paths.authorityLock))||start.authorityBytesHash!==hash(readFileSync(era.paths.authority)))fail('EXECUTION_ERA_OWNER_CHANGED');
    if(ready){
        const anchor=unsealEra(ordinarySync(join(era.directory,'start-'+authority.authorityProcessSession+'.json.ready')));
        if(controlled&&(hash(readFileSync(controlled.runtimeOwnedPath))!==controlled.runtimeOwnedHash||
            anchor.startReservationHash!==controlled.reservationHash||anchor.recoveryClaimHash!==controlled.claimHash||
            anchor.successorId!==controlled.successorId||anchor.runtimeOwnedHash!==controlled.runtimeOwnedHash||
            !equal(anchor.recoveryLineage,phaseRecord(controlled.context,'READY',{hash:controlled.runtimeOwnedHash},{}).lineage)))fail('EXECUTION_ERA_READY_LINEAGE_CHANGED');
        if(authority.eraReady!==true||anchor.activationHash!==era.activationHash||anchor.ownerHash!==hash(start)||
            anchor.authorityEpoch!==authority.authorityEpoch||anchor.authorityProcessSession!==authority.authorityProcessSession)fail('EXECUTION_ERA_READY_REQUIRED');
        const ledger=inspectV2Sync(era.ledgerPath);
        const anchored=validateEraReadyLedger(era,anchor,ledger);
        // Recovery can inspect pending transactions and END, but new execution
        // requires a resolved current writer belonging to this live authority.
        if(operational){
            const ledgerLock=validateV2Lock(ordinarySync(era.paths.ledgerLock),era.ledgerPath);
            if(ledger.pending||!ledger.owner||!equal(ledger.snapshot,ledger.current)||
                !equal(ledger.owner,ledgerLock)||!equal(ledger.owner,anchored.owner)||
                ledger.owner.authorityEpoch!==authority.authorityEpoch||
                ledger.owner.authorityProcessSession!==authority.authorityProcessSession)
                fail('EXECUTION_ERA_CURRENT_LEDGER_NOT_OPERATIONAL');
            const repository=runtimeLedgers.get(authority);
            if(!repository)fail('EXECUTION_ERA_LEDGER_RUNTIME_REQUIRED');
            repository.assertOperationalAuthority(era,authority,ledger,ledgerLock);
        }
    }
    return start;
}
// A historical grant remains evidence; publishing it needs today's writer.
export function assertEraPublication(era,authority,event){
    assertEraAuthority(era,authority,{ready:true,operational:true});
    const identity={identitySchema:2,eventId:event.id,...event};
    if(!eraAdmits(era,identity,{requirePublished:false}))fail('EXECUTION_ERA_GRANT_CHANGED');
    const captured=ordinarySync(join(era.directory,'grant-'+event.incarnationId+'.json'),{capture:true});
    const grant=validatedGrant(era,captured,event.incarnationId);
    if(grant.requestHash!==hash({type:event.type,sourceId:event.payload?.sourceId,startAt:event.startAt,endAt:event.endAt}))
        fail('EXECUTION_ERA_GRANT_REQUEST_CONFLICT');
}
// A published grant authorizes server-derived revisions of its incarnation,
// not a foreign incarnation or caller-supplied identity. Revisions need today's
// operational writer, while the original issuance request remains immutable.
export function assertEraIdentityMutation(era,authority,previous,next){
    if(previous?.type!=='source.live'||previous.incarnationId!==next.incarnationId){
        assertEraPublication(era,authority,next);return;
    }
    assertEraAuthority(era,authority,{ready:true,operational:true});
    if(!eraAdmits(era,identityForScheduledEvent(previous))||
        next.executionEraId!==previous.executionEraId||next.entryGrantHash!==previous.entryGrantHash||
        next.id!==previous.id)fail('EXECUTION_ERA_GRANT_CHANGED');
    const requestChanged=hash({type:previous.type,sourceId:previous.payload.sourceId,startAt:previous.startAt,endAt:previous.endAt})!==
        hash({type:next.type,sourceId:next.payload.sourceId,startAt:next.startAt,endAt:next.endAt});
    if(next.entryRevision!==previous.entryRevision+(requestChanged?1:0))fail('EXECUTION_ERA_ENTRY_REVISION_CHANGED');
}
export async function publishEraReady({era,authority,program,autoLive,validateProgram,durability=createLedgerV2Durability(),hook=()=>{}}){
    if(!era)return null;
    const owner=assertEraAuthority(era,authority);
    if(authority.restartBlocked||!program?.record||program.status!=='PRESENT'||!await validateProgram())fail('EXECUTION_ERA_PROGRAM_NOT_READY');
    const config=autoLive.store.getSnapshot(),old=JSON.parse(Buffer.from(era.inventory.find(i=>i.key==='autoLive').bytes,'base64'));
    if(!autoLive.available()||config.enabled!==true||config.armed!==false||config.sourceId!==old.sourceId)fail('EXECUTION_ERA_AUTOLIVE_CHANGED');
    const programEvidence=await readEvidence(era.paths.program),autoEvidence=await readEvidence(era.paths.autoLive);
    const ledger=await inspectV2(era.ledgerPath),schedule=await readEvidence(era.paths.schedule,{json:true});
    if(ledger.pending||ledger.owner?.authorityEpoch!==authority.authorityEpoch||ledger.owner?.authorityProcessSession!==authority.authorityProcessSession||
        ledger.current.executionEraId!==era.executionEraId||!equal(schedule.value.executionEra,era.scheduleEra))fail('EXECUTION_ERA_READY_LEDGER_REQUIRED');
    const record=seal({version:1,phase:'READY',executionEraId:era.executionEraId,transitionId:era.transitionId,
        activationHash:era.activationHash,ownerHash:hash(owner),authorityEpoch:authority.authorityEpoch,
        authorityProcessSession:authority.authorityProcessSession,programHash:programEvidence.sha256,
        ...(authority.controlledStartBinding?{startReservationHash:authority.controlledStartBinding.reservationHash,
            recoveryClaimHash:authority.controlledStartBinding.claimHash,successorId:authority.controlledStartBinding.successorId,
            runtimeOwnedHash:authority.controlledStartBinding.runtimeOwnedHash,
            recoveryLineage:phaseRecord(authority.controlledStartBinding.context,'READY',{hash:authority.controlledStartBinding.runtimeOwnedHash},{}).lineage}:{}),
        programGeneration:program.record.generation,acceptedAuthorityEpoch:program.record.acceptedAuthorityEpoch,autoLiveHash:autoEvidence.sha256,
        ledgerId:era.ledgerId,snapshotHash:hash(ledger.current),walHash:hash(Buffer.from(ledger.walBytes)),walBytes:Buffer.from(ledger.walBytes).toString('base64'),
        scheduleHash:schedule.sha256,scheduleRevision:schedule.value.revision});
    const path=join(era.directory,'start-'+authority.authorityProcessSession+'.json.ready');
    assertEraAuthority(era,authority);await hook('before-ready-install');
    if((await readEvidence(era.paths.program)).sha256!==programEvidence.sha256||(await readEvidence(era.paths.autoLive)).sha256!==autoEvidence.sha256)fail('EXECUTION_ERA_READY_EVIDENCE_CHANGED');
    if((await readEvidence(era.paths.schedule)).sha256!==schedule.sha256||(await readEvidence(era.ledgerPath+'.wal')).sha256!==record.walHash)fail('EXECUTION_ERA_READY_EVIDENCE_CHANGED');
    const existing=await readEvidence(path,{optional:true,json:true});
    if(existing&&!equal(existing.value,record))fail('EXECUTION_ERA_READY_CONFLICT');
    if(!existing){
        if(authority.eraRecovery)await authority.eraRecovery.publish(path,record);
        else{const file=await open(path,'wx',0o600);try{await file.writeFile(eraRecordBytes(record));await file.sync();}finally{await file.close();}}
    }
    await durability.syncFile(path);await hook('ready-durable');assertEraAuthority(era,authority);authority.eraReady=true;return record;
}
async function issueEraEntryOwned(era,eventId,{durability=createLedgerV2Durability(),authority,requestHash=hash({eventId}),hook=()=>{}}={}){
    if(executionEraStartup(era.ledgerPath)?.activationHash!==era.activationHash)fail('EXECUTION_ERA_CHANGED');
    if(era.oldEventIds.includes(eventId))fail('OLD_EXECUTION_DOMAIN_RETIRED');
    assertEraAuthority(era,authority,{ready:true,operational:true});
    if(typeof eventId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(eventId)||!/^[a-f0-9]{64}$/.test(requestHash))fail('EXECUTION_ERA_GRANT_REQUEST');
    const schedule=await readEvidence(era.schedulePath,{json:true});
    if(!equal(schedule.value.executionEra,era.scheduleEra))fail('EXECUTION_ERA_GRANT_SCHEDULE');
    const current=normalizeSchedule(schedule.value);
    const pending=pendingGrants(era,current).filter(p=>p.grant.eventId===eventId);
    if(pending.length>1)fail('EXECUTION_ERA_GRANT_AMBIGUOUS');
    let anchor=pending[0];
    const published=current.events.find(e=>e.id===eventId&&e.executionEraId);
    if(published){
        const captured=ordinarySync(join(era.directory,'grant-'+published.incarnationId+'.json'),{capture:true});
        const grant=validatedGrant(era,captured,published.incarnationId);
        if(grant.requestHash!==requestHash||published.entryGrantHash!==captured.sha256||anchor)fail('EXECUTION_ERA_GRANT_REQUEST_CONFLICT');
        anchor={grant,captured};
    }
    if(anchor){
        const predecessor=normalizeSchedule(JSON.parse(Buffer.from(anchor.grant.scheduleBeforeBytes??'','base64')));
        if(anchor.grant.version!==2||anchor.grant.requestHash!==requestHash||current.revision<predecessor.revision||
            !published&&!equal(targetPredecessor(predecessor,eventId),targetPredecessor(current,eventId))||
            (predecessor.publishedEraGrants??[]).some(id=>!publishedGrants(current).has(id)))fail('EXECUTION_ERA_GRANT_REQUEST_CONFLICT');
    }
    const key=hash({activationHash:era.activationHash,eventId,requestHash,scheduleBeforeHash:schedule.sha256});
    const incarnationId=anchor?.grant.incarnationId??`${key.slice(0,8)}-${key.slice(8,12)}-${key.slice(12,16)}-${key.slice(16,20)}-${key.slice(20,32)}`;
    const record=anchor?JSON.parse(anchor.captured.bytes):seal({version:2,executionEraId:era.executionEraId,transitionId:era.transitionId,eventId,incarnationId,
        operationId:incarnationId,requestHash,scheduleBeforeHash:schedule.sha256,scheduleBeforeBytes:schedule.bytes.toString('base64'),scheduleRevision:schedule.value.revision,
        activationHash:era.activationHash,retirementHash:era.retirementHash,repository:era.repository,approvedHead:era.approvedHead});
    const path=join(era.directory,'grant-'+incarnationId+'.json');
    const stage=path+'.stage',wanted=eraRecordBytes(record),emit=point=>hook('grant/'+point,path);
    // A partial grant is recoverable only at its original deterministic path.
    // Unknown staging evidence cannot be bypassed by Schedule drift.
    if(readdirSync(era.directory).some(n=>/^grant-.*\.json\.stage$/.test(n)&&n!==('grant-'+incarnationId+'.json.stage')))fail('EXECUTION_ERA_GRANT_STAGING_CHANGED');
    // No await separates the final authority observation from invoking mutation.
    const fence=()=>{if(readEvidenceSync(era.schedulePath,{text:false}).sha256!==schedule.sha256)fail('EXECUTION_ERA_GRANT_SCHEDULE_CHANGED');assertEraAuthority(era,authority,{ready:true,operational:true});};
    await emit('authorized');fence();
    const installed=await readEvidence(path,{optional:true,text:false});
    if(installed&&!installed.bytes.equals(wanted))fail('EXECUTION_ERA_GRANT_CHANGED');
    const partial=await readEvidence(stage,{optional:true,text:false});
    if(partial&&!wanted.subarray(0,partial.byteLength).equals(partial.bytes))fail('EXECUTION_ERA_GRANT_STAGING_CHANGED');
    if(!installed){
        await emit('before-open');fence();const file=await open(stage,partial?'r+':'wx',0o600);
        try{
            await emit('opened');fence();const offset=partial?.byteLength??0,mid=offset+Math.floor((wanted.length-offset)/2);
            await file.write(wanted.subarray(offset,mid),0,mid-offset,offset);await emit('partial-written');fence();
            await file.write(wanted.subarray(mid),0,wanted.length-mid,mid);await emit('written');
            await file.sync();await emit('file-flushed');
        }finally{await file.close();}
        durability.sync(stage);await emit('namespace-flushed');fence();
        if(!(await readEvidence(stage,{text:false})).bytes.equals(wanted))fail('EXECUTION_ERA_GRANT_STAGING_CHANGED');
        await emit('before-install');fence();await durability.archive(stage,path);await emit('installed');
    }else if(partial){
        if(!partial.bytes.equals(wanted))fail('EXECUTION_ERA_GRANT_STAGING_CHANGED');
        await emit('before-stage-cleanup');fence();await durability.remove(stage);await emit('stage-cleaned');
    }
    await durability.syncFile(path);await emit('durable');
    if(!(await readEvidence(path,{text:false})).bytes.equals(wanted))fail('EXECUTION_ERA_GRANT_CHANGED');
    fence();await emit('verified');fence();await emit('before-return');fence();
    return {incarnationId,entryRevision:1,entryMigration:null,executionEraId:era.executionEraId,entryGrantHash:hash(eraRecordBytes(record))};
}

// ScheduleStore also serializes dependent publication. This queue covers direct
// duplicate issuance calls under the existing single runtime authority owner.
const issuanceQueues=new Map();
export function issueEraEntry(era,eventId,options={}){
    const key=era.ledgerPath,previous=issuanceQueues.get(key)??Promise.resolve();
    const result=previous.then(()=>issueEraEntryOwned(era,eventId,options));
    const settled=result.then(()=>{},()=>{});issuanceQueues.set(key,settled);
    void settled.then(()=>{if(issuanceQueues.get(key)===settled)issuanceQueues.delete(key);});
    return result;
}
