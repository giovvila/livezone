import {open,lstat,readdir,realpath} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readEvidence} from './PersistentEvidence.js';
import {assertHost} from './WindowsRecoveryHost.js';
import {eraDirectory,ERA_PHASES,executionEraStartup,unsealEra,uuid,eraRecordBytes} from './ExecutionEraContract.js';
import {createLedgerV2Durability} from '../scheduler/LedgerV2Durability.js';
import {windowsLedgerDurability,helperSha256,gateSha256} from '../scheduler/WindowsLedgerDurability.js';
import {hash,seal,equal,envelope,fail} from '../scheduler/ScheduledEntryLedgerV2Protocol.js';
import {ledgerSnapshot,validateLedgerSnapshot} from '../scheduler/ScheduledEntryLedgerContract.js';
import {normalizeSchedule} from '../scheduler/ScheduleContract.js';
import {validateRecord} from '../program-output/DurableProgramContract.js';
import {repositoryIdentity} from '../scheduler/ScheduledExecutionProvenance.js';
import {validateNewEraProgram} from './NewEraProgramValidation.js';
import {verifyLocalSystemCapabilityProof} from './LocalSystemCapabilityProof.js';
import {inspectNewEraRecovery} from './NewEraRecoveryInspection.js';

export const NEW_ERA_REASON='LEGACY_LEDGER_LOCK_UNVERIFIABLE';
const encode=eraRecordBytes;
const evidence=path=>readEvidence(path,{optional:true,text:false});
const absent=async path=>(await evidence(path))===null;
const parse=item=>JSON.parse(Buffer.from(item.bytes,'base64'));
const mandatory=['ledger','ledgerLock','bootstrap','authority','authorityLock','scheduledLock','schedule','program','autoLive'];

