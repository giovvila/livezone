import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import LegacyRepository from './ScheduledEntryLedgerRepository.js';
import {ledgerSnapshot,validateLedgerSnapshot} from './ScheduledEntryLedgerContract.js';
import {repositoryIdentity} from './ScheduledExecutionProvenance.js';
import {createLedgerV2Durability} from './LedgerV2Durability.js';
import {append,decodeEnvelope,directorySync,equal,fail,hash,inspectV2,install,makeLock,ordinary,terminalShutdown,validateV2Lock} from './ScheduledEntryLedgerV2Protocol.js';
import {assertMigrationStartup} from '../recovery/CleanLedgerV1Migration.js';

// Explicit opt-in. A v2 envelope/WAL must never fall back to the v1 writer.
export default class ScheduledEntryLedgerV2Repository extends LegacyRepository {
    constructor({authority,migrateV1=false,syncDirectory=directorySync,...options}={}) {
        super(options);
        Object.assign(this,{authority,migrateV1,syncDirectory});
        this.durability=createLedgerV2Durability({syncDirectory,fs:this.fs});
        this.records=[];
        this.protocolVersion=2;
    }
    get protocolOptions(){return {hook:this.hook,fs:this.fs,syncDirectory:this.syncDirectory,durability:this.durability};}
    async initializeOnce() {
        if(this.closed)return;
        try {
            const oldLock=await ordinary(this.path+'.lock',{optional:true});
            if(oldLock!==null) {
                const owner=JSON.parse(oldLock);
                if(owner.version===1)fail('LEGACY_LEDGER_LOCK_UNVERIFIABLE');
                validateV2Lock(owner,this.path);
                this.status='CONFLICT';this.error='LEDGER_V2_OFFLINE_RECONCILIATION_REQUIRED';return;
            }
            await assertMigrationStartup(this.path);
            await this.durability.ensureDirectory(dirname(this.path));
            if(repositoryIdentity(await this.fs.realpath(dirname(this.path)))!==repositoryIdentity(dirname(this.path))) fail('LEDGER_V2_ALIASED_PATH');
            this.durability.sync(this.path);
            const bytes=await ordinary(this.path,{optional:true}),wal=await ordinary(this.path+'.wal',{optional:true});
            let snapshot;
            if(wal!==null) {
                const state=await inspectV2(this.path);
                if(state.owner || state.pending)fail('LEDGER_V2_UNCLOSED_SESSION');
                snapshot=state.current;this.records=state.records;
            } else if(bytes!==null) {
                const value=JSON.parse(bytes);
                if(value.schemaVersion===2)fail('LEDGER_V2_WAL_MISSING');
                fail(this.migrateV1?'LEDGER_V2_CONTROLLED_MIGRATION_REQUIRED':'LEDGER_V2_EXPLICIT_MIGRATION_REQUIRED');
            } else {
                if(!this.create)fail('LEDGER_V2_MISSING');
                snapshot=ledgerSnapshot();
            }
            this.lockOwner=makeLock(this.path,snapshot,this.authority??{});
            this.lock=await this.fs.open(this.path+'.lock','wx',0o600);
            // From acquisition onward errors retain the reservation and evidence.
            this.status='DURABILITY_UNCERTAIN';
            await this.lock.writeFile(JSON.stringify(this.lockOwner));await this.lock.sync();this.durability.sync(this.path);
            if(await ordinary(this.path,{optional:true})!==bytes || await ordinary(this.path+'.wal',{optional:true})!==wal)
                fail('LEDGER_V2_STARTUP_RACE');
            if(wal===null) {
                await append(this.path,this.records,'BASE',{repositoryId:repositoryIdentity(this.path),snapshot,
                    namespaceDurability:this.syncDirectory(this.path)},this.protocolOptions);
                await install(this.path,snapshot,'bootstrap',this.protocolOptions);
            }
            await append(this.path,this.records,'BEGIN',this.lockOwner,this.protocolOptions);
            await inspectV2(this.path);
            this.snapshot=snapshot;this.status='READY';
        } catch(e) {
            if(this.status!=='DURABILITY_UNCERTAIN')this.status='UNAVAILABLE';
            this.error=e.code??e.message;
        }
    }
    async readSnapshot(){return decodeEnvelope(this.path,JSON.parse(await ordinary(this.path)));}
    async verifySnapshot() {
        const state=await inspectV2(this.path);
        if(!equal(state.owner,this.lockOwner) || state.pending || !equal(state.current,this.snapshot) ||
            state.records.at(-1)?.checksum!==this.records.at(-1)?.checksum)fail('LEDGER_V2_CHANGED_EXTERNALLY');
        if(!equal(JSON.parse(await ordinary(this.path+'.lock')),this.lockOwner))fail('LEDGER_V2_LOCK_CHANGED');
    }
    async writeSnapshot(next,creating=false,check=()=>true) {
        if(creating)fail('LEDGER_V2_BOOTSTRAP_INTERNAL_ONLY');
        if(this.closed || !check())throw Object.assign(Error('ENTRY_CHECK_REJECTED'),{code:'ENTRY_CHECK_REJECTED'});
        const added=next.entries.filter(e=>!this.snapshot.entries.some(old=>old.identity.entryKey===e.identity.entryKey));
        if(added.length!==1 || added[0].authorityEpoch!==this.lockOwner.authorityEpoch ||
            added[0].authorityProcessSession!==this.lockOwner.authorityProcessSession)fail('LEDGER_V2_AUTHORITY_MISMATCH');
        const intent={transactionId:randomUUID(),entryKey:added[0].identity.entryKey,owner:this.lockOwner,
            previousGeneration:this.snapshot.generation,previousHash:hash(this.snapshot),nextGeneration:next.generation,
            nextHash:hash(next),next,createdAt:new Date().toISOString()};
        this.hook('before-intent');
        // Any subsequent failure is sticky, including partial intent writes.
        this.status='DURABILITY_UNCERTAIN';
        await append(this.path,this.records,'INTENT',intent,this.protocolOptions);
        // The intent is irrevocable. Lost eligibility suppresses capture via the
        // runtime's post-consume gate; it must not roll consumption back.
        await install(this.path,next,intent.transactionId,this.protocolOptions);
        await append(this.path,this.records,'COMMIT',{transactionId:intent.transactionId,nextHash:intent.nextHash},this.protocolOptions);
        this.hook('before-publication');this.snapshot=next;this.status='READY';this.hook('published');
    }
    async verifyTerminal() {
        const state=await inspectV2(this.path);
        if(!terminalShutdown(state,this.lockOwner)||!equal(state.current,this.snapshot)||
            state.records.at(-1)?.checksum!==this.records.at(-1)?.checksum||
            !equal(JSON.parse(await ordinary(this.path+'.lock')),this.lockOwner))fail('LEDGER_V2_TERMINAL_CHANGED');
    }
    finalize() {
        if(!this.finalizing) {
            // Freeze admission synchronously, including callers already queued.
            // An in-flight irrevocable intent drains before END is appended.
            this.closed=true;
            this.finalizing=(async()=>{
                await this.initializing;await this.queue;
                if(!this.lock)return;
                if(this.status!=='READY')fail('LEDGER_V2_SHUTDOWN_RECOVERY_REQUIRED');
                await this.verifySnapshot();this.status='DURABILITY_UNCERTAIN';
                await append(this.path,this.records,'END',{processSession:this.lockOwner.processSession,
                    snapshotHash:hash(this.snapshot),recovered:false},this.protocolOptions);
                await this.verifyTerminal();this.status='TERMINAL';
                this.hook('shutdown-durable');
            })();
        }
        return this.finalizing;
    }
    close() {
        if(!this.closing) {
            this.closed=true;
            this.closing=(async()=>{
                await this.initializing;await this.queue;
                if(!this.lock)return;
                try {
                    if(this.status==='READY'||this.status==='TERMINAL') {
                        await this.finalize();await this.verifyTerminal();
                        this.hook('before-lock-release');await this.verifyTerminal();
                        this.status='DURABILITY_UNCERTAIN';
                        await this.lock.close();this.lock=null;
                        await this.durability.remove(this.path+'.lock');this.status='CLOSED';
                        this.hook('lock-released');
                    }
                } finally {if(this.lock){await this.lock.close();this.lock=null;}}
            })();
        }
        return this.closing;
    }
}
