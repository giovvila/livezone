import {open,realpath,readdir} from 'node:fs/promises';
import {dirname,basename,resolve,relative,isAbsolute} from 'node:path';
import {repositoryIdentity} from '../scheduler/ScheduledExecutionProvenance.js';
import {validateLedgerSnapshot} from '../scheduler/ScheduledEntryLedgerContract.js';
import {hash,seal,equal,envelope,inspectV2,fail} from '../scheduler/ScheduledEntryLedgerV2Protocol.js';
import {createLedgerV2Durability} from '../scheduler/LedgerV2Durability.js';
import {windowsLedgerDurability,helperSha256,gateSha256} from '../scheduler/WindowsLedgerDurability.js';
import {assertHost} from './WindowsRecoveryHost.js';
import {readEvidence} from './PersistentEvidence.js';
import {classifyMigrationNames} from './RecoveryNamespace.js';

const suffixes=['intent.stage','intent','base.stage','snapshot.stage','activation.stage','activated','completion.stage','completed'];
// Hashes bind exact bytes; invalid UTF-8 must not be silently normalized.
const ordinary=async(path,options={})=>{
    const captured=await evidence(path,{optional:options.optional,text:options.encoding!==null});
    return captured===null?null:options.encoding===null?captured.bytes:captured.text;
};
const evidence=(path,options={})=>readEvidence(path,{...options,
    ordinaryError:'LEDGER_V2_ORDINARY_FILE_REQUIRED',encodingError:'LEDGER_MIGRATION_ENCODING_UNPROVEN'});
export const migrationPath=(path,suffix)=>path+'.migration.'+suffix;
// The owner captures its staging stream as opaque byte evidence. It is never
// authoritative JSON: view()/durable() must verify the exact expected prefix
// and migration ordering before any resume or installation.
export async function migrationIntentStageEvidence(path) {
    await assertMigrationNamespace(path);
    const e=await evidence(migrationPath(path,'intent.stage'),{optional:true,text:false,maxBytes:16*1024*1024});
    return e===null?null:{hash:e.sha256,value:{migrationStage:true,byteLength:e.byteLength}};
}
const json=bytes=>{try{return JSON.parse(bytes);}catch{fail('LEDGER_MIGRATION_CORRUPT');}};
const bytes=value=>JSON.stringify(value)+'\n';
const prefix=(wanted,partial)=>Buffer.from(wanted).subarray(0,partial.length).equals(partial);
const signed=value=>{const {checksum,...payload}=value??{};if(checksum!==hash(payload))fail('LEDGER_MIGRATION_CHECKSUM');return payload;};
export function validateMigrationIntent(path,value) {
    const p=signed(value),snapshot=validateLedgerSnapshot(json(p.original?.bytes));
    if(p.schemaVersion!==1||p.state!=='INTENT'||p.path!==resolve(path)||p.repositoryId!==repositoryIdentity(path)||
        p.original.hash!==hash(p.original.bytes)||p.original.generation!==snapshot.generation||
        !equal(p.target,envelope(path,snapshot))||p.targetHash!==hash(bytes(p.target))||
        p.markerHash!==hash(p.markerBytes)||p.authority.hash!==hash(p.authority.bytes)||
        p.authority.epoch!==json(p.authority.bytes).epoch)fail('LEDGER_MIGRATION_INTENT_INVALID');
    const {transactionId,...seed}=p;
    if(transactionId!==hash(seed))fail('LEDGER_MIGRATION_TRANSACTION_INVALID');
    return p;
}
const decision=(intent,state)=>seal({schemaVersion:1,state,transactionId:intent.transactionId,intentHash:hash(seal(intent)),
    targetHash:intent.targetHash,ledgerId:intent.target.snapshot.ledgerId,generation:intent.target.snapshot.generation,
    decision:state==='COMPLETED'?'V2_ONLY_AFTER_COMPLETION':'V2_INSTALLED_NO_EXECUTION'});