// Explicit maintenance only. No constructor, DryRun or normal startup writes.
export class NewExecutionEra {
    constructor({root,paths,host,expected,native=windowsLedgerDurability,durability=createLedgerV2Durability(),hook=()=>{},runtimeCapabilityProof,verifyRuntimeCapability=verifyLocalSystemCapabilityProof}){
        this.root=resolve(root);this.paths=Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,resolve(p)]));
        this.paths.authorityGate??=this.paths.authority+'.maintenance';
        Object.assign(this,{host,expected,native,durability,hook,runtimeCapabilityProof,verifyRuntimeCapability});
        for(const key of mandatory)if(!this.paths[key])fail('NEW_ERA_PATH_REQUIRED');
        if(new Set(Object.values(this.paths).map(p=>p.toLowerCase())).size!==Object.values(this.paths).length)fail('NEW_ERA_PATH_COLLISION');
        for(const path of Object.values(this.paths)){
            const r=relative(this.root,path);if(!r||r.startsWith('..')||isAbsolute(r))fail('NEW_ERA_REPOSITORY_MISMATCH');
        }
        this.directory=eraDirectory(this.paths.ledger);
        this.forensic=this.directory+'-forensic';
    }
    async inventory(authorization=null){
        const paths=new Map(Object.entries(this.paths).map(([key,path])=>[relative(this.root,path),{key,path}]));
        // Capture all recovery/maintenance/reconciliation and Schedule history in
        // authoritative directories. Unknown artifacts are evidence, never ignored.
        const directories=new Set([this.root,...Object.values(this.paths).map(dirname)]);
        const runtimeDirectory=join(this.root,'var');
        try{const stat=await lstat(runtimeDirectory);if(!stat.isDirectory()||stat.isSymbolicLink())fail('NEW_ERA_UNKNOWN_NAMESPACE');directories.add(runtimeDirectory);}
        catch(error){if(error.code!=='ENOENT')throw error;}
        for(const directory of directories){
            for(const name of await readdir(directory)){
                const owned=authorization&&(name.endsWith('.retired-era-'+authorization.transitionId)||
                    name===basename(this.paths.schedule)+'.era-'+authorization.transitionId+'.stage'||
                    name===basename(this.paths.schedule)+'.era-'+authorization.transitionId+'.stage.stage'||
                    [this.paths.ledger,this.paths.ledger+'.wal',this.paths.bootstrap].some(p=>name===basename(p)+'.stage'));
                const domain=[this.paths.ledger,this.paths.authority,this.paths.scheduledJournal,this.paths.schedule].filter(Boolean)
                    .some(p=>dirname(p)===directory&&name.toLowerCase().startsWith(basename(p).toLowerCase()+'.'));
                if(!owned&&(domain||/recovery|reconcil|maintenance|migration|\.ready$|\.prepared$|\.disarm|schedule.*history/i.test(name))){
                    const path=join(directory,name),s=await lstat(path);
                    if(!s.isFile()||s.isSymbolicLink())fail('NEW_ERA_UNKNOWN_NAMESPACE');
                    const rel=relative(this.root,path);if(!paths.has(rel))paths.set(rel,{key:'audit:'+rel,path});
                }
            }
        }
        for(const suffix of ['.wal','.migration.intent','.migration.activated','.migration.completed']){
            const path=this.paths.ledger+suffix;paths.set(relative(this.root,path),{key:'absence:'+suffix,path});
        }
        const captures=await Promise.allSettled([...paths].sort(([a],[b])=>a.localeCompare(b)).map(async([name,{key,path}])=>{
            const captured=await evidence(path);
            if(captured&&(await lstat(path)).nlink!==1)fail('NEW_ERA_MULTILINK_EVIDENCE');
            return {key,name,present:captured!==null,byteLength:captured?.byteLength??0,sha256:captured?.sha256??null,
                bytes:captured?.bytes.toString('base64')??null};
        }));
        for(const captured of captures)if(captured.status==='rejected')throw captured.reason;
        return captures.map(c=>c.value);
    }
    async dryRun(options={}){
        return {...await this.inspectDryRun(options),eligibleForRealExecution:false,
            hostProof:'NOT_EXECUTED_BY_READ_ONLY_DRYRUN',nativeCapability:'NOT_PROBED_BY_READ_ONLY_DRYRUN'};
    }
    inspectRecovery(options={}){return inspectNewEraRecovery(this,options);}
    async inspectDryRun({expectedInventoryHash}={}){
        try{
            let names=[];try{names=await readdir(this.directory);}catch(e){if(e.code!=='ENOENT')throw e;}
            if(names.length){
                try{const era=executionEraStartup(this.paths.ledger);return {classification:'ALREADY_TRANSITIONED',executionEraId:era.executionEraId,eligible:false};}
                catch(error){
                    const first=await evidence(join(this.directory,'authorized.json'));
                    if(!first)return {classification:names.length===1&&names[0]==='authorized.json.stage'?'PARTIAL_RESUMABLE':'UNSUPPORTED_STATE',eligible:false,reason:'MATCHING_AUTHORIZATION_REQUIRED_FOR_STAGING_PREFIX'};
                    const a=unsealEra(JSON.parse(first.bytes)).authorization;
                    let previous=null,gap=false;
                    for(const phase of ERA_PHASES){
                        const saved=await evidence(join(this.directory,phase+'.json'));
                        if(!saved){gap=true;continue;}
                        const record=JSON.parse(saved.bytes),body=unsealEra(record);
                        if(gap||body.phase!==phase||body.previous!==previous||!equal(body.authorization,a))fail('NEW_ERA_PARTIAL_LINEAGE_INVALID');
                        if(!saved.bytes.equals(encode(seal({version:1,phase,previous,authorization:a}))))fail('NEW_ERA_PARTIAL_BYTES_CHANGED');
                        previous=record.checksum;
                    }
                    await this.fence(a,{offline:false});
                    return {classification:'PARTIAL_RESUMABLE',eligible:false,executionEraId:a.executionEraId,
                        authorizationHash:hash(a),phases:names,reason:error.code??error.message};
                }
            }
            const inventory=await this.inventory(),by=Object.fromEntries(inventory.map(i=>[i.key,i]));
            if(by.authorityGate?.present)fail('NEW_ERA_MAINTENANCE_RESERVATION_PRESENT');
            if(inventory.some(i=>i.present&&i.key.startsWith('audit:')&&/\.(?:tmp|stage)$|\.shutdown\.|\.terminal\./i.test(i.name)))fail('NEW_ERA_AMBIGUOUS_LEGACY_NAMESPACE');
            if(mandatory.some(k=>!by[k]?.present)||inventory.some(i=>i.key.startsWith('absence:')&&i.present))fail('NEW_ERA_UNSUPPORTED_LEGACY_STATE');
            const ledger=validateLedgerSnapshot(parse(by.ledger)),lock=parse(by.ledgerLock);
            if(ledger.schemaVersion!==1||lock.version!==1)fail('NEW_ERA_LEGACY_LOCK_REQUIRED');
            const schedule=normalizeSchedule(parse(by.schedule));
            if(schedule.version!==3||schedule.executionEra||schedule.revision===Number.MAX_SAFE_INTEGER)fail('NEW_ERA_SCHEDULE_V3_REQUIRED');
            const program=validateRecord(parse(by.program)),autoLive=parse(by.autoLive),authority=parse(by.authority);
            await validateNewEraProgram(this.paths);
            if(program.programState!=='PRESENT'||autoLive.enabled!==true||autoLive.armed!==false||!autoLive.sourceId||
                !Number.isSafeInteger(authority.epoch)||authority.epoch<1)fail('NEW_ERA_CONTINUITY_REQUIRED');
            const inventoryHash=hash(inventory);
            return {classification:expectedInventoryHash&&expectedInventoryHash!==inventoryHash?'CHANGED_LEGACY_STATE':'EXACT_ELIGIBLE_LEGACY_STATE',
                eligible:!expectedInventoryHash||expectedInventoryHash===inventoryHash,reason:NEW_ERA_REASON,inventoryHash,inventory,
                repository:this.root,repositoryId:repositoryIdentity(this.root),observedEpoch:authority.epoch,
                program:{generation:program.generation,programState:program.programState,acceptedAuthorityEpoch:program.acceptedAuthorityEpoch},
                historyAvailability:'AVAILABLE_FILES_CAPTURED; DELETED_OR_UNAVAILABLE_HISTORY_NOT_RECONSTRUCTED'};
        }catch(error){return {classification:'UNSUPPORTED_STATE',eligible:false,reason:error.code??error.message};}
    }
    async plan({principal,approvedHead,approvedBranch,expectedInventoryHash,authorizeNewEra,retireWholeLegacyDomain}){
        if(authorizeNewEra!==true||retireWholeLegacyDomain!==true||typeof principal!=='string'||!principal.trim()||
            !/^[a-f0-9]{40}$/.test(approvedHead)||!approvedBranch||!/^[a-f0-9]{64}$/.test(expectedInventoryHash))fail('NEW_ERA_EXPLICIT_AUTHORIZATION_REQUIRED');
        const proof=await this.currentRuntimeProof();
        const view=await this.dryRun({expectedInventoryHash});if(!view.eligible)fail('NEW_ERA_EVIDENCE_CHANGED');
        const transitionId=randomUUID(),executionEraId=randomUUID(),ledgerId=randomUUID();
        const oldEraId=hash({domain:'LIVEZONE_FORENSIC_OLD_EXECUTION_DOMAIN_V1',inventory:view.inventory});
        const retirementHash=hash({version:1,transitionId,oldEraId,executionEraId,domain:'ALL_LEGACY_AND_UNBOUND_IDENTITIES_PERMANENTLY_RETIRED'});
        const scheduleEra={version:1,executionEraId,retirementHash,transitionId};
        const marker={version:2,kind:'NEW_ERA',transitionId,executionEraId,ledgerId,retirementHash};
        return {version:1,action:'NEW_ERA',principal,approvedHead,approvedBranch,repository:this.root,repositoryId:view.repositoryId,
            createdAt:new Date().toISOString(),authorizeNewEra:true,retireWholeLegacyDomain:true,reason:NEW_ERA_REASON,
            authorizedProofHash:proof.proofHash,
            transitionId,executionEraId,ledgerId,oldEraId,retirementHash,scheduleEra,marker,inventoryHash:view.inventoryHash,inventory:view.inventory,
            ledgerPath:this.paths.ledger,schedulePath:this.paths.schedule,paths:this.paths,
            oldEventIds:parse(view.inventory.find(i=>i.key==='schedule')).events.map(e=>e.id),
            storage:{helperSha256,gateSha256,version:'1.0.0',protocol:1,architecture:'x64',filesystem:'NTFS',local:true}};
    }
    async currentRuntimeProof(){
        const host=await this.host.inspect();
        const proof=this.verifyRuntimeCapability(this.runtimeCapabilityProof,{serviceIdentity:host.service?.StartName});
        if(typeof proof?.proofHash!=='string'||!/^[a-f0-9]{64}$/.test(proof.proofHash))fail('NEW_ERA_VERIFIED_PROOF_IDENTITY_REQUIRED');
        return proof;
    }
    async verifyAuthorizationProof(a){
        const proof=await this.currentRuntimeProof();
        if(proof.proofHash!==a.authorizedProofHash)fail('NEW_ERA_AUTHORIZATION_PROOF_CHANGED');
        return proof;
    }
    // Read-only checkpoint derived from existing canonical bytes. No new journal,
    // phase format or recovery boundary is introduced by operator orchestration.
    async transitionStatus(a){
        this.assertAuthorization(a);
        const h=await this.host.inspect();
        if(this.reserved&&h.ports.some(p=>p.LocalPort!==8080||p.OwningProcess!==process.pid))fail('NEW_ERA_RESERVATION_CONFLICT');
        assertHost({...h,ports:this.reserved?[]:h.ports},this.root,{expected:{...this.expected,head:a.approvedHead,branch:a.approvedBranch}});
        const proof=await this.verifyAuthorizationProof(a);
        await this.fence(a,{offline:false});
        const checkpoint=await this.readTransitionCheckpoint(a);
        return {...checkpoint,transitionId:a.transitionId,executionEraId:a.executionEraId,ledgerId:a.ledgerId,
            authorizationHash:hash(a),authorizedProofHash:a.authorizedProofHash,continuationAuthorizationCurrent:true,
            checkpointHash:hash({authorizationHash:hash(a),proofHash:proof.proofHash,head:h.head,branch:h.branch,
                service:h.service,media:h.media,completedPhase:checkpoint.completedPhase,evidence:checkpoint.evidence})};
    }
    async readTransitionCheckpoint(a){
        const captures=new Map();
        const capture=async path=>{const item=await evidence(path);if(item&&(await lstat(path)).nlink!==1)fail('NEW_ERA_MULTILINK_EVIDENCE');
            captures.set(path,{path:relative(this.root,path),present:!!item,sha256:item?.sha256??null,byteLength:item?.byteLength??0});return item;};
        const names=async directory=>{try{const st=await lstat(directory);if(!st.isDirectory()||st.isSymbolicLink()||resolve(await realpath(directory)).toLowerCase()!==directory.toLowerCase())fail('NEW_ERA_ALIASED_REPOSITORY');return await readdir(directory);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
        const phaseNames=await names(this.directory);let previous=null,completed=-1,gap=false,stage=null,partialPhase=null;
        for(const [index,phase] of ERA_PHASES.entries()){
            const wanted=encode(seal({version:1,phase,previous,authorization:a}));
            const saved=await capture(join(this.directory,phase+'.json'));
            const partial=await capture(join(this.directory,phase+'.json.stage'));
            if(saved){if(gap||partial||!saved.bytes.equals(wanted))fail('NEW_ERA_PHASE_LINEAGE_CHANGED');previous=JSON.parse(saved.bytes).checksum;completed=index;}
            else{gap=true;if(partial){if(stage||index!==completed+1||!wanted.subarray(0,partial.byteLength).equals(partial.bytes))fail('NEW_ERA_PHASE_STAGE_CHANGED');stage=phase;}}
        }
        const next=ERA_PHASES[completed+1]??null;
        if(completed<7&&phaseNames.some(name=>!ERA_PHASES.some(p=>name===p+'.json'||name===p+'.json.stage')))fail('NEW_ERA_UNKNOWN_PHASE_ARTIFACT');
        const done=phase=>completed>=ERA_PHASES.indexOf(phase);
        const present=a.inventory.filter(i=>i.present);
        const manifest=encode(seal({version:1,reason:a.reason,repository:a.repository,approvedHead:a.approvedHead,
            authorizationHash:hash(a),principal:a.principal,transitionId:a.transitionId,executionEraId:a.executionEraId,oldEraId:a.oldEraId,
            historyAvailability:'UNAVAILABLE_HISTORY_NOT_RECONSTRUCTED',inventory:a.inventory.map(({bytes,...item})=>({...item,blob:item.present?'blob-'+item.sha256:null}))}));
        const forensicTargets=new Map(present.map(i=>['blob-'+i.sha256,Buffer.from(i.bytes,'base64')]));forensicTargets.set('manifest.json',manifest);
        const forensicNames=await names(this.forensic);
        if(next==='forensic'&&forensicNames.length)partialPhase=next;
        for(const name of forensicNames){
            const base=name.endsWith('.stage')?name.slice(0,-6):name;
            if(!forensicTargets.has(base)||(!done('forensic')&&next!=='forensic')||(done('forensic')&&name!==base))fail('NEW_ERA_FORENSIC_CHANGED');
        }
        for(const [name,wanted] of forensicTargets){
            const item=await capture(join(this.forensic,name)),partial=await capture(join(this.forensic,name+'.stage'));
            if(done('forensic')&&(!item||partial))fail('NEW_ERA_FORENSIC_CHANGED');
            if(item&&!item.bytes.equals(wanted)||partial&&(item||!wanted.subarray(0,partial.byteLength).equals(partial.bytes)))fail('NEW_ERA_FORENSIC_CHANGED');
        }
        for(const item of present.filter(i=>['ledger','ledgerLock','bootstrap','authorityLock','scheduledLock','scheduledJournal'].includes(i.key))){
            const retired=await capture(join(this.root,item.name)+'.retired-era-'+a.transitionId);
            if(retired&&next==='archived')partialPhase=next;
            if(done('archived')&&!retired||retired&&(!done('archived')&&next!=='archived'||retired.sha256!==item.sha256))fail('NEW_ERA_RETIREMENT_CHANGED');
        }
        for(const [path,wanted] of this.targets(a)){
            const phase=path===this.paths.schedule?'schedule':'ledger',item=await capture(path);
            const old=a.inventory.find(i=>join(this.root,i.name)===path);
            if(done(phase)&&!item?.bytes.equals(wanted))fail('NEW_ERA_CHECKPOINT_TARGET_CHANGED');
            const archivedTarget=phase==='ledger'&&[this.paths.ledger,this.paths.bootstrap].includes(path);
            if(!done(phase)&&next!==phase&&item?.sha256!==((done('archived')&&phase==='ledger')?undefined:old?.present?old.sha256:undefined)&&
                !(next==='archived'&&archivedTarget&&!item))fail('NEW_ERA_UNEXPECTED_LATER_ARTIFACT');
            const stagePath=phase==='schedule'?path+'.era-'+a.transitionId+'.stage':path+'.stage';
            const partial=await capture(stagePath),nested=phase==='schedule'?await capture(stagePath+'.stage'):null;
            if(next===phase&&(partial||nested||item?.bytes.equals(wanted)))partialPhase=next;
            if((partial||nested)&&next!==phase)fail('NEW_ERA_UNEXPECTED_LATER_ARTIFACT');
            if(partial&&!wanted.subarray(0,partial.byteLength).equals(partial.bytes)||nested&&!wanted.subarray(0,nested.byteLength).equals(nested.bytes))fail('NEW_ERA_CHECKPOINT_TARGET_CHANGED');
        }
        if(done('activated'))executionEraStartup(this.paths.ledger);
        return {status:done('activated')?'ACTIVATED_OFFLINE':'OPERATOR_CHECKPOINT',completedPhase:ERA_PHASES[completed]??null,
            nextPhase:next,partialPhase:stage??partialPhase,canonicalResumeRequired:!!(stage??partialPhase),reviewRequired:false,operatorInspectionRequired:!done('activated'),
            evidence:[...captures.values()].sort((x,y)=>x.path.localeCompare(y.path))};
    }
    targets(a){
        const snapshot=ledgerSnapshot({ledgerId:a.ledgerId,executionEraId:a.executionEraId,retirementHash:a.retirementHash});
        const base=seal({schemaVersion:2,type:'BASE',previous:null,data:{repositoryId:repositoryIdentity(this.paths.ledger),snapshot,namespaceDurability:'DIRECTORY_SYNCED'}});
        const oldSchedule=parse(a.inventory.find(i=>i.key==='schedule'));
        const schedule=normalizeSchedule({...oldSchedule,revision:oldSchedule.revision+1,executionEra:a.scheduleEra});
        return new Map([[this.paths.ledger,encode(envelope(this.paths.ledger,snapshot))],[this.paths.ledger+'.wal',encode(base)],
            [this.paths.bootstrap,encode(a.marker)],[this.paths.schedule,encode(schedule)]]);
    }
    async offline(a){
        if(!this.host||!this.reserved)fail('NEW_ERA_OFFLINE_RESERVATION_REQUIRED');
        const h=await this.host.inspect();
        if(!Array.isArray(h.ports)||h.ports.some(p=>p.LocalPort!==8080||p.OwningProcess!==process.pid))fail('NEW_ERA_RESERVATION_CONFLICT');
        assertHost({...h,ports:[]},this.root,{expected:{...this.expected,head:a.approvedHead,branch:a.approvedBranch}});
        if((await this.host.proveOffline()).absent!==true)fail('CANONICAL_OFFLINE_PROOF_REQUIRED');
    }
    async fence(a,{offline=true}={}){
        if(offline)await this.offline(a);
        const targets=this.targets(a),archived=new Set(['ledger','ledgerLock','bootstrap','authorityLock','scheduledLock','scheduledJournal']);
        const checks=await Promise.allSettled(a.inventory.map(async item=>{
            const path=join(this.root,item.name),current=await evidence(path),destination=path+'.retired-era-'+a.transitionId;
            const moved=archived.has(item.key)?await evidence(destination):null;
            if(moved&&moved.sha256!==item.sha256)fail('NEW_ERA_ARCHIVE_CONFLICT');
            const target=targets.get(path);
            if(current?.sha256===item.sha256&&!moved)return;
            if(!item.present&&!current)return;
            if(archived.has(item.key)&&moved&&(!current||(target&&current.sha256===hash(target))))return;
            if(item.key==='schedule'&&target&&current?.sha256===hash(target))return;
            if(item.key==='absence:.wal'&&target&&current?.sha256===hash(target))return;
            fail('NEW_ERA_EVIDENCE_CHANGED');
        }));
        for(const checked of checks)if(checked.status==='rejected')throw checked.reason;
        // Newly appeared audits or authority staging also revoke authorization.
        const observed=await this.inventory(a);
        if(observed.some(i=>!a.inventory.some(old=>old.name===i.name)))fail('NEW_ERA_NAMESPACE_CHANGED');
        await validateNewEraProgram(this.paths);
        if(offline&&this.phasedExecution)await this.readTransitionCheckpoint(a);
        // Recheck after evidence reads and after each existing mutation hook.
        // No cached verification or caller-supplied identity authorizes a write.
        if(offline)await this.verifyAuthorizationProof(a);
    }
    async publish(path,wanted,a){
        await this.fence(a);await this.hook('before-open',path);await this.fence(a);
        const installed=await evidence(path),stage=path+'.stage';
        if(installed){if(!installed.bytes.equals(wanted))fail('NEW_ERA_INSTALLED_CONFLICT');if(!await absent(stage))fail('NEW_ERA_STAGING_AMBIGUOUS');await this.durability.syncFile(path);return;}
        let partial=await evidence(stage);
        if(partial&&!wanted.subarray(0,partial.byteLength).equals(partial.bytes))fail('NEW_ERA_STAGING_CONFLICT');
        const file=await open(stage,partial?'a':'wx',0o600);
        try{
            await this.hook('opened',path);await this.fence(a);const offset=partial?.byteLength??0,mid=offset+Math.ceil((wanted.length-offset)/2);
            await file.writeFile(wanted.subarray(offset,mid));await this.hook('partial-written',path);await this.fence(a);
            await file.writeFile(wanted.subarray(mid));await this.hook('written',path);await file.sync();await this.hook('file-flushed',path);
        }finally{await file.close();}
        this.durability.sync(stage);await this.hook('namespace-flushed',path);
        await this.fence(a);await this.hook('before-install',path);await this.fence(a);
        if(!(await evidence(stage))?.bytes.equals(wanted))fail('NEW_ERA_STAGE_CHANGED');
        await this.durability.archive(stage,path);await this.hook('installed',path);
        await this.durability.syncFile(path);
        if((await evidence(path))?.sha256!==hash(wanted))fail('NEW_ERA_READBACK_CHANGED');
        await this.hook('durable',path);
    }
    assertAuthorization(a){
        if(a?.action!=='NEW_ERA'||a.authorizeNewEra!==true||a.retireWholeLegacyDomain!==true||a.repository!==this.root||
            typeof a.authorizedProofHash!=='string'||!/^[a-f0-9]{64}$/.test(a.authorizedProofHash)||
            !equal(a.paths,this.paths)||a.reason!==NEW_ERA_REASON||a.inventoryHash!==hash(a.inventory)||!equal(a.storage,
                {helperSha256,gateSha256,version:'1.0.0',protocol:1,architecture:'x64',filesystem:'NTFS',local:true}))fail('NEW_ERA_AUTHORIZATION_INVALID');
        if(!Array.isArray(a.inventory)||new Set(a.inventory.map(i=>i.name.toLowerCase())).size!==a.inventory.length)fail('NEW_ERA_AUTHORIZATION_INVALID');
        for(const item of a.inventory){
            const path=resolve(this.root,item.name),r=relative(this.root,path);
            if(!r||r.startsWith('..')||isAbsolute(r)||item.name!==r||
                (item.present?(item.byteLength!==Buffer.from(item.bytes,'base64').length||item.sha256!==hash(Buffer.from(item.bytes,'base64'))):item.bytes!==null||item.sha256!==null||item.byteLength!==0))fail('NEW_ERA_AUTHORIZATION_INVALID');
        }
        for(const key of mandatory){const item=a.inventory.find(i=>i.key===key);if(!item?.present||join(this.root,item.name)!==this.paths[key])fail('NEW_ERA_AUTHORIZATION_INVALID');}
        const by=Object.fromEntries(a.inventory.map(i=>[i.key,i]));
        if(validateLedgerSnapshot(parse(by.ledger)).schemaVersion!==1||parse(by.ledgerLock).version!==1||
            normalizeSchedule(parse(by.schedule)).version!==3||parse(by.schedule).executionEra||
            validateRecord(parse(by.program)).programState!=='PRESENT'||parse(by.autoLive).enabled!==true||parse(by.autoLive).armed!==false||
            a.inventory.some(i=>i.key.startsWith('absence:')&&i.present))fail('NEW_ERA_UNSUPPORTED_LEGACY_STATE');
        if(![a.executionEraId,a.transitionId,a.ledgerId].every(uuid)||new Set([a.executionEraId,a.transitionId,a.ledgerId]).size!==3||
            a.ledgerPath!==this.paths.ledger||a.schedulePath!==this.paths.schedule||!a.principal?.trim()||
            !/^[a-f0-9]{40}$/.test(a.approvedHead)||a.approvedBranch!=='build/1003.9A1'||
            a.oldEraId!==hash({domain:'LIVEZONE_FORENSIC_OLD_EXECUTION_DOMAIN_V1',inventory:a.inventory})||
            a.retirementHash!==hash({version:1,transitionId:a.transitionId,oldEraId:a.oldEraId,executionEraId:a.executionEraId,domain:'ALL_LEGACY_AND_UNBOUND_IDENTITIES_PERMANENTLY_RETIRED'})||
            !equal(a.oldEventIds,parse(a.inventory.find(i=>i.key==='schedule')).events.map(e=>e.id))||
            !equal(a.scheduleEra,{version:1,executionEraId:a.executionEraId,retirementHash:a.retirementHash,transitionId:a.transitionId})||
            !equal(a.marker,{version:2,kind:'NEW_ERA',transitionId:a.transitionId,executionEraId:a.executionEraId,ledgerId:a.ledgerId,retirementHash:a.retirementHash}))fail('NEW_ERA_AUTHORIZATION_INVALID');
    }
    async transition(a,{phase,expectedCheckpointHash}={}){
        const requestedPhase=phase;
        a=structuredClone(a);this.assertAuthorization(a);
        let release;
        try{
            if(phase!==undefined){
                if(!ERA_PHASES.includes(phase)||typeof expectedCheckpointHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedCheckpointHash))fail('NEW_ERA_EXPLICIT_PHASE_REQUIRED');
                const current=await this.transitionStatus(a);
                if(current.checkpointHash!==expectedCheckpointHash)fail('NEW_ERA_CHECKPOINT_CHANGED');
                if(current.completedPhase===phase)return {...current,status:'ALREADY_COMPLETED_PHASE'};
                if(current.nextPhase!==phase)fail('NEW_ERA_PHASE_OUT_OF_ORDER');
            }
            const proof=await this.verifyAuthorizationProof(a);
            release=await this.host.reserve();this.reserved=true;await this.offline(a);
            for(const directory of new Set([this.root,...Object.values(this.paths).map(dirname)])){
                if(resolve(await realpath(directory)).toLowerCase()!==directory.toLowerCase())fail('NEW_ERA_ALIASED_REPOSITORY');
                const capability=this.native.capability(directory);
                if(proof.volume&&capability.volume!==proof.volume)fail('LOCALSYSTEM_CAPABILITY_VOLUME_MISMATCH');
            }
            if(phase!==undefined){
                const current=await this.transitionStatus(a);
                if(current.checkpointHash!==expectedCheckpointHash)fail('NEW_ERA_CHECKPOINT_CHANGED');
                if(current.nextPhase!==phase)fail('NEW_ERA_PHASE_OUT_OF_ORDER');
                this.phasedExecution=true;
            }
            const existing=await evidence(join(this.directory,'authorized.json'));
            if(existing&&!equal(unsealEra(JSON.parse(existing.bytes)).authorization,a))fail('NEW_ERA_AUTHORIZATION_CHANGED');
            if(await absent(join(this.directory,'activated.json'))===false){
                const era=executionEraStartup(this.paths.ledger);if(era.transitionId!==a.transitionId)fail('NEW_ERA_AUTHORIZATION_CHANGED');
                return {status:'ALREADY_TRANSITIONED',executionEraId:era.executionEraId};
            }
            await this.fence(a);await this.durability.ensureDirectory(this.directory);await this.durability.ensureDirectory(this.forensic);
            let previous=null;
            for(const phase of ERA_PHASES){
                const phasePath=join(this.directory,phase+'.json');
                if(requestedPhase&&ERA_PHASES.indexOf(phase)<ERA_PHASES.indexOf(requestedPhase)){
                    previous=JSON.parse((await evidence(phasePath)).bytes).checksum;continue;
                }
                if(phase==='forensic'){
                    for(const item of a.inventory.filter(i=>i.present))await this.publish(join(this.forensic,'blob-'+item.sha256),Buffer.from(item.bytes,'base64'),a);
                    await this.publish(join(this.forensic,'manifest.json'),encode(seal({version:1,reason:a.reason,repository:a.repository,approvedHead:a.approvedHead,
                        authorizationHash:hash(a),principal:a.principal,transitionId:a.transitionId,executionEraId:a.executionEraId,oldEraId:a.oldEraId,
                        historyAvailability:'UNAVAILABLE_HISTORY_NOT_RECONSTRUCTED',inventory:a.inventory.map(({bytes,...item})=>({...item,blob:item.present?'blob-'+item.sha256:null}))})),a);
                }
                if(phase==='archived'){
                    for(const item of a.inventory.filter(i=>i.present&&['ledger','ledgerLock','bootstrap','authorityLock','scheduledLock','scheduledJournal'].includes(i.key))){
                        const source=join(this.root,item.name),destination=source+'.retired-era-'+a.transitionId;
                        await this.fence(a);await this.hook('before-archive',source);await this.fence(a);
                        if(await absent(destination))await this.durability.archive(source,destination);
                        await this.durability.syncFile(destination);await this.hook('archived',source);
                    }
                }
                if(phase==='ledger')for(const [path,bytes] of this.targets(a))if(path!==this.paths.schedule)await this.publish(path,bytes,a);
                if(phase==='schedule'){
                    const path=this.paths.schedule,wanted=this.targets(a).get(path),current=await evidence(path);
                    if(current?.sha256!==hash(wanted)){
                        const stage=path+'.era-'+a.transitionId+'.stage';await this.publish(stage,wanted,a);
                        await this.fence(a);await this.hook('before-schedule-replace',path);await this.fence(a);
                        if(!(await evidence(stage))?.bytes.equals(wanted))fail('NEW_ERA_STAGE_CHANGED');
                        this.durability.replace(stage,path);await this.durability.syncFile(path);await this.hook('schedule-replaced',path);
                    }
                }
                const record=seal({version:1,phase,previous,authorization:a});
                await this.publish(phasePath,encode(record),a);previous=record.checksum;await this.hook('phase:'+phase,phasePath);
                if(requestedPhase===phase)return await this.transitionStatus(a);
            }
            const era=executionEraStartup(this.paths.ledger);
            return {status:'ACTIVATED_OFFLINE',executionEraId:era.executionEraId,ledgerId:era.ledgerId,transitionId:a.transitionId};
        }finally{this.phasedExecution=false;this.reserved=false;if(release)await release();}
    }
}
