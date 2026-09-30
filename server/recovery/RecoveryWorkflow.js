import {readdir,realpath} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {acquireMaintenanceGate} from '../autolive/AuthorityMaintenanceGate.js';
import {reconcileScheduledExecutionLock} from '../scheduler/ReconcileScheduledExecutionLock.js';
import {repositoryIdentity} from '../scheduler/ScheduledExecutionProvenance.js';
import {normalizeConfig} from '../autolive/AutoLiveContract.js';
import {normalizeSchedule} from '../scheduler/ScheduleContract.js';
import {validateRecord} from '../program-output/DurableProgramContract.js';
import {offlineDisarm} from './OfflineDisarm.js';
import {paths,capture,artifact,exclusive,writeOnce,classifyMaintenance,scheduledClassification,bootstrapPlan,assertRestore,HEAD,BRANCH,fail,same} from './RecoveryContract.js';
import {assertHost} from './WindowsRecoveryHost.js';

export class RecoveryWorkflow {
    constructor({root,runId,host,hook=()=>{}}){
        this.p=paths(root);this.host=host;this.hook=hook;
        if(runId!==undefined&&!/^[a-zA-Z0-9_-]{1,80}$/.test(runId))fail('INVALID_RECOVERY_RUN_ID');
        this.runId=runId;this.audit=join(this.p.root,'var','recovery-'+(runId||'UNSPECIFIED')+'.json');
    }
    async inspect(){
        const [host,evidence]=await Promise.all([this.host.inspect(),capture(this.p)]);
        return {host,evidence,maintenance:classifyMaintenance(evidence.maintenance?.value,host.service,this.p.root),
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
    async preflight(){
        const h=await this.host.inspect();assertHost(h,this.p.root);
        if((await this.host.proveOffline()).absent!==true)fail('CANONICAL_OFFLINE_PROOF_REQUIRED');
        for(const path of [this.p.root,dirname(this.p.authority),dirname(this.p.schedule),dirname(this.audit)])
            if(repositoryIdentity(await realpath(path))!==repositoryIdentity(path))fail('ALIASED_RECOVERY_DIRECTORY');
        try{if(repositoryIdentity(await realpath(this.p.mediaRoot))!==repositoryIdentity(this.p.mediaRoot))fail('ALIASED_RECOVERY_DIRECTORY');}
        catch(error){if(error.code!=='ENOENT')throw error;}
        const e=await capture(this.p);
        if(classifyMaintenance(e.maintenance?.value,h.service,this.p.root)==='CONFLICT')fail('MAINTENANCE_CONFLICT');
        if(e.gate)fail('MAINTENANCE_GATE_REVIEW_REQUIRED');
        h.evidence=e;
        return h;
    }
    async offline(fn){
        const h=await this.preflight(),release=await this.host.reserve();let gate;
        try{if((await this.host.proveOffline()).absent!==true)fail('CANONICAL_OFFLINE_PROOF_REQUIRED');
            const fresh=await capture(this.p);if(!same(fresh,h.evidence))fail('PREFLIGHT_EVIDENCE_CHANGED');
            gate=await acquireMaintenanceGate(this.p.authority);return await fn(h);
        }finally{if(gate)await gate();await release();}
    }
    async load(){
        if(!this.runId)fail('RECOVERY_RUN_ID_REQUIRED');
        const r=(await artifact(this.audit))?.value;
        if(!r||r.version!==1||r.root!==this.p.root||r.head!==HEAD||r.branch!==BRANCH||r.runId!==this.runId)fail('RECOVERY_AUDIT_REQUIRED');
        return r;
    }
    assertStable(e,r,keys=['auto','schedule','program','ledger','ledgerLock','marker','scheduled']){
        for(const key of keys)if((e[key]?.hash??null)!==(r.before[key]?.hash??null))fail('RECOVERY_STATE_CHANGED_'+key);
    }
    async begin({authorizeLegacy=false}={}){
        if(!this.runId)fail('RECOVERY_RUN_ID_REQUIRED');
        return this.offline(async h=>{
            const e=await capture(this.p);const classification=classifyMaintenance(e.maintenance?.value,h.service,this.p.root);
            if(classification==='CONFLICT')fail('MAINTENANCE_CONFLICT');
            const scheduled=scheduledClassification(e,this.p);
            if(scheduled==='LEGACY_JOURNAL_REVIEW_REQUIRED')fail(scheduled);
            if(!['ABSENT','VERIFIABLE','LEGACY_UNVERIFIABLE'].includes(scheduled))fail(scheduled);
            if(scheduled==='LEGACY_UNVERIFIABLE'&&!authorizeLegacy)fail('EXPLICIT_LEGACY_AUTHORIZATION_REQUIRED');
            normalizeConfig(e.auto?.value);normalizeSchedule(e.schedule?.value);validateRecord(e.program?.value);
            if(!Number.isSafeInteger(e.authority?.value.epoch)||e.authority.value.epoch<1)fail('AUTHORITY_EPOCH_REQUIRED');
            // This workflow is for controlled first bootstrap / retained ledger,
            // never ambiguous marker-only state or an execution journal replay.
            bootstrapPlan(e,true);
            let r=(await artifact(this.audit))?.value;
            if(r){r=await this.load();if(r.authorizeLegacy!==authorizeLegacy)fail('RECOVERY_AUTHORIZATION_CHANGED');}
            else{
                r={version:1,runId:this.runId,root:this.p.root,branch:h.branch,head:h.head,at:new Date().toISOString(),
                    maintenance:classification,original:h.service,authorizeLegacy,before:{...e,gate:null},media:h.media};
                await exclusive(this.audit,r);
            }
            const original=r.before.maintenance;
            const record=original?.value??{Version:1,Repository:this.p.root,Head:r.head,CapturedAt:r.at,Original:r.original};
            if(!e.maintenance)await exclusive(this.p.maintenance,record);
            else if(!same(e.maintenance.value,record))fail('MAINTENANCE_RECORD_CHANGED');
            await this.hook('adopted');
            return {runId:this.runId,maintenance:r.maintenance,scheduled:scheduledClassification(r.before,this.p)};
        });
    }
    async autoEvidence(r){
        const expected=r.before.authorityLock,current=await artifact(this.p.authorityLock);
        if(!expected){if(current)fail('NEW_AUTHORITY_LOCK_APPEARED');return {done:true};}
        const names=await readdir(dirname(this.p.authority));const audits=[];
        for(const name of names.filter(n=>n.startsWith(basename(this.p.authority)+'.reconciliation-')&&n.endsWith('.json'))){
            const path=join(dirname(this.p.authority),name),a=(await artifact(path))?.value;
            if(a?.previousOwner?.pid===expected.value.pid&&a.previousOwner.authorityProcessSession===expected.value.authorityProcessSession&&a.epoch===r.before.authority.value.epoch)audits.push({path,a});
        }
        if(audits.length>1)fail('AUTOLIVE_AUDIT_AMBIGUOUS');
        if(current){if(current.hash!==expected.hash)fail('AUTOLIVE_LOCK_CHANGED');if(audits.length)fail('AUTOLIVE_PREPARED_REVIEW_REQUIRED');return {done:false};}
        if(audits.length!==1)fail('AUTOLIVE_ARCHIVE_EVIDENCE_REQUIRED');
        const {path,a}=audits[0],completion=(await artifact(path+'.completed'))?.value;
        if(a.state!=='PREPARED'||a.proof?.absent!==true||!same(a.previousOwner,expected.value)||a.path!==this.p.authority||typeof a.archive!=='string'||!a.archive.startsWith(this.p.authority+'.lock.reconciled-')||
            (await artifact(a.archive))?.hash!==expected.hash||completion?.state!=='COMPLETED'||completion.archive!==a.archive||completion.epoch!==a.epoch)
            fail('AUTOLIVE_ARCHIVAL_REVIEW_REQUIRED');
        return {done:true,audit:path,archive:a.archive};
    }
    async autoPlan(){
        await this.preflight();const r=await this.load(),e=await capture(this.p);this.assertStable(e,r);
        if(e.authority?.hash!==r.before.authority.hash)fail('AUTHORITY_EPOCH_CHANGED');
        const outcome=await this.autoEvidence(r);if(outcome.done)return {args:[]};
        if(scheduledClassification(r.before,this.p)==='VERIFIABLE')await this.verifyScheduled(r);
        const lock=e.authorityLock.value;
        return {args:[this.p.authority,String(e.authority.value.epoch),String(lock.pid),lock.authorityProcessSession,e.authority.hash,e.authorityLock.hash]};
    }
    async verifyScheduled(r){
        if(!r.before.scheduledLock){if(await artifact(this.p.scheduledLock))fail('NEW_SCHEDULED_LOCK_APPEARED');return true;}
        const audit=this.p.scheduled+'.reconciliation-'+this.runId+'.json',a=await artifact(audit),c=(await artifact(audit+'.completed'))?.value;
        const classification=scheduledClassification(r.before,this.p),contract=a?.value.contract;
        const expected={lockHash:r.before.scheduledLock.hash,repositoryId:repositoryIdentity(this.p.scheduled),processSession:r.before.scheduledLock.value.processSession,
            journalHash:r.before.scheduled?.hash??null,authorityHash:r.before.authority.hash,authorityLockHash:classification==='LEGACY_UNVERIFIABLE'?null:r.before.authorityLock?.hash??null};
        if(!a||c?.state!=='COMPLETED'||c.auditHash!==a.hash||c.lockHash!==r.before.scheduledLock.hash||
            contract?.state!=='PREPARED'||contract.path!==this.p.scheduled||contract.authorityPath!==this.p.authority||
            contract.operationId!==this.runId||contract.reason!==classification||c.reason!==classification||
            !same(contract.originalLock,r.before.scheduledLock.value)||!same(contract.expected,expected)||a.value.proof?.absent!==true||
            c.archive!==this.p.scheduled+'.lock.quarantine-'+this.runId||
            (await artifact(c.archive))?.hash!==r.before.scheduledLock.hash||await artifact(this.p.scheduledLock))fail('SCHEDULED_COMPLETION_REQUIRED');
        return true;
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
        return this.offline(async()=>{
            const r=await this.load(),e=await capture(this.p);this.assertStable(e,r);
            if(e.authority?.hash!==r.before.authority.hash)fail('AUTHORITY_EPOCH_CHANGED');
            if(!(await this.autoEvidence(r)).done)fail('AUTOLIVE_COMPLETION_REQUIRED');await this.verifyScheduled(r);
            await writeOnce(this.audit+'.prepared',{state:'PREPARED_FOR_EXPLICIT_DISARM',head:HEAD});
            return {prepared:true,autoliveDisarmStillRequired:true};
        });
    }
    async disarm({authorize=false,expectedRevision,expectedHash}={}){
        await this.preflight();const r=await this.load();if(!await artifact(this.audit+'.prepared'))fail('RECOVERY_PREPARATION_REQUIRED');
        if(expectedHash!==r.before.auto.hash||expectedRevision!==r.before.auto.value.revision)fail('STALE_AUTOLIVE_EVIDENCE');
        const e=await capture(this.p);this.assertStable(e,r,['authority','schedule','program','ledger','ledgerLock','marker','scheduled']);
        if(e.authorityLock||e.scheduledLock)fail('LOCK_RECONCILIATION_REQUIRED');
        return offlineDisarm({path:this.p.auto,authorityPath:this.p.authority,audit:this.audit+'.disarm',
            expectedHash,expectedRevision,authorize,proveOffline:this.host.proveOffline,reserve:this.host.reserve,hook:stage=>this.hook('disarm-'+stage)});
    }
    async reserveStart({authorizeStart=false,authorizeBootstrap=false}={}){
        if(!authorizeStart)fail('EXPLICIT_START_AUTHORIZATION_REQUIRED');
        return this.offline(async h=>{
            const r=await this.load(),e=await capture(this.p),disarm=(await artifact(this.audit+'.disarm.completed'))?.value;
            if(e.mediaDelete)fail('MEDIA_DELETE_JOURNAL_REVIEW_REQUIRED');
            if(!disarm||e.auto?.hash!==disarm.afterHash||e.auto.value.armed!==false)fail('AUDITED_DISARM_REQUIRED');
            this.assertStable(e,r,['authority','schedule','program','ledger','ledgerLock','marker','scheduled']);
            if(e.authorityLock||e.scheduledLock)fail('LOCK_RECONCILIATION_REQUIRED');
            if(classifyMaintenance(e.maintenance?.value,h.service,this.p.root)!=='ADOPTED_MAINTENANCE')fail('MAINTENANCE_CONFLICT');
            const bootstrap=bootstrapPlan(e,authorizeBootstrap);
            const start={version:1,state:'START_RESERVED',pid:process.pid,at:new Date().toISOString(),head:HEAD,bootstrap,before:{...e,gate:null}};
            // Never reuse a start reservation after crash, even if no migration ran.
            await exclusive(this.audit+'.start',start);await this.hook('start-reserved');return start;
        });
    }
    async restore(){
        return this.offline(async h=>{
            const e=await capture(this.p);e.gate=null; // this operation owns the verified gate
            const original=assertRestore(e,{record:e.maintenance?.value,service:h.service,root:this.p.root,bootstrapPermission:h.bootstrapPermission});
            const r=await this.load();if(!same(e.maintenance.value,r.before.maintenance?.value??{Version:1,Repository:r.root,Head:r.head,CapturedAt:r.at,Original:r.original}))fail('MAINTENANCE_RECORD_CHANGED');
            await writeOnce(this.audit+'.restore-prepared',{state:'PREPARED',original});
            await this.host.restore(original);
            const after=await this.host.inspect();
            if(after.service.State!=='Stopped'||after.service.StartMode!==original.StartMode||after.service.DelayedPresent!==original.DelayedPresent||after.service.DelayedValue!==original.DelayedValue||!same(h.media,after.media))fail('RESTORE_VERIFICATION_FAILED');
            await writeOnce(this.audit+'.restore-completed',{state:'COMPLETED',service:after.service,started:false});return {restored:true,started:false};
        });
    }
}