export function validateMigrationCompletion(path,intentValue,activationValue,completionValue) {
    const intent=validateMigrationIntent(path,intentValue);
    if(!equal(activationValue,decision(intent,'ACTIVATED'))||!equal(completionValue,decision(intent,'COMPLETED')))
        fail('LEDGER_MIGRATION_COMPLETION_INVALID');
    return intent;
}
export async function migrationArtifacts(path) {
    await assertMigrationNamespace(path);
    return Object.fromEntries(await Promise.all(suffixes.map(async s=>[s,await ordinary(migrationPath(path,s),{optional:true,encoding:s.endsWith('.stage')?null:'utf8'})])));
}
export async function assertMigrationNamespace(path) {
    let names;try{names=await readdir(dirname(path));}catch(e){if(e.code==='ENOENT')return;throw e;}
    const classified=classifyMigrationNames(names,basename(path),suffixes);
    if(classified.some(n=>n.kind==='UNKNOWN'))fail('LEDGER_MIGRATION_UNKNOWN_ARTIFACT');
    if(classified.some(n=>n.kind==='FOREIGN_STAGE'))fail('LEDGER_MIGRATION_FOREIGN_STAGE');
}
// Both runtime writers use this before acquiring a lock. No offline mutation here.
export async function assertMigrationStartup(path) {
    let a;
    try{a=await migrationArtifacts(path);}catch(e){if(e.code==='ENOENT')return false;throw e;}
    if(Object.values(a).every(v=>v===null))return false;
    if(!a.intent||!a.activated||!a.completed||suffixes.some(s=>s.endsWith('.stage')&&a[s]!==null))fail('LEDGER_MIGRATION_RESUME_REQUIRED');
    const intent=validateMigrationCompletion(path,json(a.intent),json(a.activated),json(a.completed));
    if(a.activated!==bytes(decision(intent,'ACTIVATED'))||a.completed!==bytes(decision(intent,'COMPLETED')))fail('LEDGER_MIGRATION_COMPLETION_INVALID');
    const canonical=await ordinary(path,{optional:true});
    if(canonical===null)fail('LEDGER_MIGRATION_CANONICAL_MISSING');
    if(await ordinary(path+'.bootstrap',{optional:true})!==intent.markerBytes)fail('LEDGER_MIGRATION_PROVENANCE_CHANGED');
    const value=json(canonical),current=value.schemaVersion===2?value.snapshot:null;
    validateLedgerSnapshot(current);
    if(value.repositoryId!==intent.repositoryId||current.ledgerId!==intent.target.snapshot.ledgerId||
        current.generation<intent.original.generation||intent.target.snapshot.entries.some(old=>
            !current.entries.some(entry=>equal(entry,old))))fail('LEDGER_MIGRATION_HISTORY_CHANGED');
    return true;
}

