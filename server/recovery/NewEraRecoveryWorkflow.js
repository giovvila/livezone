import {open,readdir} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {readEvidence} from './PersistentEvidence.js';
import {artifact,same} from './RecoveryContract.js';
import {lineageContext,phaseRecord,validatePhase} from './RecoveryLineage.js';
import {executionEraStartup,ERA_PHASES,eraRecordBytes,unsealEra,publishEraReady,assertEraAuthority,validateEraReadyLedger,uuid} from './ExecutionEraContract.js';
import {hash,seal,fail,inspectV2} from '../scheduler/ScheduledEntryLedgerV2Protocol.js';
import {randomUUID} from 'node:crypto';
import {validateNewEraProgram} from './NewEraProgramValidation.js';
import {acquireMaintenanceGate} from '../autolive/AuthorityMaintenanceGate.js';
import {assertHost} from './WindowsRecoveryHost.js';
import {ledgerRecoveryEvidence,reconcileScheduledEntryLedgerV2} from '../scheduler/ReconcileScheduledEntryLedgerV2.js';
import {reconcileScheduledExecutionLock} from '../scheduler/ReconcileScheduledExecutionLock.js';
import {repositoryIdentity,validateLock,journalMatchesLock} from '../scheduler/ScheduledExecutionProvenance.js';
import {directorySync} from '../scheduler/LedgerV2Durability.js';
import {windowsLedgerDurability} from '../scheduler/WindowsLedgerDurability.js';
import {ledgerAuthority} from './RestoreLedgerAuthority.js';
import {verifiedCapabilityStorage} from './VerifiedCapabilityStorage.js';

const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const capture=path=>readEvidence(path,{optional:true,json:true});
const stableId=(a,role)=>{const h=hash({transitionId:a.transitionId,executionEraId:a.executionEraId,...(a.operationId?{operationId:a.operationId}:{}),role});return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};

