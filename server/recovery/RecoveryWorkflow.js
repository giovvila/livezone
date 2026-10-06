import {readdir,realpath} from 'node:fs/promises';
import {namespaceStarts,namespaceEnds,assertUniqueNames} from './RecoveryNamespace.js';
import {dirname,basename,join} from 'node:path';
import {acquireMaintenanceGate} from '../autolive/AuthorityMaintenanceGate.js';
import {reconcileScheduledExecutionLock} from '../scheduler/ReconcileScheduledExecutionLock.js';
import {repositoryIdentity} from '../scheduler/ScheduledExecutionProvenance.js';
import {normalizeConfig} from '../autolive/AutoLiveContract.js';
import {controlledSchedule} from '../scheduler/ScheduleContract.js';
import {validateRecord} from '../program-output/DurableProgramContract.js';
import {offlineDisarm} from './OfflineDisarm.js';
import {paths,capture,artifact,exclusive,writeOnce,classifyMaintenance,scheduledClassification,bootstrapPlan,assertRestore,recoveryIdentity,assertRepository,fail,same} from './RecoveryContract.js';
import {assertHost} from './WindowsRecoveryHost.js';
import {CleanLedgerV1Migration,validateMigrationCompletion,validateMigrationIntent} from './CleanLedgerV1Migration.js';
import {hash,seal} from '../scheduler/ScheduledEntryLedgerV2Protocol.js';
import {verifyRestoreAuthority} from './RestoreLedgerAuthority.js';
import {lineageContext,phaseRecord,validatePhase,phaseChain} from './RecoveryLineage.js';
import {capturedEvidence} from './PersistentEvidence.js';

// A completed Restore retry is read-only. Its already-restored StartMode is
// accepted only with two fresh canonical censuses proving no authority process.
function restoredAbsence(proof,startMode){
    return proof?.absent===true||(Array.isArray(proof?.services)&&proof.services.length===1&&
        proof.services[0].State==='Stopped'&&proof.services[0].StartMode===startMode&&Array.isArray(proof.processes)&&
        proof.processes.every(p=>Number.isSafeInteger(p.pid)&&p.pid>0&&!p.blocks&&
            ['MAINTENANCE_SELF','UNRELATED_ADOBE','UNRELATED_CODEX'].includes(p.kind)));
}