// No migration writer lock: the canonical offline proof plus exclusive 8080
// reservation serialize maintenance. A crash releases the OS reservation.
// Dependency injection is only for isolated host/durability failure tests.
export class CleanLedgerV1Migration {
    constructor({path,authorityPath,scheduledPath,root,host,expected,hook=()=>{},native=windowsLedgerDurability,durability=createLedgerV2Durability()}) {
        Object.assign(this,{path:resolve(path),authorityPath,scheduledPath,root:resolve(root),host,expected,hook,native,durability});
        for(const p of [this.path,this.authorityPath]){
            const rel=relative(this.root,resolve(p));
            if(!rel||rel.startsWith('..')||isAbsolute(rel))fail('LEDGER_MIGRATION_REPOSITORY_MISMATCH');
        }
    }
    async hostState() {
        const h=await this.host.inspect();let checked=h;
        if(this.reserved){
            if(!Array.isArray(h.ports)||h.ports.some(p=>p.LocalPort!==8080||p.OwningProcess!==process.pid))fail('MIGRATION_RESERVATION_PORT_CONFLICT');
            checked={...h,ports:[]};
        }
        assertHost(checked,this.root,{expected:this.expected});
        if((await this.host.proveOffline()).absent!==true)fail('CANONICAL_OFFLINE_PROOF_REQUIRED');
        return h;
    }
    async storage() {
        for(const p of [this.root,dirname(this.path),dirname(this.authorityPath)])
            if(repositoryIdentity(await realpath(p))!==repositoryIdentity(p))fail('LEDGER_MIGRATION_ALIASED_REPOSITORY');
        const capability=this.native.capability(dirname(this.path));
        return {helperSha256,gateSha256,version:'1.0.0',protocol:1,capability};
    }
    async view() {
        const lock=await ordinary(this.path+'.lock',{optional:true});
        if(lock!==null){if(json(lock).version===1)fail('LEGACY_LEDGER_LOCK_UNVERIFIABLE');fail('LEDGER_V2_OFFLINE_RECONCILIATION_REQUIRED');}
        const a=await migrationArtifacts(this.path),canonicalEvidence=await evidence(this.path,{optional:true});
        const canonical=canonicalEvidence?.text??null;
        const wal=await ordinary(this.path+'.wal',{optional:true});
        const markerEvidence=await evidence(this.path+'.bootstrap',{optional:true}),marker=markerEvidence?.text??null;
        const authorityEvidence=await evidence(this.authorityPath),authority=authorityEvidence.text,epoch=json(authority).epoch;
        if(!Number.isSafeInteger(epoch)||epoch<1)fail('AUTHORITY_EPOCH_REQUIRED');
        if(canonical===null){if(wal!==null||Object.values(a).some(v=>v!==null))fail('LEDGER_MIGRATION_CANONICAL_MISSING');return {mode:'ABSENT',a};}
        const m=marker===null?null:json(marker);
        if(m?.version!==1||!Number.isSafeInteger(m.authorityEpoch)||m.authorityEpoch<1||m.authorityEpoch>epoch)fail('BOOTSTRAP_MARKER_INCONSISTENT');
        if(Object.keys(m).sort().join(',')!=='authorityEpoch,version')fail('BOOTSTRAP_MARKER_INCONSISTENT');
        let intent;
        if(a.intent)intent=validateMigrationIntent(this.path,json(a.intent));
        else {
            const value=json(canonical);
            if(value.schemaVersion===2){
                if(Object.values(a).some(v=>v!==null))fail('LEDGER_MIGRATION_INTENT_MISSING');
                if(wal===null)fail('LEDGER_V2_WAL_MISSING');
                const state=await inspectV2(this.path);if(state.owner||state.pending)fail('LEDGER_V2_UNCLOSED_SESSION');
                return {mode:'V2',state,a,canonical,wal,marker};
            }
            const snapshot=validateLedgerSnapshot(value);
            if(wal!==null||suffixes.filter(s=>s!=='intent.stage').some(s=>a[s]!==null))fail('LEDGER_MIGRATION_UNRECOGNIZED_V2');
            const seed={schemaVersion:1,state:'INTENT',path:this.path,repositoryId:repositoryIdentity(this.path),
                root:this.root,rootId:repositoryIdentity(this.root),original:{bytes:canonical,hash:canonicalEvidence.sha256,generation:snapshot.generation},
                markerBytes:marker,markerHash:markerEvidence.sha256,authority:{path:this.authorityPath,bytes:authority,hash:authorityEvidence.sha256,epoch},
                target:envelope(this.path,snapshot),targetHash:hash(bytes(envelope(this.path,snapshot))),native:await this.storage()};
            intent={...seed,transactionId:hash(seed)};
        }
        const target=bytes(intent.target),base=bytes(seal({schemaVersion:2,type:'BASE',previous:null,
            data:{repositoryId:intent.repositoryId,snapshot:intent.target.snapshot,namespaceDurability:'DIRECTORY_SYNCED'}}));
        if(intent.root!==this.root||intent.rootId!==repositoryIdentity(this.root)||intent.authority.path!==this.authorityPath||marker!==intent.markerBytes)fail('LEDGER_MIGRATION_PROVENANCE_CHANGED');
        if(a.completed!==null){
            await assertMigrationStartup(this.path);
            const state=await inspectV2(this.path);if(state.owner||state.pending)fail('LEDGER_V2_UNCLOSED_SESSION');
            return {mode:'V2',migrationState:'COMPLETED',intent,state,a,canonical,wal,marker};
        }
        if(authority!==intent.authority.bytes)fail('LEDGER_MIGRATION_AUTHORITY_CHANGED');
        if(canonical!==intent.original.bytes&&canonical!==target)fail('LEDGER_MIGRATION_V1_CHANGED');
        if(wal!==null&&wal!==base)fail('LEDGER_MIGRATION_BASE_CHANGED');
        if(canonical===target&&wal!==base)fail('LEDGER_MIGRATION_BASE_MISSING');
        const expected={'intent.stage':bytes(seal(intent)),'base.stage':base,'snapshot.stage':target,
            'activation.stage':bytes(decision(intent,'ACTIVATED')),'completion.stage':bytes(decision(intent,'COMPLETED'))};
        for(const [s,wanted] of Object.entries(expected))if(a[s]!==null&&!prefix(wanted,a[s]))fail('LEDGER_MIGRATION_STAGE_CORRUPT');
        if(a.activated!==null&&(a.activated!==expected['activation.stage']||canonical!==target||wal!==base))fail('LEDGER_MIGRATION_ACTIVATION_INVALID');
        if((a['base.stage']!==null||a['snapshot.stage']!==null||a['activation.stage']!==null||a['completion.stage']!==null)&&a.intent===null)fail('LEDGER_MIGRATION_INTENT_MISSING');
        if((a['activation.stage']!==null||a['completion.stage']!==null)&&canonical!==target)fail('LEDGER_MIGRATION_STAGE_ORDER');
        if(a['completion.stage']!==null&&a.activated===null)fail('LEDGER_MIGRATION_STAGE_ORDER');
        return {mode:'V1',intent,a,canonical,wal,marker,target,base,migrationState:a.activated?'ACTIVATED':canonical===target?'V2_INSTALLED':wal?'BASE_DURABLE':a.intent?'INTENT_DURABLE':a['intent.stage']!==null?'INTENT_STAGING':'V1_STABLE'};
    }
    async inspect() {
        try {
            await this.hostState();
            const v=await this.view();
            if(v.mode==='V1'&&(await ordinary(this.authorityPath+'.lock',{optional:true})!==null||
                this.scheduledPath&&await ordinary(this.scheduledPath+'.lock',{optional:true})!==null))fail('LOCK_RECONCILIATION_REQUIRED');
            const nativeCapability=v.mode==='ABSENT'?'NOT_REQUIRED':await this.storage();
            return {ledgerMode:v.mode==='V1'&&v.canonical===v.target?'V2_PENDING':v.mode,migrationState:v.migrationState??(v.mode==='ABSENT'?'ABSENT':v.mode==='V2'?'V2_STABLE':'V1_STABLE'),
                nativeCapability,migrationRequired:v.mode==='V1',migrationResumable:v.mode==='V1'&&v.migrationState!=='V1_STABLE',blockingReason:null,
                transactionId:v.intent?.transactionId??null};
        }catch(e){return {ledgerMode:'BLOCKED',migrationState:'UNPROVEN',nativeCapability:'UNPROVEN',migrationRequired:false,migrationResumable:false,blockingReason:e.code??e.message};}
    }
    async guard() {
        await this.hostState();
        if(await ordinary(this.authorityPath+'.lock',{optional:true})!==null||this.scheduledPath&&await ordinary(this.scheduledPath+'.lock',{optional:true})!==null)fail('LOCK_RECONCILIATION_REQUIRED');
        const v=await this.view();
        if(v.mode==='ABSENT')fail('LEDGER_MIGRATION_EXISTING_HISTORY_REQUIRED');
        const native=await this.storage();
        if(v.mode!=='V2'&&!equal(native,v.intent.native))fail('LEDGER_V2_NAMESPACE_DURABILITY_UNPROVEN');
        return v;
    }
    async durable(stage,destination,wanted,phase,{replaceV1=false,authorize}={}) {
        const initial=await this.guard();
        if(phase==='intent'&&initial.mode!=='V2'&&wanted!==bytes(seal(initial.intent)))fail('LEDGER_MIGRATION_FRESH_HASH_CHANGED');
        if(Buffer.byteLength(wanted)>64*1024*1024)fail('LEDGER_MIGRATION_ARTIFACT_TOO_LARGE');
        const saved=await ordinary(destination,{optional:true}),partial=await ordinary(stage,{optional:true,encoding:null});
        if(saved===wanted){if(partial!==null)fail('LEDGER_MIGRATION_DUPLICATE_STAGE');await this.durability.syncFile(destination);return;}
        if(saved!==null&&!replaceV1)fail('LEDGER_MIGRATION_DESTINATION_CHANGED');
        if(partial!==null&&!prefix(wanted,partial))fail('LEDGER_MIGRATION_STAGE_CORRUPT');
        if(authorize)await authorize();
        const file=await open(stage,partial===null?'wx':'a',0o600);
        try {
            await this.hook(phase+'-opened');
            if(authorize)await authorize();
            const remaining=Buffer.from(wanted).subarray(partial?.length??0),cut=Math.max(1,Math.floor(remaining.length/2));
            await file.writeFile(remaining.subarray(0,cut));await this.hook(phase+'-partial');
            if(authorize)await authorize();
            await file.writeFile(remaining.subarray(cut));await this.hook(phase+'-written');
            await file.sync();await this.hook(phase+'-flushed');
        }finally{await file.close();}
        this.durability.sync(stage);await this.hook(phase+'-staged');
        const fresh=await this.guard();
        if(replaceV1&&fresh.canonical!==fresh.intent.original.bytes&&fresh.canonical!==wanted)fail('LEDGER_MIGRATION_V1_CHANGED');
        await this.hook(phase+'-installing');
        if(!Buffer.from(wanted).equals(await ordinary(stage,{encoding:null})))fail('LEDGER_MIGRATION_STAGE_CORRUPT');
        if(authorize)await authorize();
        this.durability.replace(stage,destination);await this.hook(phase+'-installed');
        await this.durability.syncFile(destination);await this.hook(phase+'-durable');
    }
    async offline(action) {
        // Legacy lock precedence before host reservations or file mutation.
        await this.view();
        await this.hostState();
        const release=await this.host.reserve();
        this.reserved=true;
        try{return await action();}finally{this.reserved=false;await release();}
    }
    async prepare() {return this.offline(()=>this.prepareHeld());}
    async prepareHeld({authorize}={}) {
        const v=await this.guard();if(v.mode==='V2')return this.inspect();
        await this.hook('before-intent');await this.guard();
        await this.durable(migrationPath(this.path,'intent.stage'),migrationPath(this.path,'intent'),bytes(seal(v.intent)),'intent',{authorize});
        await this.hook('after-intent');return this.inspect();
    }
    async start({authorize}={}) {
        return this.offline(()=>this.startHeld({authorize}));
    }
    // Caller holds the host reservation for the complete Start workflow.
    async startHeld({authorize}={}) {
        if(authorize)await authorize();
        await this.prepareHeld({authorize});let v=await this.guard();
        if(v.mode==='V2')return this.inspect();
        await this.durable(migrationPath(this.path,'base.stage'),this.path+'.wal',v.base,'base',{authorize});
        await this.durable(migrationPath(this.path,'snapshot.stage'),this.path,v.target,'snapshot',{replaceV1:true,authorize});
        await this.hook('before-activation');
        await this.durable(migrationPath(this.path,'activation.stage'),migrationPath(this.path,'activated'),bytes(decision(v.intent,'ACTIVATED')),'activation',{authorize});
        await this.hook('after-activation');
        await this.durable(migrationPath(this.path,'completion.stage'),migrationPath(this.path,'completed'),bytes(decision(v.intent,'COMPLETED')),'completion',{authorize});
        await this.hook('after-completion');await assertMigrationStartup(this.path);return this.inspect();
    }
}