// Explicit NEW ERA adapter for the committed recovery/ControlledStart contracts.
// The original eight offline files stay authoritative. Their exact bytes are
// bridged into the committed lineage context; they are never silently rewritten.
export class NewEraRecoveryWorkflow {
    constructor({writer,authorization,startAuthorization,hook=()=>{},isAlive=alive,verifyCapabilityStorage=verifiedCapabilityStorage}){
        this.verifyCapabilityStorage=verifyCapabilityStorage;
        this.writer=writer;this.authorization=structuredClone(authorization);
        this.startAuthorization=structuredClone(startAuthorization??authorization);
        if(startAuthorization&&(!uuid(startAuthorization.operationId)||startAuthorization.operationId===startAuthorization.predecessorStartAuthorization?.operationId||
            ['transitionId','executionEraId','ledgerId','repository','approvedHead','approvedBranch','retirementHash'].some(key=>startAuthorization[key]!==authorization[key])))
            fail('NEW_ERA_RESTART_AUTHORIZATION_CONTEXT');
        this.expected=writer.expected??{head:authorization.approvedHead,branch:authorization.approvedBranch};this.host=writer.host;this.durability=writer.durability;
        this.syncDirectory=writer.native===windowsLedgerDurability?directorySync:this.durability.sync;
        this.hook=hook;this.isAlive=isAlive;this.newEra=true;
        this.runId=authorization.transitionId;this.audit=join(writer.directory,'authorized.json');
        this.directory=writer.directory+'-recovery';
        if(startAuthorization)this.directory+='-restart-'+startAuthorization.operationId;
        const p=writer.paths;
        this.p={...p,root:writer.root,auto:p.autoLive,scheduled:p.scheduledJournal,
            gate:p.authorityGate,ledgerWal:p.ledger+'.wal',marker:p.bootstrap,mediaRoot:dirname(p.mediaManifest)};
    }
    async load(){
        const record=(await capture(this.audit))?.value,body=unsealEra(record);
        if(body.phase!=='authorized'||!same(body.authorization,this.authorization)||
            body.authorization.repository!==this.p.root||body.authorization.approvedHead!==this.expected.head)
            fail('NEW_ERA_RECOVERY_AUTHORIZATION_CHANGED');
        return record;
    }
    assertOfflineHost(h,{reserved=false}={}){
        let checked=h;
        if(reserved){
            if(!Array.isArray(h.ports)||h.ports.some(p=>p.LocalPort!==8080||p.OwningProcess!==process.pid))fail('MIGRATION_RESERVATION_PORT_CONFLICT');
            checked={...h,ports:[]};
        }
        assertHost(checked,this.p.root,{expected:this.expected});
    }
    async bridge(inspection={}){
        const era=executionEraStartup(this.p.ledger);
        if(!same(era.transitionId,this.runId)||!same(era.executionEraId,this.authorization.executionEraId)||
            era.ledgerId!==this.authorization.ledgerId)fail('NEW_ERA_RECOVERY_CONTEXT_CHANGED');
        const context=await lineageContext(this),sources=[];
        let predecessor=await artifact(this.audit);
        for(const phase of ERA_PHASES.slice(1)){
            const source=await artifact(join(era.directory,phase+'.json'));
            // Startup already validates canonical seals and the original chain.
            // Bind its actual byte hashes, rather than reconstructing JSON hashes.
            const value=phaseRecord(context,phase,predecessor,{sourceHash:source.hash});
            validatePhase({value,hash:source.hash},context,phase,predecessor);
            sources.push({phase,sourceHash:source.hash,predecessorHash:predecessor.hash});
            predecessor=source;
        }
        const manifest=await readEvidence(join(this.writer.forensic,'manifest.json'));
        const provenance={transitionId:era.transitionId,executionEraId:era.executionEraId,
            ledgerId:era.ledgerId,repository:era.repository,repositoryId:era.repositoryId,approvedHead:era.approvedHead,
            forensicHash:manifest.sha256,retirementHash:era.retirementHash,
            retiredBytesHash:(await readEvidence(join(era.directory,'retired.json'))).sha256,
            scheduleEra:era.scheduleEra,offlineSources:sources};
        if(this.startAuthorization.operationId){
            const approval=await capture(join(this.directory,'restart-authorization.json'));
            if(!approval||!approval.bytes.equals(eraRecordBytes(seal(this.startAuthorization))))fail('NEW_ERA_RESTART_AUTHORIZATION_CHANGED');
            const prior=await capture(this.startAuthorization.predecessorReadyPath);
            if(!prior||prior.sha256!==this.startAuthorization.predecessorReadyHash)fail('NEW_ERA_RESTART_PREDECESSOR_CHANGED');
            const previous=new NewEraRecoveryWorkflow({writer:this.writer,authorization:this.authorization,
                startAuthorization:this.startAuthorization.predecessorStartAuthorization,verifyCapabilityStorage:this.verifyCapabilityStorage});
            const previousChain=await previous.journal(inspection);
            if(this.startAuthorization.predecessorReadyKind==='ANCHOR'){
                const owned=previousChain.records.findLast(r=>r.body.state==='RUNTIME_OWNED'),done=await previous.completedStart(inspection);
                const session=previousChain.records.find(r=>r.body.state==='START_RESERVED')?.body.authorityProcessSession;
                if(!done||owned?.sha256!==this.startAuthorization.predecessorRuntimeOwnedHash||unsealEra(prior.value).phase!=='READY'||
                    this.startAuthorization.predecessorReadyPath!==join(era.directory,'start-'+session+'.json.ready')||done.result.readyAnchorHash!==prior.sha256)
                    fail('NEW_ERA_RESTART_PREDECESSOR_CHANGED');
            }else{
                const preceding=previousChain.records.findLast(r=>r.body.state==='READY');
                if(preceding?.path!==this.startAuthorization.predecessorReadyPath||preceding?.sha256!==prior.sha256||unsealEra(prior.value).state!=='READY')
                    fail('NEW_ERA_RESTART_PREDECESSOR_CHANGED');
            }
            context.runId=this.startAuthorization.operationId;predecessor={hash:approval.sha256};
            provenance.restartAuthorizationHash=approval.sha256;provenance.predecessorReadyHash=prior.sha256;
        }
        return {era,context,sources,predecessor,provenance};
    }
    async journal(inspection={}){
        const bridge=await this.bridge(inspection);let names=[];
        try{names=await readdir(this.directory);}catch(e){if(e.code!=='ENOENT')throw e;}
        if(names.some(n=>!/^\d{5}\.json(?:\.stage)?$/.test(n)&&!/^archive-uninstalled-(?:launch|preparation|reviewed)-[a-f0-9]{64}$/.test(n)&&!(this.startAuthorization.operationId&&n==='restart-authorization.json')))fail('NEW_ERA_RECOVERY_NAMESPACE');
        const records=[];let predecessor=bridge.predecessor;
        for(const name of names.filter(n=>/^\d{5}\.json$/.test(n)).sort()){
            if(name!==String(records.length+1).padStart(5,'0')+'.json')fail('NEW_ERA_RECOVERY_JOURNAL_GAP');
            const saved=await capture(join(this.directory,name)),body=unsealEra(saved.value);
            if(!saved.bytes.equals(eraRecordBytes(saved.value))||!same(body.provenance,bridge.provenance))fail('NEW_ERA_RECOVERY_PROVENANCE');
            validatePhase({value:body,hash:saved.sha256},bridge.context,body.state,predecessor);
            this.validateJournalRecord(body,records,bridge);
            records.push({...saved,body,path:join(this.directory,name)});
            predecessor={hash:saved.sha256,value:body};
        }
        const next=String(records.length+1).padStart(5,'0')+'.json.stage';
        if(names.filter(n=>n.endsWith('.stage')).some(n=>n!==next))fail('NEW_ERA_RECOVERY_STAGING_NAMESPACE');
        for(const name of names.filter(n=>n.startsWith('archive-'))){
            const archived=await readEvidence(join(this.directory,name),{text:false});
            if(archived.sha256!==name.slice(-64))fail('NEW_ERA_RECOVERY_ARCHIVE_CHANGED');
        }
        return {...bridge,records,predecessor};
    }
    validateJournalRecord(body,records,bridge){
        const previous=records.at(-1),state=previous?.body.state??'ERA_ACTIVATED';
        const allowed={AUTHORITY_INTENT:['ERA_ACTIVATED'],AUTHORITY_SUCCESSOR:['AUTHORITY_INTENT'],START_RESERVED:['AUTHORITY_SUCCESSOR'],
            LAUNCH_RESERVED:['START_RESERVED','RECONCILED'],OWNER_CLAIM:['LAUNCH_RESERVED'],RUNTIME_OWNED:['OWNER_CLAIM'],READY:['RUNTIME_OWNED'],
            RECONCILIATION_PREPARED:['START_RESERVED','LAUNCH_RESERVED','OWNER_CLAIM','RUNTIME_OWNED','READY'],RECONCILED:['RECONCILIATION_PREPARED']};
        if(!allowed[body.state]?.includes(state)||body.version!==1)fail('NEW_ERA_RECOVERY_STATE_CHAIN');
        const intent=records.find(r=>r.body.state==='AUTHORITY_INTENT');
        const original=this.startAuthorization.inventory.find(i=>i.key==='authority'),epoch=JSON.parse(Buffer.from(original.bytes,'base64')).epoch;
        const expectedEpochHash=hash(JSON.stringify({epoch:epoch+1}));
        if(body.state==='AUTHORITY_INTENT'&&(body.successorId!==stableId(this.startAuthorization,'successor')||
            body.authorityProcessSession!==stableId(this.startAuthorization,'session')||body.previousEpoch!==epoch||body.authorityEpoch!==epoch+1||
            body.predecessorAuthorityHash!==original.sha256||hash(Buffer.from(body.successorBytes,'base64'))!==expectedEpochHash))fail('NEW_ERA_AUTHORITY_PROVENANCE');
        if(body.state==='AUTHORITY_SUCCESSOR'&&(body.intentHash!==intent.sha256||body.successorId!==intent.body.successorId||
            body.authorityProcessSession!==intent.body.authorityProcessSession||body.authorityEpoch!==epoch+1||body.authorityHash!==expectedEpochHash))fail('NEW_ERA_AUTHORITY_PROVENANCE');
        if(body.state==='START_RESERVED'&&(body.successorHash!==previous.sha256||body.reservationId!==stableId(this.startAuthorization,'start')||
            body.authorityProcessSession!==intent.body.authorityProcessSession||body.authorityEpoch!==epoch+1||body.bootstrap!==false||
            body.head!==this.expected.head||body.before?.authority?.hash!==expectedEpochHash))fail('NEW_ERA_START_PROVENANCE');
        if(['LAUNCH_RESERVED','OWNER_CLAIM','RUNTIME_OWNED','READY'].includes(body.state)&&(!Number.isSafeInteger(body.pid)||body.pid<1))fail('NEW_ERA_RUNTIME_PROVENANCE');
        if(body.state==='LAUNCH_RESERVED'&&body.attempt!==records.filter(r=>r.body.state==='LAUNCH_RESERVED').length+1)fail('NEW_ERA_LAUNCH_PROVENANCE');
        if(body.state==='OWNER_CLAIM'){
            const expectedLock=JSON.stringify({pid:previous.body.pid,authorityProcessSession:intent.body.authorityProcessSession,
                executionEraId:bridge.era.executionEraId,transitionId:bridge.era.transitionId,activationHash:bridge.era.activationHash});
            if(body.pid!==previous.body.pid||body.launchHash!==previous.sha256||body.lockBytes!==expectedLock||
                body.gateBytes!==JSON.stringify({pid:body.pid,at:this.startAuthorization.createdAt})||
                body.authorityProcessSession!==intent.body.authorityProcessSession||body.authorityEpoch!==epoch+1)fail('NEW_ERA_CLAIM_PROVENANCE');
        }
        const start=records.find(r=>r.body.state==='START_RESERVED');
        if(['RUNTIME_OWNED','READY'].includes(body.state)&&(body.startReservationHash!==start.sha256||
            body.successorId!==intent.body.successorId||body.authorityEpoch!==undefined&&body.authorityEpoch!==epoch+1))fail('NEW_ERA_READY_PROVENANCE');
        if(body.state==='RUNTIME_OWNED'&&(body.claimHash!==previous.sha256||body.pid!==previous.body.pid||body.authorityProcessSession!==intent.body.authorityProcessSession))fail('NEW_ERA_RUNTIME_PROVENANCE');
        if(body.state==='READY'&&(body.runtimeOwnedHash!==previous.sha256||body.executionEraId!==bridge.era.executionEraId||
            body.transitionId!==this.runId||body.ledgerId!==bridge.era.ledgerId||body.epoch!==epoch+1||body.ready!==true||
            body.pid!==previous.body.pid||body.successorId!==intent.body.successorId))fail('NEW_ERA_READY_PROVENANCE');
        if(body.state==='RECONCILIATION_PREPARED'&&(body.reviewHash!==hash(body.review)||!same(body.review.provenance,bridge.provenance)||
            body.operationId!==stableId(this.startAuthorization,'reconcile-'+records.filter(r=>r.body.state==='LAUNCH_RESERVED').length)||
            !Number.isSafeInteger(body.recoveryPid)||body.recoveryPid<1||
            !same(body.recoveryGate,{pid:body.recoveryPid,at:this.startAuthorization.createdAt})))fail('NEW_ERA_REVIEW_PROVENANCE');
        if(body.state==='RECONCILIATION_PREPARED'&&state==='READY'&&(body.completedOwnerRecovery!==true||body.readyHash!==previous.sha256))
            fail('NEW_ERA_COMPLETED_OWNER_REVIEW_REQUIRED');
        if(body.state==='RECONCILED'&&body.preparedHash!==previous.sha256)fail('NEW_ERA_RECONCILIATION_PROVENANCE');
    }
    async publish(path,value){
        const emit=point=>this.hook(point,path,value.state);
        const bytes=eraRecordBytes(value),existing=await readEvidence(path,{optional:true,text:false});
        if(existing){if(!existing.bytes.equals(bytes))fail('NEW_ERA_RECOVERY_RECORD_CONFLICT');await this.durability.syncFile(path);return;}
        const stage=path+'.stage';
        const prior=await readEvidence(stage,{optional:true,text:false});
        if(prior&&!bytes.subarray(0,prior.byteLength).equals(prior.bytes))fail('NEW_ERA_RECOVERY_STAGING_CONFLICT');
        await emit('recovery/before-open');
        const file=await open(stage,prior?'r+':'wx',0o600);
        try{
            await emit('recovery/opened');
            const offset=prior?.byteLength??0,mid=offset+Math.floor((bytes.length-offset)/2);
            await file.write(bytes.subarray(offset,mid),0,mid-offset,offset);await emit('recovery/partial-written');
            await file.write(bytes.subarray(mid),0,bytes.length-mid,mid);await emit('recovery/written');
            await file.sync();await emit('recovery/file-flushed');
        }finally{await file.close();}
        this.durability.sync(stage);await emit('recovery/namespace-flushed');
        await emit('recovery/before-install');await this.durability.archive(stage,path);
        await emit('recovery/installed');await this.durability.syncFile(path);await emit('recovery/durable');
    }
    async append(state,value){
        const chain=await this.journal();await this.durability.ensureDirectory(this.directory);
        const path=join(this.directory,String(chain.records.length+1).padStart(5,'0')+'.json');
        const record=seal(phaseRecord(chain.context,state,chain.predecessor,{version:1,state,provenance:chain.provenance,...value}));
        await this.publish(path,record);return (await this.journal()).records.at(-1);
    }
    async preflight({reserved=false}={}){
        const h=await this.host.inspect();this.assertOfflineHost(h,{reserved});
        if((await this.host.proveOffline()).absent!==true)fail('CANONICAL_OFFLINE_PROOF_REQUIRED');
        const bridge=await this.bridge();
        const original=this.startAuthorization.inventory;
        for(const key of ['program','autoLive'])if((await readEvidence(this.writer.paths[key])).sha256!==original.find(i=>i.key===key).sha256)
            fail('NEW_ERA_CONTINUITY_CHANGED');
        await validateNewEraProgram(this.writer.paths);
        const schedule=(await readEvidence(this.p.schedule,{json:true})).value;
        if(!same(schedule.executionEra,bridge.era.scheduleEra))fail('NEW_ERA_SCHEDULE_BINDING_CHANGED');
        if(await capture(this.p.ledgerLock)||await capture(this.p.scheduledLock))fail('NEW_ERA_START_OWNER_RECONCILIATION_REQUIRED');
        await ledgerAuthority(this);
        const evidence=await this.startEvidence();return {...h,evidence};
    }
    async startEvidence(){
        return Object.fromEntries(await Promise.all(['authority','authorityLock','gate','ledger','ledgerWal','ledgerLock','marker','auto','program','schedule']
            .map(async key=>[key,await artifact(this.p[key])])));
    }
    async reserveStart({authorizeStart,authorizeBootstrap=false}){
        if(!authorizeStart||authorizeBootstrap)fail('NEW_ERA_EXPLICIT_START_REQUIRED');
        const checked=await this.preflight(),release=await this.host.reserve();
        try{
        const h=await this.preflight({reserved:true});
        if(!same(h.evidence,checked.evidence)||!same(h.service,checked.service)||!same(h.media,checked.media))fail('START_EVIDENCE_CHANGED');
        this.writer.verifyRuntimeCapability(this.writer.runtimeCapabilityProof,{serviceIdentity:h.service?.StartName});
        let chain=await this.journal(),intent=chain.records.find(r=>r.body.state==='AUTHORITY_INTENT');
        if(!intent){
            await this.hook('authority/before-transition');
            if(await capture(this.p.authorityLock)||await capture(this.p.gate))fail('NEW_ERA_UNREVIEWED_OWNER');
            const before=await readEvidence(this.p.authority,{json:true});
            if(before.sha256!==this.startAuthorization.inventory.find(i=>i.key==='authority').sha256)fail('NEW_ERA_PREDECESSOR_AUTHORITY_CHANGED');
            if(!Number.isSafeInteger(before.value.epoch+1))fail('NEW_ERA_INVALID_EPOCH');
            intent=await this.append('AUTHORITY_INTENT',{successorId:stableId(this.startAuthorization,'successor'),authorityProcessSession:stableId(this.startAuthorization,'session'),
                previousEpoch:before.value.epoch,authorityEpoch:before.value.epoch+1,predecessorAuthorityHash:before.sha256,
                successorBytes:Buffer.from(JSON.stringify({epoch:before.value.epoch+1})).toString('base64')});
            await this.hook('authority/intent-durable');
        }
        chain=await this.journal();
        const i=intent.body,wanted=Buffer.from(i.successorBytes,'base64');
        let successor=chain.records.find(r=>r.body.state==='AUTHORITY_SUCCESSOR');
        if(!successor){
            const current=await readEvidence(this.p.authority);
            if(current.sha256!==i.predecessorAuthorityHash&&current.sha256!==hash(wanted))fail('NEW_ERA_SUCCESSOR_CHANGED');
            if(current.sha256!==hash(wanted)){
                const stage=this.p.authority+'.era-'+this.runId+'.stage';
                const existing=await readEvidence(stage,{optional:true,text:false});
                if(existing&&!wanted.subarray(0,existing.byteLength).equals(existing.bytes))fail('NEW_ERA_SUCCESSOR_STAGE_CHANGED');
                await this.hook('authority-epoch-stage/before-open');
                const f=await open(stage,existing?'r+':'wx');
                try{
                    await this.hook('authority-epoch-stage/opened');const mid=Math.floor(wanted.length/2);
                    await f.write(wanted.subarray(0,mid),0,mid,0);await this.hook('authority-epoch-stage/partial-written');
                    await f.write(wanted.subarray(mid),0,wanted.length-mid,mid);await this.hook('authority-epoch-stage/written');
                    await f.sync();await this.hook('authority-epoch-stage/file-flushed');
                }finally{await f.close();}
                this.durability.sync(stage);await this.hook('authority-epoch-stage/namespace-flushed');
                await this.hook('authority-epoch-stage/before-install');await this.hook('authority/before-epoch-install');
                if((await readEvidence(this.p.authority)).sha256!==i.predecessorAuthorityHash)fail('NEW_ERA_PREDECESSOR_AUTHORITY_CHANGED');
                this.durability.replace(stage,this.p.authority);await this.hook('authority-epoch-stage/installed');
                await this.durability.syncFile(this.p.authority);await this.hook('authority-epoch-stage/durable');
            }
            await this.durability.syncFile(this.p.authority);await this.hook('authority/epoch-durable');
            successor=await this.append('AUTHORITY_SUCCESSOR',{intentHash:intent.sha256,successorId:i.successorId,
                authorityProcessSession:i.authorityProcessSession,authorityEpoch:i.authorityEpoch,authorityHash:hash(wanted)});
        }
        chain=await this.journal();let start=chain.records.find(r=>r.body.state==='START_RESERVED');
        if(!start){await this.hook('controlled-start/before-reservation');
            start=await this.append('START_RESERVED',{reservationId:stableId(this.startAuthorization,'start'),successorHash:successor.sha256,
                successorId:i.successorId,authorityProcessSession:i.authorityProcessSession,authorityEpoch:i.authorityEpoch,
                bootstrap:false,head:this.expected.head,at:this.startAuthorization.createdAt,before:await this.startEvidence()});
            await this.hook('controlled-start/reservation');
        }
        chain=await this.journal();
        if(!['START_RESERVED','RECONCILED'].includes(chain.records.at(-1).body.state)||
            await readEvidence(join(this.directory,String(chain.records.length+1).padStart(5,'0')+'.json.stage'),{optional:true,text:false}))
            fail('NEW_ERA_LAUNCH_OUTCOME_REVIEW_REQUIRED');
        return start.body;
        }finally{await release();}
    }
    startChain=()=>this.journal();
    async beforeLaunch(){
        const chain=await this.journal();
        if(await this.completedStart())fail('NEW_ERA_COMPLETED_START_RESTART_REQUIRED');
        if(!['START_RESERVED','RECONCILED'].includes(chain.records.at(-1)?.body.state))fail('NEW_ERA_LAUNCH_OUTCOME_REVIEW_REQUIRED');
        await this.append('LAUNCH_RESERVED',{pid:process.pid,attempt:chain.records.filter(r=>r.body.state==='LAUNCH_RESERVED').length+1});
        await this.hook('controlled-start/launch-reserved');
    }
    ownershipOptions(){return {eraRecovery:this};}
    async acquireOwner(owner){
        const chain=await this.journal(),last=chain.records.at(-1),intent=chain.records.find(r=>r.body.state==='AUTHORITY_INTENT').body;
        if(last?.body.state!=='LAUNCH_RESERVED'||last.body.pid!==process.pid)fail('NEW_ERA_CONTROLLED_LAUNCH_REQUIRED');
        const successor=chain.records.find(r=>r.body.state==='AUTHORITY_SUCCESSOR');
        if((await readEvidence(this.p.authority)).sha256!==successor.body.authorityHash)fail('NEW_ERA_SUCCESSOR_CHANGED');
        owner.authorityProcessSession=intent.authorityProcessSession;
        const gate={pid:process.pid,at:this.startAuthorization.createdAt},lock={pid:process.pid,authorityProcessSession:intent.authorityProcessSession,
            executionEraId:chain.era.executionEraId,transitionId:chain.era.transitionId,activationHash:chain.era.activationHash};
        const claim=await this.append('OWNER_CLAIM',{pid:process.pid,gateBytes:JSON.stringify(gate),lockBytes:JSON.stringify(lock),
            authorityProcessSession:intent.authorityProcessSession,authorityEpoch:intent.authorityEpoch,launchHash:last.sha256});
        let release;
        try{
            release=await acquireMaintenanceGate(this.p.authority,{durability:this.durability,record:gate,hook:point=>this.hook('authority-gate/'+point)});
            await this.hook('authority-owner-lock/before-open');
            owner.lock=await open(this.p.authorityLock,'wx');owner.lockBytes=JSON.stringify(lock);
            await this.hook('authority-owner-lock/opened');const bytes=Buffer.from(owner.lockBytes),mid=Math.floor(bytes.length/2);
            await owner.lock.write(bytes.subarray(0,mid),0,mid,0);await this.hook('authority-owner-lock/partial-written');
            await owner.lock.write(bytes.subarray(mid),0,bytes.length-mid,mid);await this.hook('authority-owner-lock/written');
            await owner.lock.sync();await this.hook('authority-owner-lock/file-flushed');this.durability.sync(this.p.authorityLock);
            await this.hook('authority-owner-lock/namespace-flushed');await this.hook('authority-owner-lock/durable');
            await this.hook('authority/owner-lock-durable');
            const start=chain.records.find(r=>r.body.state==='START_RESERVED');
            const anchor=seal({version:1,phase:'NEW_AUTHORITY_READY',executionEraId:chain.era.executionEraId,
                transitionId:chain.era.transitionId,activationHash:chain.era.activationHash,previousEpoch:intent.previousEpoch,
                authorityEpoch:intent.authorityEpoch,authorityProcessSession:intent.authorityProcessSession,
                authorityBytesHash:successor.body.authorityHash,lockBytesHash:hash(owner.lockBytes),
                successorId:intent.successorId,startReservationHash:start.sha256,recoveryClaimHash:claim.sha256});
            await this.publish(join(chain.era.directory,'start-'+intent.authorityProcessSession+'.json'),anchor);
            await this.hook('authority/authority-ready-durable');
            owner.authorityEpoch=intent.authorityEpoch;owner.available=true;owner.restartBlocked=true;owner.reason='RESTART_RECONCILIATION_REQUIRED';
            owner.controlledStartBinding={reservationHash:start.sha256,reservationPath:start.path,claimHash:claim.sha256,claimPath:claim.path,successorId:intent.successorId,
                context:chain.context,provenance:chain.provenance};
        }finally{if(release)await release();}
    }
    async validateStart(start,chain){
        const saved=chain.records.find(r=>r.body.state==='START_RESERVED');
        if(!saved||!same(saved.body,start))fail('START_RESERVATION_CHANGED');
    }
    expectedEvidence(start,chain){return chain.records.at(-1)?.body.state==='RECONCILED'?chain.records.at(-1).body.after:start.before;}
    async finishRuntime(owner,{authorizeReconciliation,hostSnapshot}){
        if(owner.server&&(!owner.server.listening||owner.server.address()?.port!==8080||!hostSnapshot?.ports?.length||
            hostSnapshot.ports.some(p=>p.LocalPort!==8080||p.OwningProcess!==process.pid)))fail('NEW_ERA_RUNTIME_PORT_OWNERSHIP_UNPROVEN');
        const chain=await this.journal(),claim=chain.records.at(-1),start=chain.records.find(r=>r.body.state==='START_RESERVED');
        const authority=owner.executionOwnership;
        if(claim?.body.state!=='OWNER_CLAIM'||!authority?.available||authority.authorityEpoch!==start.body.authorityEpoch||
            authority.authorityProcessSession!==start.body.authorityProcessSession)fail('NEW_ERA_RUNTIME_OWNER_UNPROVEN');
        assertEraAuthority(chain.era,authority);
        const ledger=await inspectV2(this.p.ledger);
        if(ledger.pending||ledger.current.ledgerId!==chain.era.ledgerId||ledger.owner?.pid!==process.pid||
            ledger.owner?.authorityEpoch!==authority.authorityEpoch||ledger.owner?.authorityProcessSession!==authority.authorityProcessSession)
            fail('NEW_ERA_RUNTIME_LEDGER_UNPROVEN');
        await this.preflightRuntime();
        const ledgerEvidence=await ledgerAuthority(this,{allowOwner:true});
        const scheduledLock=await capture(this.p.scheduledLock),scheduledJournal=await capture(this.p.scheduled);
        const sl=scheduledLock?.value;
        if(validateLock(sl,repositoryIdentity(this.p.scheduled))!=='VERIFIABLE'||sl.processId!==process.pid||
            sl.authorityEpoch!==authority.authorityEpoch||sl.authorityProcessSession!==authority.authorityProcessSession||
            sl.executionEraId!==chain.era.executionEraId||sl.retirementHash!==chain.era.retirementHash||
            owner.scheduledLiveExecutionRepository?.status!=='READY')fail('NEW_ERA_RUNTIME_SCHEDULED_OWNER_UNPROVEN');
        journalMatchesLock(scheduledJournal?.text??null,sl);
        const runtimeOwned=await this.append('RUNTIME_OWNED',{claimHash:claim.sha256,startReservationHash:start.sha256,
            successorId:authority.controlledStartBinding.successorId,pid:process.pid,
            authorityEpoch:authority.authorityEpoch,authorityProcessSession:authority.authorityProcessSession,
            ledgerWalHash:hash(ledger.walBytes),scheduledLockHash:scheduledLock.sha256,scheduledJournalHash:scheduledJournal?.sha256??null});
        authority.controlledStartBinding.runtimeOwnedHash=runtimeOwned.sha256;
        authority.controlledStartBinding.runtimeOwnedPath=runtimeOwned.path;
        await this.hook('runtime/ownership');
        if(!authorizeReconciliation)fail('EXPLICIT_RESTART_RECONCILIATION_REQUIRED');
        if(!owner.restartReconciliation)fail('NEW_ERA_RESTART_RECONCILIATION_REQUIRED');
        const binding={ownerInstanceId:'new-era-'+this.runId,publisherSessionId:'new-era-'+authority.authorityProcessSession};
        const prepared=owner.restartReconciliation.execute({...binding,operation:'prepare-reconciliation'},this.startAuthorization.principal);
        owner.restartReconciliation.execute({...binding,...prepared,operation:'reconcile'},this.startAuthorization.principal);
        const anchor=await publishEraReady({era:chain.era,authority,program:owner.durableProgram,autoLive:owner.autoLive,
            validateProgram:()=>validateNewEraProgram(this.writer.paths),durability:this.durability,
            hook:point=>this.hook(point==='before-ready-install'?'READY/before-install':'READY/durable')});
        const current=await this.journal(),owned=current.records.at(-1);
        const result={ready:true,pid:process.pid,epoch:authority.authorityEpoch,executionEraId:chain.era.executionEraId,
            transitionId:this.runId,ledgerId:chain.era.ledgerId,successorId:authority.controlledStartBinding.successorId,
            startReservationHash:start.sha256,runtimeOwnedHash:owned.sha256,readyAnchorHash:hash(eraRecordBytes(anchor)),ledgerAuthority:ledgerEvidence};
        await this.hook('controlled-start/before-ready-persist');await this.append('READY',result);
        await this.hook('controlled-start/ready-durable');return result;
    }
    async preflightRuntime(){
        const chain=await this.journal();
        for(const key of ['program','autoLive'])if((await readEvidence(this.writer.paths[key])).sha256!==this.startAuthorization.inventory.find(i=>i.key===key).sha256)
            fail('NEW_ERA_CONTINUITY_CHANGED');
        await validateNewEraProgram(this.writer.paths);
        if(!same((await capture(this.p.schedule)).value.executionEra,chain.era.scheduleEra))fail('NEW_ERA_SCHEDULE_BINDING_CHANGED');
    }
    async completedStart(inspection={}){
        const chain=await this.journal(inspection),last=chain.records.at(-1);
        const storage=()=>inspection.readOnly?this.verifyCapabilityStorage(dirname(this.p.ledger),inspection.proof,this.writer.runtimeCapabilityProof):this.writer.native.capability(dirname(this.p.ledger));
        const readyRecord=chain.records.findLast(r=>r.body.state==='READY');
        const start=chain.records.find(r=>r.body.state==='START_RESERVED'),owned=readyRecord?
            chain.records[chain.records.indexOf(readyRecord)-1]:chain.records.findLast(r=>r.body.state==='RUNTIME_OWNED');
        if(!start||!owned)return null;
        const path=join(chain.era.directory,'start-'+start.body.authorityProcessSession+'.json.ready');
        const anchor=await capture(path);
        if(!anchor){if(readyRecord)fail('NEW_ERA_READY_PROVENANCE');return null;}
        const ready=unsealEra(anchor.value);
        const ownerAnchor=await capture(path.slice(0,-6));
        if(owned?.body.state!=='RUNTIME_OWNED'||ready.startReservationHash!==start.sha256||ready.runtimeOwnedHash!==owned.sha256||
            ready.recoveryClaimHash!==owned.body.claimHash||ready.authorityEpoch!==start.body.authorityEpoch||
            ready.authorityProcessSession!==start.body.authorityProcessSession||
            ready.activationHash!==chain.era.activationHash||ready.ownerHash!==hash(unsealEra(ownerAnchor?.value))||
            ready.successorId!==owned.body.successorId||ready.programHash!==this.startAuthorization.inventory.find(i=>i.key==='program').sha256||
            ready.autoLiveHash!==this.startAuthorization.inventory.find(i=>i.key==='autoLive').sha256||
            !same(ready.recoveryLineage,phaseRecord(chain.context,'READY',{hash:owned.sha256},{}).lineage)||
            (readyRecord&&(readyRecord.body.runtimeOwnedHash!==owned.sha256||readyRecord.body.startReservationHash!==start.sha256||anchor.sha256!==readyRecord.body.readyAnchorHash)))
            fail('NEW_ERA_READY_PROVENANCE');
        const ledger=await inspectV2(this.p.ledger),prefix=Buffer.from(ready.walBytes,'base64');
        const anchored=validateEraReadyLedger(chain.era,ready,{snapshot:ledger.snapshot,walBytes:ledger.walBytes,code:'NEW_ERA_READY_LEDGER_FORK'});
        if(anchored.owner?.pid!==owned.body.pid)fail('NEW_ERA_READY_LEDGER_FORK');
        if(readyRecord){
            const authority=readyRecord.body.ledgerAuthority;
            if(authority?.mode!=='V2'||authority.schemaVersion!==2||authority.path!==this.p.ledger||authority.repositoryId!==repositoryIdentity(this.p.ledger)||
                authority.executionEraId!==chain.era.executionEraId||authority.transitionId!==chain.era.transitionId||authority.retirementHash!==chain.era.retirementHash||
                authority.snapshot?.ledgerId!==chain.era.ledgerId||hash(authority.snapshot)!==ready.snapshotHash||
                authority.walHash!==ready.walHash||!Buffer.from(authority.walBytes??'').equals(prefix)||
                authority.markerHash!==(await readEvidence(this.p.marker)).sha256||
                !same(authority.storage,storage()))fail('NEW_ERA_READY_AUTHORITY_EVIDENCE_CHANGED');
        }
        const stage=await readEvidence(join(this.directory,String(chain.records.length+1).padStart(5,'0')+'.json.stage'),{optional:true,text:false});
        if(stage&&!readyRecord&&last.body.state==='RUNTIME_OWNED'){
            const result={ready:true,pid:owned.body.pid,epoch:start.body.authorityEpoch,executionEraId:chain.era.executionEraId,
                transitionId:this.runId,ledgerId:chain.era.ledgerId,successorId:owned.body.successorId,startReservationHash:start.sha256,
                runtimeOwnedHash:owned.sha256,readyAnchorHash:anchor.sha256,ledgerAuthority:await ledgerAuthority(this,{allowOwner:true,...(inspection.readOnly?{storage}: {})})};
            const expected=eraRecordBytes(seal(phaseRecord(chain.context,'READY',chain.predecessor,{version:1,state:'READY',provenance:chain.provenance,...result})));
            if(!expected.subarray(0,stage.byteLength).equals(stage.bytes))fail('NEW_ERA_READY_STAGING_CONFLICT');
        }
        return {owner:null,result:readyRecord?{...readyRecord.body,state:'ALREADY_COMPLETED'}:{ready:true,pid:owned.body.pid,state:'ALREADY_COMPLETED',executionEraId:chain.era.executionEraId,
            transitionId:chain.era.transitionId,ledgerId:chain.era.ledgerId,epoch:start.body.authorityEpoch,
            successorId:owned.body.successorId,startReservationHash:start.sha256,readyAnchorHash:anchor.sha256}};
    }
    async startReview(){
        // Current canonical proof is required even before START_RESERVED/READY.
        // After activation a separately approved current proof may supersede P1;
        // transition continuation still binds the original authorization to P1.
        const proof=await this.writer.currentRuntimeProof(),inspection={readOnly:true,proof};
        return {journal:await this.journal(inspection),review:await this.recoveryReview(inspection),
            completed:await this.completedStart(inspection),proof,readOnly:true};
    }
    async recoveryReview(inspection={}){
        const chain=await this.journal(inspection),files={};
        const paths=new Set([this.p.authority,this.p.authority+'.era-'+this.runId+'.stage',this.p.authorityLock,this.p.gate,this.p.ledger,this.p.ledgerWal,
            this.p.ledgerLock,this.p.scheduled,this.p.scheduledLock,this.p.program,this.p.auto,this.p.schedule]);
        for(const directory of [this.directory,this.writer.directory]){
            let names=[];try{names=await readdir(directory);}catch(e){if(e.code!=='ENOENT')throw e;}
            for(const name of names)paths.add(join(directory,name));
        }
        for(const path of paths){const value=await readEvidence(path,{optional:true,text:false});
            files[path]=value?{hash:value.sha256,bytes:value.bytes.toString('base64')}:null;}
        const value={provenance:chain.provenance,files,lastState:chain.records.at(-1)?.body.state??'ERA_ACTIVATED'};
        return {hash:hash(value),value};
    }
    async planRestart({authorizeRestart=false,expectedReviewHash,principal}={}){
        if(!authorizeRestart||!expectedReviewHash||typeof principal!=='string'||!principal.trim())fail('EXPLICIT_NEW_ERA_RESTART_REQUIRED');
        const review=await this.recoveryReview();
        if(review.hash!==expectedReviewHash)fail('NEW_ERA_REVIEW_CHANGED');
        const chain=await this.journal(),done=await this.completedStart(),ready=chain.records.findLast(r=>r.body.state==='READY');
        if(!done)fail('NEW_ERA_DURABLE_READY_PREDECESSOR_REQUIRED');
        const owned=chain.records.findLast(r=>r.body.state==='RUNTIME_OWNED'),start=chain.records.find(r=>r.body.state==='START_RESERVED');
        const readyPath=ready?.path??join(chain.era.directory,'start-'+start.body.authorityProcessSession+'.json.ready');
        const readyEvidence=await readEvidence(readyPath);
        this.assertOfflineHost(await this.host.inspect());
        const release=await this.host.reserve();
        try{
            const h=await this.host.inspect();this.assertOfflineHost(h,{reserved:true});
            this.writer.verifyRuntimeCapability(this.writer.runtimeCapabilityProof,{serviceIdentity:h.service?.StartName});
            if((await this.host.proveOffline()).absent!==true)fail('CANONICAL_OFFLINE_PROOF_REQUIRED');
            for(const key of ['authorityLock','gate','ledgerLock','scheduledLock'])if(await capture(this.p[key]))fail('NEW_ERA_RESTART_OWNER_RECONCILIATION_REQUIRED');
            await ledgerAuthority(this);await validateNewEraProgram(this.writer.paths);
            if((await readEvidence(this.p.authority,{json:true})).value.epoch!==done.result.epoch)fail('NEW_ERA_RESTART_AUTHORITY_CHANGED');
            if((await this.recoveryReview()).hash!==review.hash)fail('NEW_ERA_REVIEW_CHANGED');
            const startAuthorization={...structuredClone(this.authorization),operationId:randomUUID(),principal,
                createdAt:new Date().toISOString(),predecessorReadyPath:readyPath,predecessorReadyHash:readyEvidence.sha256,reviewHash:review.hash,
                ...(ready?{}:{predecessorReadyKind:'ANCHOR',predecessorRuntimeOwnedHash:owned.sha256}),
                ...(this.startAuthorization.operationId?{predecessorStartAuthorization:structuredClone(this.startAuthorization)}:{})};
            for(const key of ['authority','program','autoLive']){
                const current=await readEvidence(this.writer.paths[key]);
                const item=startAuthorization.inventory.find(i=>i.key===key);
                Object.assign(item,{present:true,byteLength:current.byteLength,sha256:current.sha256,bytes:current.bytes.toString('base64')});
            }
            const next=new NewEraRecoveryWorkflow({writer:this.writer,authorization:this.authorization,startAuthorization,hook:this.hook,isAlive:this.isAlive});
            return next;
        }finally{await release();}
    }
    async prepareRestart(options){
        const next=await this.planRestart(options);await next.installRestartAuthorization({authorizeStart:true});return next;
    }
    async installRestartAuthorization({authorizeStart=false}={}){
        if(!this.startAuthorization.operationId)return;
        if(!authorizeStart)fail('NEW_ERA_EXPLICIT_START_REQUIRED');
        const path=join(this.directory,'restart-authorization.json'),record=seal(this.startAuthorization),existing=await capture(path);
        if(existing){if(!existing.bytes.equals(eraRecordBytes(record)))fail('NEW_ERA_RESTART_AUTHORIZATION_CHANGED');return;}
        const previous=new NewEraRecoveryWorkflow({writer:this.writer,authorization:this.authorization,startAuthorization:this.startAuthorization.predecessorStartAuthorization});
        const reviewed=await previous.recoveryReview();
        if(reviewed.hash!==this.startAuthorization.reviewHash||!await previous.completedStart())fail('NEW_ERA_RESTART_REVIEW_CHANGED');
        const prior=await capture(this.startAuthorization.predecessorReadyPath);
        if(!prior||prior.sha256!==this.startAuthorization.predecessorReadyHash)fail('NEW_ERA_RESTART_PREDECESSOR_CHANGED');
        this.assertOfflineHost(await this.host.inspect());const release=await this.host.reserve();
        try{
            const h=await this.host.inspect();this.assertOfflineHost(h,{reserved:true});
            this.writer.verifyRuntimeCapability(this.writer.runtimeCapabilityProof,{serviceIdentity:h.service?.StartName});
            if((await this.host.proveOffline()).absent!==true||(await previous.recoveryReview()).hash!==reviewed.hash)fail('NEW_ERA_RESTART_REVIEW_CHANGED');
            for(const key of ['authorityLock','gate','ledgerLock','scheduledLock'])if(await capture(this.p[key]))fail('NEW_ERA_RESTART_OWNER_RECONCILIATION_REQUIRED');
            await this.durability.ensureDirectory(this.directory);await this.publish(path,record);
        }finally{await release();}
    }
    async validateRecoveryLock(lock){
        const chain=await this.journal(),claim=chain.records.filter(r=>r.body.state==='OWNER_CLAIM').at(-1);
        const start=chain.records.find(r=>r.body.state==='START_RESERVED');
        const prepared=chain.records.at(-1)?.body;
        if(!claim||chain.records.some(r=>r.body.state==='READY')&&prepared?.completedOwnerRecovery!==true||lock.executionEraId!==chain.era.executionEraId||
            lock.ledgerId!==chain.era.ledgerId||lock.pid!==claim.body.pid||lock.authorityEpoch!==start.body.authorityEpoch||
            lock.authorityProcessSession!==start.body.authorityProcessSession)fail('NEW_ERA_LEDGER_RECOVERY_PROVENANCE');
        return true;
    }
    async recoverStart({authorizeRecovery=false,authorizeCompletedOwnerRecovery=false,expectedReviewHash}={}){
        if(!authorizeRecovery||!expectedReviewHash)fail('EXPLICIT_NEW_ERA_RECOVERY_REQUIRED');
        const first=await this.recoveryReview();if(first.hash!==expectedReviewHash)fail('NEW_ERA_REVIEW_CHANGED');
        const completed=await this.completedStart();
        if(completed&&!authorizeCompletedOwnerRecovery)return {state:'ALREADY_COMPLETED'};
        let chain=await this.journal(),last=chain.records.at(-1);
        if(last?.body.state==='RECONCILED')return {state:'RECONCILED'};
        if(!['START_RESERVED','LAUNCH_RESERVED','OWNER_CLAIM','RUNTIME_OWNED','RECONCILIATION_PREPARED','READY'].includes(last?.body.state))fail('NEW_ERA_RECOVERY_REVIEW_REQUIRED');
        this.assertOfflineHost(await this.host.inspect());
        const release=await this.host.reserve();
        try{
            const h=await this.host.inspect();this.assertOfflineHost(h,{reserved:true});
            this.writer.verifyRuntimeCapability(this.writer.runtimeCapabilityProof,{serviceIdentity:h.service?.StartName});
            if((await this.host.proveOffline()).absent!==true)fail('CANONICAL_OFFLINE_PROOF_REQUIRED');
            const launch=chain.records.filter(r=>r.body.state==='LAUNCH_RESERVED').at(-1);
            let claim=chain.records.filter(r=>r.body.state==='OWNER_CLAIM').at(-1);
            const pids=new Set([launch?.body.pid,claim?.body.pid,last.body.recoveryPid].filter(Boolean));
            for(const pid of pids)if(this.isAlive(pid))fail('NEW_ERA_OWNER_ALIVE_OR_AMBIGUOUS');
            if(completed)await validateNewEraProgram(this.writer.paths);else await this.preflightRuntime();
            if((await this.recoveryReview()).hash!==first.hash)fail('NEW_ERA_REVIEW_CHANGED');
            const pending=join(this.directory,String(chain.records.length+1).padStart(5,'0')+'.json.stage');
            const staged=await readEvidence(pending,{optional:true,text:false});
            if(staged){
                const matches=(state,value)=>eraRecordBytes(seal(phaseRecord(chain.context,state,chain.predecessor,
                    {version:1,state,provenance:chain.provenance,...value}))).subarray(0,staged.byteLength).equals(staged.bytes);
                const retain=async()=>{
                    const receipt=join(this.directory,'archive-uninstalled-reviewed-'+hash(staged.bytes));
                    await this.durability.archive(pending,receipt);await this.durability.syncFile(receipt);
                };
                if(last.body.state==='LAUNCH_RESERVED'){
                    const intent=chain.records.find(r=>r.body.state==='AUTHORITY_INTENT').body;
                    const lock={pid:launch.body.pid,authorityProcessSession:intent.authorityProcessSession,
                        executionEraId:chain.era.executionEraId,transitionId:chain.era.transitionId,activationHash:chain.era.activationHash};
                    const value={pid:launch.body.pid,gateBytes:JSON.stringify({pid:launch.body.pid,at:this.startAuthorization.createdAt}),
                        lockBytes:JSON.stringify(lock),authorityProcessSession:intent.authorityProcessSession,authorityEpoch:intent.authorityEpoch,launchHash:launch.sha256};
                    if(matches('OWNER_CLAIM',value))claim=await this.append('OWNER_CLAIM',value);
                    else await retain();
                }else if(last.body.state==='OWNER_CLAIM'){
                    const ledger=await inspectV2(this.p.ledger),start=chain.records.find(r=>r.body.state==='START_RESERVED'),intent=chain.records[0];
                    const value={claimHash:claim.sha256,startReservationHash:start.sha256,successorId:intent.body.successorId,
                        pid:claim.body.pid,authorityEpoch:start.body.authorityEpoch,authorityProcessSession:start.body.authorityProcessSession,
                        ledgerWalHash:hash(ledger.walBytes),scheduledLockHash:(await capture(this.p.scheduledLock))?.sha256,
                        scheduledJournalHash:(await capture(this.p.scheduled))?.sha256??null};
                    if(matches('RUNTIME_OWNED',value)){
                        if(ledger.owner?.pid!==claim.body.pid||ledger.pending)fail('NEW_ERA_PARTIAL_RUNTIME_UNPROVEN');
                        await this.append('RUNTIME_OWNED',value);
                    }else await retain();
                }else if(last.body.state==='START_RESERVED'){
                    // A launch plan that never installed cannot prove a launched
                    // process. Keep its bytes under the explicit reviewed receipt.
                    if(await capture(this.p.authorityLock)||await capture(this.p.ledgerLock))fail('NEW_ERA_UNBOUND_OWNER');
                    const receipt=join(this.directory,'archive-uninstalled-launch-'+hash(staged.bytes));
                    await this.durability.archive(pending,receipt);await this.durability.syncFile(receipt);
                }else if(last.body.state==='RECONCILIATION_PREPARED'){
                    const ledger=await inspectV2(this.p.ledger);
                    if(ledger.owner||ledger.pending||await capture(this.p.authorityLock)||await capture(this.p.ledgerLock)||
                        await capture(this.p.scheduledLock)||await capture(this.p.gate))fail('NEW_ERA_PARTIAL_RECONCILIATION_REVIEW_REQUIRED');
                    await this.append('RECONCILED',{preparedHash:last.sha256,operationId:last.body.operationId,after:await this.startEvidence()});
                    return {state:'RECONCILED'};
                }else if(['RUNTIME_OWNED','READY'].includes(last.body.state)){
                    // An uninstalled preparation has not yet mutated any owner
                    // artifact. Preserve its raw bytes; start a reviewed receipt.
                    const receipt=join(this.directory,'archive-uninstalled-preparation-'+hash(staged.bytes));
                    await this.durability.archive(pending,receipt);await this.durability.syncFile(receipt);
                }else fail('NEW_ERA_PARTIAL_RECONCILIATION_REVIEW_REQUIRED');
                chain=await this.journal();last=chain.records.at(-1);
            }
            let prepared=last.body.state==='RECONCILIATION_PREPARED'?last:null;
            if(!prepared){prepared=await this.append('RECONCILIATION_PREPARED',{review:first.value,reviewHash:first.hash,
                recoveryPid:process.pid,recoveryGate:{pid:process.pid,at:this.startAuthorization.createdAt},
                ...(completed?{completedOwnerRecovery:true,readyHash:chain.records.findLast(r=>r.body.state==='READY')?.sha256??null,
                    readyAnchorHash:completed.result.readyAnchorHash}:{}),
                operationId:stableId(this.startAuthorization,'reconcile-'+chain.records.filter(r=>r.body.state==='LAUNCH_RESERVED').length)});
                await this.hook('reconciliation/prepared');}
            const archive=async(path,expectedBytes,label)=>{
                const destination=path+'.reconciled-'+prepared.body.operationId+'-'+label;
                const current=await readEvidence(path,{optional:true,text:false}),saved=await readEvidence(destination,{optional:true,text:false});
                if(saved&&expectedBytes&&!expectedBytes.subarray(0,saved.byteLength).equals(saved.bytes))fail('NEW_ERA_ARCHIVE_CHANGED');
                const reviewed=prepared.body.review.files[path];
                if(saved&&reviewed&&label!=='recovery-gate'&&saved.sha256!==reviewed.hash)fail('NEW_ERA_ARCHIVE_CHANGED');
                if(current){
                    if(expectedBytes&&!expectedBytes.subarray(0,current.byteLength).equals(current.bytes))fail('NEW_ERA_ORPHAN_BYTES_CHANGED');
                    if(saved)fail('NEW_ERA_ARCHIVE_AMBIGUOUS');
                    await this.durability.archive(path,destination);await this.durability.syncFile(destination);
                    await this.hook('reconciliation/archive',path);
                }
            };
            // The canonical claim records exact gate/lock bytes before acquisition.
            // A matching prefix is retained as evidence, never treated as ownership.
            const gate=await readEvidence(this.p.gate,{optional:true,text:false});
            if(gate){
                const planned=Buffer.from(JSON.stringify(prepared.body.recoveryGate));
                const original=claim?Buffer.from(claim.body.gateBytes):null;
                const initial=prepared.body.review.files[this.p.gate];
                const initialArchive=await readEvidence(this.p.gate+'.reconciled-'+prepared.body.operationId+'-gate',{optional:true,text:false});
                const isInitial=initial?.hash===gate.sha256&&!initialArchive;
                const isRecovery=!isInitial&&planned.subarray(0,gate.byteLength).equals(gate.bytes);
                if(isRecovery&&this.isAlive(prepared.body.recoveryPid))fail('NEW_ERA_OWNER_ALIVE_OR_AMBIGUOUS');
                if(!isRecovery&&!original)fail('NEW_ERA_UNBOUND_MAINTENANCE_GATE');
                await archive(this.p.gate,isRecovery?planned:original,isRecovery?'recovery-gate':'gate');
            }
            const ledgerAudit=await capture(this.p.ledger+'.recovery-'+prepared.body.operationId+'.json');
            const ledgerCompleted=await capture(this.p.ledger+'.recovery-'+prepared.body.operationId+'.json.completed');
            if(await capture(this.p.ledgerLock)||(ledgerAudit&&!ledgerCompleted)){
                const expected=ledgerAudit?.value.expected??(await ledgerRecoveryEvidence({path:this.p.ledger,authorityPath:this.p.authority,scheduledPath:this.p.scheduled})).hashes;
                await reconcileScheduledEntryLedgerV2({path:this.p.ledger,authorityPath:this.p.authority,scheduledPath:this.p.scheduled,
                    operationId:prepared.body.operationId,expected,newEraRecovery:this,proveOffline:()=>this.host.proveOffline(),
                    reserve:async()=>async()=>{},isAlive:this.isAlive,syncDirectory:this.syncDirectory,
                    hook:point=>this.hook('ledger-reconciliation/'+point)});
            }
            // Scheduled ownership must be reconciled by its committed contract;
            // an unexpected live Scheduled writer is never discarded here.
            const scheduled=await capture(this.p.scheduledLock);
            const scheduledAudit=await capture(this.p.scheduled+'.reconciliation-'+prepared.body.operationId+'.json');
            const scheduledCompleted=await capture(this.p.scheduled+'.reconciliation-'+prepared.body.operationId+'.json.completed');
            if(scheduled||(scheduledAudit&&!scheduledCompleted)){
                const journal=await capture(this.p.scheduled),epoch=await capture(this.p.authority),authorityLock=await capture(this.p.authorityLock);
                const expected=scheduledAudit?.value.contract.expected??{lockHash:scheduled.sha256,repositoryId:repositoryIdentity(this.p.scheduled),processSession:scheduled.value.processSession,
                    journalHash:journal?.sha256??null,authorityHash:epoch.sha256,authorityLockHash:authorityLock?.sha256??null};
                await reconcileScheduledExecutionLock({path:this.p.scheduled,authorityPath:this.p.authority,operationId:prepared.body.operationId,
                    expected,newEraRecovery:this,durability:this.durability,proveOffline:()=>this.host.proveOffline(),
                    reserve:async()=>async()=>{},isAlive:this.isAlive,hook:point=>this.hook('scheduled-reconciliation/'+point)});
            }
            if(claim){
                await archive(this.p.authorityLock,Buffer.from(claim.body.lockBytes),'authority-lock');
            }
            if(claim&&!prepared.body.completedOwnerRecovery){
                const start=chain.records.find(r=>r.body.state==='START_RESERVED');
                const path=join(chain.era.directory,'start-'+start.body.authorityProcessSession+'.json');
                const original=prepared.body.review.files[path];
                await archive(path,original?Buffer.from(original.bytes,'base64'):null,'owner-anchor');
                const stage=path+'.stage';
                const raw=await readEvidence(stage,{optional:true,text:false});
                if(raw)await archive(stage,raw.bytes,'owner-stage');
                // READY may be durable before the canonical READY journal entry.
                // Retain that anchor; a new owner must not silently overwrite it.
                const ready=await readEvidence(path+'.ready',{optional:true,text:false});
                if(ready)await archive(path+'.ready',ready.bytes,'ready-anchor');
                const readyStage=await readEvidence(path+'.ready.stage',{optional:true,text:false});
                if(readyStage)await archive(path+'.ready.stage',readyStage.bytes,'ready-stage');
            }
            if((await this.host.proveOffline()).absent!==true)fail('CANONICAL_OFFLINE_PROOF_REQUIRED');
            const intent=chain.records.find(r=>r.body.state==='AUTHORITY_INTENT');
            if((await readEvidence(this.p.authority)).sha256!==hash(Buffer.from(intent.body.successorBytes,'base64')))
                fail('NEW_ERA_SUCCESSOR_CHANGED');
            const state=await inspectV2(this.p.ledger);if(state.owner||state.pending)fail('NEW_ERA_LEDGER_RECOVERY_INCOMPLETE');
            for(const key of ['program','auto','schedule'])if((await readEvidence(this.p[key])).sha256!==first.value.files[this.p[key]]?.hash)
                fail('NEW_ERA_RECOVERY_CONTINUITY_CHANGED');
            await this.append('RECONCILED',{preparedHash:prepared.sha256,operationId:prepared.body.operationId,after:await this.startEvidence()});
            await this.hook('reconciliation/finalization');return {state:'RECONCILED',authorityEpoch:intent.body.authorityEpoch};
        }finally{await release();}
    }
}