export class RecoveryWorkflow {
    constructor({root,runId,host,expectedHead,hook=()=>{}}){
        this.p=paths(root);this.host=host;this.hook=hook;this.expected=recoveryIdentity(expectedHead);
        if(runId!==undefined&&!/^[a-zA-Z0-9_-]{1,80}$/.test(runId))fail('INVALID_RECOVERY_RUN_ID');
        this.runId=runId;this.audit=join(this.p.root,'var','recovery-'+(runId||'UNSPECIFIED')+'.json');
        this.migration=new CleanLedgerV1Migration({path:this.p.ledger,authorityPath:this.p.authority,scheduledPath:this.p.scheduled,
            root:this.p.root,host,expected:this.expected,hook:stage=>this.hook('migration-'+stage)});
    }
    async inspect(){
        const [host,evidence]=await Promise.all([this.host.inspect(),capture(this.p)]);
        assertRepository(host,this.p.root,this.expected);
        if(classifyMaintenance(evidence.maintenance?.value,host.service,this.p.root)==='CONFLICT')fail('MAINTENANCE_CONFLICT');
        return {expected:this.expected,host,evidence,...await this.migration.inspect(),maintenance:classifyMaintenance(evidence.maintenance?.value,host.service,this.p.root),
            scheduled:scheduledClassification(evidence,this.p),proposed:[
                'STOP unless administrator, expected branch/HEAD, canonical census, Stopped/Disabled service and port 8080 free',
                'Adopt/preserve maintenance record; create separate current-HEAD audit',
                'New-schema Scheduled reconciliation BEFORE AutoLive; legacy quarantine AFTER AutoLive',
                'Invoke canonical AutoLive CLI with fresh exact evidence',
                'Explicit LEGACY_UNVERIFIABLE quarantine only when authorized and journal absent',
                'Separate explicitly authorized AutoLiveStore disarm preserving enabled/source',
                'One foreground controlled startup; process-local bootstrap only when authorized and ledger absent',
                'Observe canonical migration and verify full readiness; retain restart reconciliation requirement',
                'Ctrl+C/drain manual process; separate configuration-only service restore']};
    }
    async preflight({reserved=false,ownedGate=false,restored=null}={}){
        const h=await this.host.inspect();let checked=h;
        if(reserved){
            if(!Array.isArray(h.ports)||h.ports.some(p=>p.LocalPort!==8080||p.OwningProcess!==process.pid))fail('MIGRATION_RESERVATION_PORT_CONFLICT');
            checked={...checked,ports:[]};
        }
        if(restored){
            if(!same(h.service,restored.service)||h.service.State!=='Stopped')fail('RESTORE_COMPLETION_SERVICE_CHANGED');
            if(!restoredAbsence(h.proof,h.service.StartMode))fail('CANONICAL_OFFLINE_PROOF_REQUIRED');
            checked={...checked,proof:{...h.proof,absent:true},service:{...h.service,StartMode:'Disabled'}};
        }
        assertHost(checked,this.p.root,{expected:this.expected});
        const proof=await this.host.proveOffline();
        if(restored?!restoredAbsence(proof,h.service.StartMode):proof.absent!==true)fail('CANONICAL_OFFLINE_PROOF_REQUIRED');
        for(const path of [this.p.root,dirname(this.p.authority),dirname(this.p.schedule),dirname(this.audit)])
            if(repositoryIdentity(await realpath(path))!==repositoryIdentity(path))fail('ALIASED_RECOVERY_DIRECTORY');
        try{if(repositoryIdentity(await realpath(this.p.mediaRoot))!==repositoryIdentity(this.p.mediaRoot))fail('ALIASED_RECOVERY_DIRECTORY');}
        catch(error){if(error.code!=='ENOENT')throw error;}
        const e=await capture(this.p);
        if(classifyMaintenance(e.maintenance?.value,checked.service,this.p.root)==='CONFLICT')fail('MAINTENANCE_CONFLICT');
        controlledSchedule(e.schedule?.value);
        if(e.gate&&!ownedGate)fail('MAINTENANCE_GATE_REVIEW_REQUIRED');
        if(ownedGate)e.gate=null;
        h.evidence=e;
        return h;
    }
    async offline(fn,{review=options=>this.preflight(options)}={}){
        const h=await review({}),release=await this.host.reserve();let gate;
        try{
            await this.hook('before-mutation-recheck');
            const fresh=await review({reserved:true});
            if(!same(fresh.evidence,h.evidence)||!same(fresh.service,h.service)||!same(fresh.media,h.media)||
                !same(fresh.review,h.review))fail('PREFLIGHT_EVIDENCE_CHANGED');
            gate=await acquireMaintenanceGate(this.p.authority);return await fn(h);
        }finally{if(gate)await gate();await release();}
    }
    async load(){
        if(!this.runId)fail('RECOVERY_RUN_ID_REQUIRED');
        const r=(await artifact(this.audit))?.value;
        if(!r||r.version!==1||r.root!==this.p.root||r.head!==this.expected.head||r.branch!==this.expected.branch||r.runId!==this.runId)fail('RECOVERY_AUDIT_REQUIRED');
        return r;
    }
    async prepareReview({phase,authorizeLegacy=false,...options}){
        if(!this.runId)fail('RECOVERY_RUN_ID_REQUIRED');
        if((await artifact(this.p.ledgerLock))?.value.version===1)fail('LEGACY_LEDGER_LOCK_UNVERIFIABLE');
        const h=await this.preflight(options),e=h.evidence;
        if(e.mediaDelete)fail('MEDIA_DELETE_JOURNAL_REVIEW_REQUIRED');
        normalizeConfig(e.auto?.value);controlledSchedule(e.schedule?.value);validateRecord(e.program?.value);
        if(!Number.isSafeInteger(e.authority?.value.epoch)||e.authority.value.epoch<1)fail('AUTHORITY_EPOCH_REQUIRED');
        const classification=classifyMaintenance(e.maintenance?.value,h.service,this.p.root),scheduled=scheduledClassification(e,this.p);
        if(!['ABSENT','VERIFIABLE','LEGACY_UNVERIFIABLE'].includes(scheduled))fail(scheduled);
        const saved=await artifact(this.audit),r=saved?await this.load():null;
        if(phase==='begin'&&scheduled==='LEGACY_UNVERIFIABLE'&&!authorizeLegacy)fail('EXPLICIT_LEGACY_AUTHORIZATION_REQUIRED');
        if(phase==='begin'&&r&&r.authorizeLegacy!==authorizeLegacy)fail('RECOVERY_AUTHORIZATION_CHANGED');
        if(phase==='prepared'&&!r)fail('RECOVERY_AUDIT_REQUIRED');
        bootstrapPlan(e,true);
        const disarm=await artifact(this.audit+'.disarm.completed');
        const audited=r&&disarm?.value.state==='COMPLETED'&&disarm.value.beforeHash===r.before.auto.hash&&
            disarm.value.afterHash===e.auto?.hash&&e.auto.value.armed===false;
        if(r){
            this.assertStable(e,r,audited?['schedule','program','ledger','ledgerLock','ledgerWal','marker','scheduled']:undefined);
            if(e.authority?.hash!==r.before.authority.hash)fail('AUTHORITY_EPOCH_CHANGED');
            const record=r.before.maintenance?.value??{Version:1,Repository:r.root,Head:r.head,CapturedAt:r.at,Original:r.original};
            if(e.maintenance&&!same(e.maintenance.value,record))fail('MAINTENANCE_RECORD_CHANGED');
        }
        const prepared=await artifact(this.audit+'.prepared');
        if(prepared)await phaseChain(this,'prepared');
        const stageAudits=Object.fromEntries(await Promise.all(['start','ready','disarm','restore-prepared','restore-completed'].map(async name=>[name,await artifact(this.audit+'.'+name)])));
        if(Object.values(stageAudits).some(Boolean)&&!r)fail('RECOVERY_AUDIT_REQUIRED');
        if(stageAudits['restore-prepared']||stageAudits['restore-completed'])fail('RECOVERY_RESTORE_STATE_REQUIRES_REVIEW');
        const start=stageAudits.start?.value,ready=stageAudits.ready?.value,disarmPlan=stageAudits.disarm?.value;
        if(ready)await phaseChain(this,'ready');
        else if(start)await phaseChain(this,'start');
        else if(disarm)await phaseChain(this,'disarm.completed');
        else if(disarmPlan)await phaseChain(this,'disarm');
        if(start&&(start.version!==1||start.state!=='START_RESERVED'||start.head!==this.expected.head||typeof start.bootstrap!=='boolean'||!start.before))fail('START_RESERVATION_CHANGED');
        if(ready&&(!ready.ready||ready.head!==this.expected.head||!start))fail('RECOVERY_READY_AUDIT_CONFLICT');
        if(disarmPlan&&(disarmPlan.state!=='PREPARED'||disarmPlan.action!=='EXPLICIT_OFFLINE_DISARM'||disarmPlan.path!==this.p.auto||
            disarmPlan.authorityPath!==this.p.authority||disarmPlan.expectedHash!==r.before.auto.hash||disarmPlan.expectedRevision!==r.before.auto.value.revision))fail('DISARM_AUDIT_CONFLICT');
        if(disarm&&(!disarmPlan||disarm.value.state!=='COMPLETED'||disarm.value.beforeHash!==r.before.auto.hash))fail('DISARM_AUDIT_CONFLICT');
        let reconciliation={auto:null,scheduled:null};
        if(phase==='prepared'||r&&!e.authorityLock&&!e.scheduledLock){
            const auto=await this.autoEvidence(r);
            if(!auto.done)fail('AUTOLIVE_COMPLETION_REQUIRED');
            reconciliation={auto:auto.evidence??null,scheduled:await this.verifyScheduled(r,{evidence:true})};
        }
        const ledger=await this.migration.view();
        const native=ledger.mode==='ABSENT'?null:await this.migration.storage();
        if(ledger.mode==='V1'&&!same(native,ledger.intent.native))fail('LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN');
        h.review={saved,prepared,disarm,stageAudits,classification,scheduled,native,artifacts:ledger.a,intent:ledger.intent??null,reconciliation};
        h.prepare={r,ledgerMode:ledger.mode,audited};return h;
    }
    async migrationAuditBarrier(names){
        for(const name of names)await this.migration.durability.syncFile(name);
    }
    async prepareIntent(h,r,{maintenance=h.evidence.maintenance,audit=h.review.saved}={}){
        await this.hook('before-migration-recheck');
        const fresh=await this.prepareReview({phase:'prepared',reserved:true,ownedGate:true});
        const expected={...h.evidence,maintenance};
        if(!same(fresh.evidence,expected)||!same(fresh.prepare.r,r)||!same(fresh.service,h.service)||!same(fresh.media,h.media)||
            !same(fresh.review.saved,audit)||!same(fresh.review.reconciliation,h.review.reconciliation)||
            !same(fresh.review.intent,h.review.intent)||
            !same(fresh.review.native,h.review.native)||!same(fresh.review.artifacts,h.review.artifacts)||
            !same(fresh.review.prepared,h.review.prepared)||!same(fresh.review.disarm,h.review.disarm)||
            !same(fresh.review.stageAudits,h.review.stageAudits))fail('PREFLIGHT_EVIDENCE_CHANGED');
        const intentHash=h.evidence.migrationIntent?.hash??capturedEvidence(
            Buffer.from(JSON.stringify(seal(h.review.intent))+'\n'),{text:false}).sha256;
        const authorize=async()=>{
            const current=await this.preflight({reserved:true,ownedGate:true}),e=current.evidence;
            if(!same(current.service,h.service)||!same(current.media,h.media)||
                !same({...e,migrationIntent:expected.migrationIntent,migrationIntentStage:expected.migrationIntentStage},expected)||
                !same(await artifact(this.audit),audit))fail('PREFLIGHT_EVIDENCE_CHANGED');
            const phases=Object.fromEntries(await Promise.all(['prepared','disarm.completed',...Object.keys(h.review.stageAudits)]
                .map(async name=>[name,await artifact(this.audit+'.'+name)])));
            if(!same(phases,{prepared:h.review.prepared,'disarm.completed':h.review.disarm,...h.review.stageAudits}))fail('RECOVERY_PHASE_LINEAGE_CHANGED');
            const auto=await this.autoEvidence(r),scheduled=await this.verifyScheduled(r,{evidence:true});
            if(!auto.done||!same({auto:auto.evidence??null,scheduled},h.review.reconciliation))fail('PREFLIGHT_EVIDENCE_CHANGED');
            if((e.migrationIntent||h.evidence.migrationIntent)&&e.migrationIntent?.hash!==intentHash)fail('MIGRATION_INTENT_CHANGED');
        };
        this.migration.reserved=true;
        try{await authorize();await this.migration.prepareHeld({authorize});await authorize();}
        finally{this.migration.reserved=false;}
        return authorize;
    }
    assertStable(e,r,keys=['auto','schedule','program','ledger','ledgerLock','ledgerWal','marker','scheduled']){
        for(const key of keys)if((e[key]?.hash??null)!==(r.before[key]?.hash??null)){
            if(['ledger','ledgerWal'].includes(key)&&r.before.ledger?.value.schemaVersion===1&&e.migrationIntent){
                const intent=e.migrationCompleted?
                    validateMigrationCompletion(this.p.ledger,e.migrationIntent.value,e.migrationActivated?.value,e.migrationCompleted.value):
                    validateMigrationIntent(this.p.ledger,e.migrationIntent.value);
                const base=JSON.stringify(seal({schemaVersion:2,type:'BASE',previous:null,data:{repositoryId:intent.repositoryId,
                    snapshot:intent.target.snapshot,namespaceDurability:'DIRECTORY_SYNCED'}}))+'\n';
                if(intent.original.hash===r.before.ledger.hash&&[intent.original.hash,intent.targetHash].includes(e.ledger?.hash)&&
                    e.ledgerWal?.hash===hash(base))continue;
            }
            fail('RECOVERY_STATE_CHANGED_'+key);
        }
    }
    async begin({authorizeLegacy=false}={}){
        if(!this.runId)fail('RECOVERY_RUN_ID_REQUIRED');
        const result=await this.offline(async h=>{
            const e=await capture(this.p);e.gate=null;
            if(!same(e,h.evidence))fail('PREFLIGHT_EVIDENCE_CHANGED');
            const classification=h.review.classification;
            let r=h.prepare.r,audit=h.review.saved,maintenance=e.maintenance;
            if(!r){
                r={version:1,runId:this.runId,root:this.p.root,branch:h.branch,head:h.head,at:new Date().toISOString(),
                    maintenance:classification,original:h.service,authorizeLegacy,before:{...e,gate:null},media:h.media};
                audit=await exclusive(this.audit,r);
            }
            const original=r.before.maintenance;
            const record=original?.value??{Version:1,Repository:this.p.root,Head:r.head,CapturedAt:r.at,Original:r.original};
            if(!e.maintenance)maintenance=await exclusive(this.p.maintenance,record);
            else if(!same(e.maintenance.value,record))fail('MAINTENANCE_RECORD_CHANGED');
            if(h.prepare.ledgerMode==='V1'&&!e.authorityLock&&!e.scheduledLock){
                await this.migrationAuditBarrier([this.audit,this.p.maintenance]);
                await this.prepareIntent(h,r,{maintenance,audit});
            }
            await this.hook('adopted');
            return {runId:this.runId,maintenance:r.maintenance,scheduled:scheduledClassification(r.before,this.p)};
        },{review:options=>this.prepareReview({phase:'begin',authorizeLegacy,...options})});
        if(await artifact(this.p.migrationIntent))await this.migrationAuditBarrier([this.audit,this.p.maintenance]);
        return {...result,...await this.migration.inspect()};
    }
    async autoEvidence(r){
        const expected=r.before.authorityLock,current=await artifact(this.p.authorityLock);
        if(!expected){if(current)fail('NEW_AUTHORITY_LOCK_APPEARED');return {done:true};}
        const names=await readdir(dirname(this.p.authority));const audits=[];
        const candidates=names.filter(n=>namespaceStarts(n,basename(this.p.authority)+'.reconciliation-')&&namespaceEnds(n,'.json'));
        assertUniqueNames(candidates,{code:'AUTOLIVE_AUDIT_AMBIGUOUS'});
        for(const name of candidates){
            if(!name.startsWith(basename(this.p.authority)+'.reconciliation-')||!name.endsWith('.json'))fail('AUTOLIVE_AUDIT_AMBIGUOUS');
            const path=join(dirname(this.p.authority),name),record=await artifact(path),a=record?.value;
            if(a?.previousOwner?.pid===expected.value.pid&&a.previousOwner.authorityProcessSession===expected.value.authorityProcessSession&&a.epoch===r.before.authority.value.epoch)audits.push({path,a,record});
        }
        if(audits.length>1)fail('AUTOLIVE_AUDIT_AMBIGUOUS');
        if(current){if(current.hash!==expected.hash)fail('AUTOLIVE_LOCK_CHANGED');if(audits.length)fail('AUTOLIVE_PREPARED_REVIEW_REQUIRED');return {done:false};}
        if(audits.length!==1)fail('AUTOLIVE_ARCHIVE_EVIDENCE_REQUIRED');
        const {path,a,record}=audits[0],completed=await artifact(path+'.completed'),completion=completed?.value;
        const archive=typeof a.archive==='string'&&a.archive.startsWith(this.p.authority+'.lock.reconciled-')?await artifact(a.archive):null;
        if(a.state!=='PREPARED'||a.proof?.absent!==true||!same(a.previousOwner,expected.value)||a.path!==this.p.authority||typeof a.archive!=='string'||!a.archive.startsWith(this.p.authority+'.lock.reconciled-')||
            archive?.hash!==expected.hash||completion?.state!=='COMPLETED'||completion.archive!==a.archive||completion.epoch!==a.epoch)
            fail('AUTOLIVE_ARCHIVAL_REVIEW_REQUIRED');
        return {done:true,audit:path,archive:a.archive,evidence:{audit:record,completion:completed,archive}};
    }
    async autoPlan(){
        await this.preflight();const r=await this.load(),e=await capture(this.p);this.assertStable(e,r);
        if(e.authority?.hash!==r.before.authority.hash)fail('AUTHORITY_EPOCH_CHANGED');
        const outcome=await this.autoEvidence(r);if(outcome.done)return {args:[]};
        if(scheduledClassification(r.before,this.p)==='VERIFIABLE')await this.verifyScheduled(r);
        const lock=e.authorityLock.value;
        return {args:[this.p.authority,String(e.authority.value.epoch),String(lock.pid),lock.authorityProcessSession,e.authority.hash,e.authorityLock.hash]};
    }
    async verifyScheduled(r,{evidence=false}={}){
        if(!r.before.scheduledLock){if(await artifact(this.p.scheduledLock))fail('NEW_SCHEDULED_LOCK_APPEARED');return evidence?null:true;}
        const audit=this.p.scheduled+'.reconciliation-'+this.runId+'.json',a=await artifact(audit),completed=await artifact(audit+'.completed'),c=completed?.value;
        const archive=await artifact(this.p.scheduled+'.lock.quarantine-'+this.runId);
        const classification=scheduledClassification(r.before,this.p),contract=a?.value.contract;
        const expected={lockHash:r.before.scheduledLock.hash,repositoryId:repositoryIdentity(this.p.scheduled),processSession:r.before.scheduledLock.value.processSession,
            journalHash:r.before.scheduled?.hash??null,authorityHash:r.before.authority.hash,authorityLockHash:classification==='LEGACY_UNVERIFIABLE'?null:r.before.authorityLock?.hash??null};
        if(!a||c?.state!=='COMPLETED'||c.auditHash!==a.hash||c.lockHash!==r.before.scheduledLock.hash||
            contract?.state!=='PREPARED'||contract.path!==this.p.scheduled||contract.authorityPath!==this.p.authority||
            contract.operationId!==this.runId||contract.reason!==classification||c.reason!==classification||
            !same(contract.originalLock,r.before.scheduledLock.value)||!same(contract.expected,expected)||a.value.proof?.absent!==true||
            c.archive!==this.p.scheduled+'.lock.quarantine-'+this.runId||
            archive?.hash!==r.before.scheduledLock.hash||await artifact(this.p.scheduledLock))fail('SCHEDULED_COMPLETION_REQUIRED');
        return evidence?{audit:a,completion:completed,archive}:true;
    }
    async scheduled(){
        await this.preflight();const r=await this.load();if(!r.before.scheduledLock)return this.verifyScheduled(r);
        if(await artifact(this.p.scheduled+'.reconciliation-'+this.runId+'.json.completed'))return this.verifyScheduled(r);
        const e=await capture(this.p);this.assertStable(e,r);
        const legacy=scheduledClassification(r.before,this.p)==='LEGACY_UNVERIFIABLE';
        if(legacy)await this.autoEvidence(r).then(result=>{if(!result.done)fail('AUTOLIVE_MUST_BE_HANDLED_FIRST');});
        return reconcileScheduledExecutionLock({path:this.p.scheduled,authorityPath:this.p.authority,operationId:this.runId,
            authorizeLegacyQuarantine:legacy&&r.authorizeLegacy,expected:{lockHash:r.before.scheduledLock.hash,
                repositoryId:repositoryIdentity(this.p.scheduled),processSession:r.before.scheduledLock.value.processSession,
                journalHash:r.before.scheduled?.hash??null,authorityHash:r.before.authority.hash,
                authorityLockHash:legacy?null:r.before.authorityLock?.hash??null},
            proveOffline:this.host.proveOffline,reserve:this.host.reserve,...(this.host.fixtureAlive?{isAlive:this.host.fixtureAlive}:{}),
            hook:stage=>this.hook('scheduled-'+stage)});
    }
    async prepared(){
        const result=await this.offline(async h=>{
            const e=await capture(this.p);e.gate=null;
            if(!same(e,h.evidence))fail('PREFLIGHT_EVIDENCE_CHANGED');
            const {audited}=h.prepare;let authorize;
            if(h.prepare.ledgerMode==='V1'){
                await this.migrationAuditBarrier([this.audit]);authorize=await this.prepareIntent(h,h.prepare.r);
            }
            const context=await lineageContext(this);if(authorize)await authorize();
            await writeOnce(this.audit+'.prepared',phaseRecord(context,'prepared',null,{state:'PREPARED_FOR_EXPLICIT_DISARM',head:this.expected.head}));
            return {prepared:true,autoliveDisarmStillRequired:!audited};
        },{review:options=>this.prepareReview({phase:'prepared',...options})});
        if(await artifact(this.p.migrationIntent))await this.migrationAuditBarrier([this.audit,this.audit+'.prepared']);
        return {...result,...await this.migration.inspect()};
    }
    async disarm({authorize=false,expectedRevision,expectedHash}={}){
        await this.preflight();const r=await this.load(),chain=await phaseChain(this,'prepared');
        if(await artifact(this.audit+'.disarm.completed'))await phaseChain(this,'disarm.completed');
        else if(await artifact(this.audit+'.disarm'))await phaseChain(this,'disarm');
        const priorCompletion=await artifact(this.audit+'.disarm.completed');
        if(expectedHash!==r.before.auto.hash||expectedRevision!==r.before.auto.value.revision)fail('STALE_AUTOLIVE_EVIDENCE');
        const e=await capture(this.p);this.assertStable(e,r,['authority','schedule','program','ledger','ledgerLock','ledgerWal','marker','scheduled']);
        if(e.authorityLock||e.scheduledLock)fail('LOCK_RECONCILIATION_REQUIRED');
        const recheck=async()=>{
            const fresh=await phaseChain(this,'prepared'),current=await capture(this.p);
            if(!same(fresh,chain))fail('RECOVERY_PHASE_LINEAGE_CHANGED');
            if(!same(await artifact(this.audit+'.disarm.completed'),priorCompletion))fail('RECOVERY_PHASE_LINEAGE_CHANGED');
            if(!same(current.maintenance,e.maintenance))fail('MAINTENANCE_RECORD_CHANGED');
            this.assertStable(current,r,['authority','schedule','program','ledger','ledgerLock','ledgerWal','marker','scheduled']);
            if(current.authorityLock||current.scheduledLock)fail('LOCK_RECONCILIATION_REQUIRED');
        };
        const lineage={recheck,record:(phase,value)=>phaseRecord(chain.context,phase,chain.predecessor,value),
            validate:async()=>phaseChain(this,'disarm'),completion:async value=>{
                const plan=await phaseChain(this,'disarm');return phaseRecord(chain.context,'disarm.completed',plan.predecessor,value);
            }};
        return offlineDisarm({path:this.p.auto,authorityPath:this.p.authority,audit:this.audit+'.disarm',
            expectedHash,expectedRevision,authorize,lineage,proveOffline:this.host.proveOffline,reserve:this.host.reserve,hook:stage=>this.hook('disarm-'+stage)});
    }
    async startReview({authorizeBootstrap=false,...options}={}){
        const h=await this.preflight(options),review=await this.load(),current=h.evidence,disarmed=(await artifact(this.audit+'.disarm.completed'))?.value;
        if(current.ledgerLock?.value.version===1)fail('LEGACY_LEDGER_LOCK_UNVERIFIABLE');
        const chain=await phaseChain(this,'disarm.completed');
        if(await artifact(this.audit+'.start'))await phaseChain(this,'start');
        if(await artifact(this.audit+'.ready')){await phaseChain(this,'ready');fail('RECOVERY_READY_ALREADY_EXISTS');}
        if(await artifact(this.audit+'.restore-prepared')||await artifact(this.audit+'.restore-completed'))fail('RECOVERY_RESTORE_STATE_REQUIRES_REVIEW');
        if(!disarmed||current.auto?.hash!==disarmed.afterHash||current.auto.value.armed!==false)fail('AUDITED_DISARM_REQUIRED');
        this.assertStable(current,review,['authority','schedule','program','marker','scheduled']);
        if(current.mediaDelete)fail('MEDIA_DELETE_JOURNAL_REVIEW_REQUIRED');
        if(current.authorityLock||current.scheduledLock)fail('LOCK_RECONCILIATION_REQUIRED');
        if(classifyMaintenance(current.maintenance?.value,h.service,this.p.root)!=='ADOPTED_MAINTENANCE')fail('MAINTENANCE_CONFLICT');
        const migrating=!!(current.ledger?.value.schemaVersion===1||current.migrationIntent||current.migrationIntentStage);
        if(migrating&&authorizeBootstrap)fail('LEDGER_MIGRATION_BOOTSTRAP_FORBIDDEN');
        this.assertStable(current,review,['ledger','ledgerLock','ledgerWal']);
        bootstrapPlan(current,authorizeBootstrap);
        const ledger=await this.migration.view();
        const native=ledger.mode==='ABSENT'?null:await this.migration.storage();
        if(ledger.mode==='V1'&&!same(native,ledger.intent.native))fail('LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN');
        h.review={chain,review,disarmed,ledger,native,start:await artifact(this.audit+'.start')};
        if(h.review.start)this.validateStartReservation(h,authorizeBootstrap);
        h.start={migrating};return h;
    }
    validateStartReservation(h,authorizeBootstrap){
        const saved=h.review.start.value,e=h.evidence;
        // phaseChain already proves audit identity and every predecessor byte
        // digest. Current evidence also includes the entire ledger/WAL, marker,
        // migration records, authority, AutoLive, Schedule and retained PROGRAM.
        const bootstrap=bootstrapPlan(e,authorizeBootstrap),transactionId=e.migrationCompleted?.value.transactionId;
        if(saved.version!==1||saved.state!=='START_RESERVED'||saved.head!==this.expected.head||saved.bootstrap!==bootstrap||
            !Number.isSafeInteger(saved.pid)||saved.pid<1||!Number.isFinite(Date.parse(saved.at))||
            !same(saved.before,{...e,gate:null})||saved.migrationTransactionId!==transactionId||
            (transactionId&&saved.ledgerProtocolVersion!==2)||
            (saved.ledgerProtocolVersion!==undefined&&saved.ledgerProtocolVersion!==(e.ledger?.value.schemaVersion===2?2:1)))fail('START_RESERVATION_CHANGED');
        if(h.review.ledger.mode==='V1')fail('START_RESERVATION_MIGRATION_UNRESOLVED');
        if(h.review.ledger.intent&&!same(h.review.native,h.review.ledger.intent.native))fail('LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN');
        return saved;
    }
    async reserveStart({authorizeStart=false,authorizeBootstrap=false}={}){
        if(!authorizeStart)fail('EXPLICIT_START_AUTHORIZATION_REQUIRED');
        return this.offline(async h=>{
            const {chain,review,disarmed}=h.review;
            const intentHash=h.start.migrating?(h.evidence.migrationIntent?.hash??
                capturedEvidence(Buffer.from(JSON.stringify(seal(h.review.ledger.intent))+'\n'),{text:false}).sha256):null;
            // Bind non-migrating evidence to this attempt's byte capture. Ledger
            // and migration artifacts have their own evolving migration guard.
            const assertStartEvidence=e=>{
                if(e.maintenance?.hash!==h.evidence.maintenance?.hash)fail('MAINTENANCE_RECORD_CHANGED');
                // A new intent has known writer bytes; an adopted intent retains
                // its captured identity. Neither may be silently reformatted.
                if(intentHash&&(e.migrationIntent?.hash??null)!==intentHash&&
                    (e.migrationIntent||h.evidence.migrationIntent))fail('MIGRATION_INTENT_CHANGED');
                for(const key of ['authorityLock','scheduledLock','mediaManifest','mediaDelete'])
                    if((e[key]?.hash??null)!==(h.evidence[key]?.hash??null))fail('PREFLIGHT_EVIDENCE_CHANGED');
            };
            if(h.review.start){
                // Recheck under both host reservation and maintenance ownership.
                // Never run migration or rewrite the durable phase on a retry.
                const fresh=await this.startReview({authorizeBootstrap,reserved:true,ownedGate:true});
                if(!same(fresh.review,h.review)||!same(fresh.evidence,h.evidence)||!same(fresh.service,h.service)||!same(fresh.media,h.media))fail('PREFLIGHT_EVIDENCE_CHANGED');
                if(fresh.review.ledger.mode==='V2')await this.migrationAuditBarrier([this.audit+'.start']);
                return this.validateStartReservation(fresh,authorizeBootstrap);
            }
            if(h.start.migrating){
                await this.migrationAuditBarrier([this.audit,this.audit+'.prepared',this.audit+'.disarm',this.audit+'.disarm.completed']);
                this.migration.reserved=true;
                try{
                    const outcome=await this.migration.startHeld({authorize:async()=>{
                        const fresh=await this.preflight({reserved:true,ownedGate:true});
                        if(!same(fresh.service,h.service)||!same(fresh.media,h.media))fail('PREFLIGHT_EVIDENCE_CHANGED');
                        if(!same(await phaseChain(this,'disarm.completed'),chain))fail('RECOVERY_PHASE_LINEAGE_CHANGED');
                        const e=await capture(this.p);
                        assertStartEvidence(e);
                        if(e.auto?.hash!==disarmed.afterHash||e.auto.value.armed!==false)fail('AUDITED_DISARM_REQUIRED');
                        this.assertStable(e,review,['authority','schedule','program','marker','scheduled']);
                    }});if(outcome.blockingReason)fail(outcome.blockingReason);
                }finally{this.migration.reserved=false;}
            }
            if(!same(await phaseChain(this,'disarm.completed'),chain))fail('RECOVERY_PHASE_LINEAGE_CHANGED');
            const r=await this.load(),e=await capture(this.p),disarm=(await artifact(this.audit+'.disarm.completed'))?.value;
            assertStartEvidence(e);
            if(e.mediaDelete)fail('MEDIA_DELETE_JOURNAL_REVIEW_REQUIRED');
            if(!disarm||e.auto?.hash!==disarm.afterHash||e.auto.value.armed!==false)fail('AUDITED_DISARM_REQUIRED');
            this.assertStable(e,r,['authority','schedule','program','ledger','ledgerLock','ledgerWal','marker','scheduled']);
            if(e.authorityLock||e.scheduledLock)fail('LOCK_RECONCILIATION_REQUIRED');
            if(classifyMaintenance(e.maintenance?.value,h.service,this.p.root)!=='ADOPTED_MAINTENANCE')fail('MAINTENANCE_CONFLICT');
            const bootstrap=bootstrapPlan(e,authorizeBootstrap);
            const start=phaseRecord(chain.context,'start',chain.predecessor,{version:1,state:'START_RESERVED',pid:process.pid,at:new Date().toISOString(),head:this.expected.head,bootstrap,before:{...e,gate:null}});
            if(e.ledger?.value.schemaVersion===2)start.ledgerProtocolVersion=2;
            if(e.migrationCompleted){
                start.ledgerProtocolVersion=2;start.migrationTransactionId=e.migrationCompleted.value.transactionId;
            }
            // Exclusive creation remains fail-closed for a concurrent new writer.
            await exclusive(this.audit+'.start',start);
            if(e.ledger?.value.schemaVersion===2)await this.migrationAuditBarrier([this.audit+'.start']);
            await this.hook('start-reserved');return start;
        },{review:options=>this.startReview({authorizeBootstrap,...options})});
    }
    async restoreReview(options={}){
        const completion=await artifact(this.audit+'.restore-completed');
        const restored=completion?.value;
        if(restored&&(restored.state!=='COMPLETED'||restored.head!==this.expected.head||restored.runId!==this.runId||restored.root!==this.p.root))fail('RESTORE_COMPLETION_IDENTITY_MISMATCH');
        const h=await this.preflight({...options,restored}),e=h.evidence,r=await this.load();
        const original=assertRestore(e,{record:e.maintenance?.value,service:restored?{...h.service,StartMode:'Disabled'}:h.service,root:this.p.root,bootstrapPermission:h.bootstrapPermission});
        if(!same(e.maintenance.value,r.before.maintenance?.value??{Version:1,Repository:r.root,Head:r.head,CapturedAt:r.at,Original:r.original}))fail('MAINTENANCE_RECORD_CHANGED');
        if(e.mediaDelete)fail('MEDIA_DELETE_JOURNAL_REVIEW_REQUIRED');
        const ready=await artifact(this.audit+'.ready'),start=await artifact(this.audit+'.start');
        // A completed controlled runtime must have hydrated LIVE identities.
        // Before startup, restoring configuration still permits legacy input.
        controlledSchedule(e.schedule?.value,{ready:Boolean(ready)});
        const chain=await phaseChain(this,ready?'ready':start?'start':'disarm.completed',{optional:!ready&&!start});
        const restorePlan=await artifact(this.audit+'.restore-prepared');
        if(restorePlan){validatePhase(restorePlan,chain.context,'restore-prepared',chain.predecessor);if(restorePlan.value.state!=='PREPARED'||!same(restorePlan.value.original,original))fail('RESTORE_COMPLETION_IDENTITY_MISMATCH');}
        if(restored){if(!restorePlan)fail('RECOVERY_PHASE_REQUIRED');validatePhase(completion,chain.context,'restore-completed',restorePlan);}
        const ledger=await verifyRestoreAuthority(this,{audit:r,ready:ready?.value,start:start?.value,evidence:e});
        if(restored&&(!same(restored.original,original)||restored.started!==false))fail('RESTORE_COMPLETION_IDENTITY_MISMATCH');
        h.review={audit:await artifact(this.audit),ready,start,completion,restorePlan,chain,ledger};h.restore={original,ledger,restored};return h;
    }
    async restore(){
        if(await artifact(this.audit+'.restore-completed')){
            const first=await this.restoreReview(),fresh=await this.restoreReview();
            if(!same(first.evidence,fresh.evidence)||!same(first.review,fresh.review)||!same(first.service,fresh.service))fail('RESTORE_EVIDENCE_CHANGED');
            return {restored:true,started:false};
        }
        return this.offline(async h=>{
            const {original,ledger}=h.restore;
            const chain=await phaseChain(this,h.review.ready?'ready':h.review.start?'start':'disarm.completed',{optional:!h.review.ready&&!h.review.start});
            await writeOnce(this.audit+'.restore-prepared',phaseRecord(chain.context,'restore-prepared',chain.predecessor,{state:'PREPARED',original}));
            h.review.restorePlan=await artifact(this.audit+'.restore-prepared');
            if(ledger.mode==='V2')await this.migrationAuditBarrier([this.audit+'.restore-prepared']);
            await this.hook('before-service-restore');
            const fresh=await this.restoreReview({reserved:true,ownedGate:true});
            if(!same(fresh.evidence,h.evidence)||!same(fresh.review,h.review)||!same(fresh.service,h.service)||!same(fresh.media,h.media))fail('RESTORE_EVIDENCE_CHANGED');
            await this.host.restore(original);
            const after=await this.host.inspect();
            if(after.service.State!=='Stopped'||after.service.StartMode!==original.StartMode||after.service.DelayedPresent!==original.DelayedPresent||after.service.DelayedValue!==original.DelayedValue||!same(h.media,after.media))fail('RESTORE_VERIFICATION_FAILED');
            await writeOnce(this.audit+'.restore-completed',phaseRecord(chain.context,'restore-completed',await artifact(this.audit+'.restore-prepared'),{state:'COMPLETED',head:this.expected.head,runId:this.runId,root:this.p.root,original,service:after.service,started:false}));
            if(ledger.mode==='V2')await this.migrationAuditBarrier([this.audit+'.restore-completed']);
            return {restored:true,started:false};
        },{review:options=>this.restoreReview(options)});
    }
}
