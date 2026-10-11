import {capturedEvidence} from '../recovery/PersistentEvidence.js';
import {open, mkdir, unlink, readFile, lstat, realpath} from 'node:fs/promises';
import {renameSync, openSync, fsyncSync, closeSync} from 'node:fs';
import {dirname, resolve, relative, isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {scheduledEntryIdentity} from './ScheduledEntryIdentity.js';
import {ledgerSnapshot, validateLedgerSnapshot, entryConsumption} from './ScheduledEntryLedgerContract.js';
import {assertMigrationStartup} from '../recovery/CleanLedgerV1Migration.js';
import {executionEraStartup} from '../recovery/ExecutionEraContract.js';

const inside = (root,path) => { const r=relative(root,path); return !r || (!r.startsWith('..') && !isAbsolute(r)); };
const result = (status,record) => Object.freeze({status, ...(record ? {record} : {})});

// Isolated, single-host core. It never grants execution authority. Creation is
// explicit (create:true is bootstrap-only, never a recovery policy); ordinary
// reopening of a missing ledger must not erase history. Invalid identity/context
// arguments throw synchronously; storage failures return a fail-closed status.
export default class ScheduledEntryLedgerRepository {
    constructor({path, publicRoot=resolve('public'), create=false, hook=()=>{}, operations={}} = {}) {
        if (typeof path !== 'string' || !isAbsolute(path) || inside(resolve(publicRoot),resolve(path)))
            throw new TypeError('PRIVATE_SCHEDULED_ENTRY_PATH_REQUIRED');
        Object.assign(this,{path:resolve(path), publicRoot:resolve(publicRoot), create, hook});
        this.fs = {open,mkdir,unlink,readFile,lstat,realpath,renameSync,openSync,fsyncSync,closeSync,...operations};
        this.status = 'UNAVAILABLE';
        this.snapshot = null;
        this.queue = Promise.resolve();
        this.closed = false;
    }

    initialize() {
        if (!this.initializing) this.initializing = this.initializeOnce();
        return this.initializing;
    }

    async initializeOnce() {
        if (this.closed) return;
        try {
            if(executionEraStartup(this.path))throw Error('LEDGER_V2_REPOSITORY_REQUIRED');
            try {if(await assertMigrationStartup(this.path))throw Error('LEDGER_V2_REPOSITORY_REQUIRED');}
            catch(error){if(error.code!=='ENOENT')throw error;}
            try {if(capturedEvidence(await this.fs.readFile(this.path),{json:true}).value?.schemaVersion===2)throw Error('LEDGER_V2_REPOSITORY_REQUIRED');}
            catch(error){if(error.code!=='ENOENT')throw error;}
            // Never reopen protocol-v2 history through the legacy writer.
            try {await this.fs.lstat(this.path+'.wal');throw Error('LEDGER_V2_REPOSITORY_REQUIRED');}
            catch(error){if(error.code!=='ENOENT')throw error;}
            await this.fs.mkdir(dirname(this.path),{recursive:true});
            const directory = await this.fs.realpath(dirname(this.path));
            const publicPath = await this.fs.realpath(this.publicRoot).catch(()=>this.publicRoot);
            if (inside(publicPath,directory)) throw Error('PRIVATE_SCHEDULED_ENTRY_PATH_REQUIRED');
            try { this.lock = await this.fs.open(this.path+'.lock','wx',0o600); }
            catch (error) { if (error.code === 'EEXIST') { this.status='CONFLICT'; return; } throw error; }
            this.lockOwner=Object.freeze({version:1,pid:process.pid,processSession:randomUUID()});
            await this.lock.writeFile(JSON.stringify(this.lockOwner));
            await this.lock.sync();
            try { this.snapshot = await this.readSnapshot(); }
            catch (error) {
                if (error.code !== 'ENOENT' || this.create !== true) throw error;
                await this.writeSnapshot(ledgerSnapshot(),true);
            }
            this.status = 'READY';
        } catch (error) {
            if (this.status !== 'DURABILITY_UNCERTAIN') this.status='UNAVAILABLE';
            this.error=error.code || error.message;
        }
    }

    async readSnapshot() {
        const stat = await this.fs.lstat(this.path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw Error('LEDGER_NOT_REGULAR');
        return validateLedgerSnapshot(capturedEvidence(await this.fs.readFile(this.path),{json:true}).value);
    }

    enqueue(operation) {
        const pending = this.queue.then(async()=>{
            await this.initialize();
            if (this.closed) return result('UNAVAILABLE');
            if (this.status !== 'READY') return result(this.status);
            try {
                await this.verifySnapshot();
                return await operation();
            } catch (error) {
                if(error.code==='ENTRY_CHECK_REJECTED')return result('CONFLICT');
                if (this.status !== 'DURABILITY_UNCERTAIN') this.status='UNAVAILABLE';
                this.error=error.code || error.message;
                return result(this.status);
            }
        });
        this.queue = pending.catch(()=>{});
        return pending;
    }

    async verifySnapshot() {
        const disk = await this.readSnapshot();
        if (disk.checksum.value !== this.snapshot.checksum.value) throw Error('LEDGER_CHANGED_EXTERNALLY');
    }

    inspect(identity) {
        const key=scheduledEntryIdentity(identity).entryKey;
        return this.enqueue(()=>{
            const record=this.snapshot.entries.find(r=>r.identity.entryKey===key);
            return result(record ? 'ALREADY_CONSUMED' : 'UNCONSUMED',record);
        }).then(value=>value.status === 'CONFLICT' || value.status === 'DURABILITY_UNCERTAIN' ? result('UNAVAILABLE') : value);
    }

    consume(identity,context,{check=()=>true}={}) {
        // Copy/validate synchronously: queued callers cannot mutate their inputs.
        const record=entryConsumption(identity,context);
        return this.enqueue(async()=>{
            const existing=this.snapshot.entries.find(r=>r.identity.entryKey===record.identity.entryKey);
            if (existing) return result('ALREADY_CONSUMED',existing);
            if(!check())return result('CONFLICT');
            const next=ledgerSnapshot({...this.snapshot,ledgerId:this.snapshot.ledgerId,
                generation:this.snapshot.generation+1,entries:[...this.snapshot.entries,record]});
            await this.writeSnapshot(next,false,check);
            return result('CONSUMED',record);
        });
    }

    async writeSnapshot(next,creating=false,check=()=>true) {
        const temp=this.path+'.'+randomUUID()+'.tmp';
        let file;
        let replacing=false;
        try {
            file=await this.fs.open(temp,'wx',0o600);
            this.hook('opened');
            await file.writeFile(JSON.stringify(next)+'\n','utf8');
            this.hook('written');
            await file.sync();
            this.hook('flushed');
            await file.close(); file=null;
            this.hook('staged');
            if (creating) {
                try { await this.fs.lstat(this.path); throw Error('LEDGER_ALREADY_EXISTS'); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            } else await this.verifySnapshot();
            if (this.closed) throw Error('LEDGER_CLOSED');
            // Same durability primitives as DurableProgramRepository: no await
            // between final replacement, fsync and publication in memory.
            replacing=true;
            this.hook('before-replace');
            if(!check()){
                replacing=false;
                throw Object.assign(Error('ENTRY_CHECK_REJECTED'),{code:'ENTRY_CHECK_REJECTED'});
            }
            this.fs.renameSync(temp,this.path);
            this.hook('replaced');
            const fd=this.fs.openSync(this.path,'r+');
            try { this.fs.fsyncSync(fd); } finally { this.fs.closeSync(fd); }
            this.hook('durable');
            this.snapshot=next;
        } catch (error) {
            if (replacing) this.status='DURABILITY_UNCERTAIN';
            throw error;
        } finally {
            if (file) await file.close().catch(()=>{});
            await this.fs.unlink(temp).catch(()=>{});
        }
    }

    close() {
        if (!this.closing) {
            this.closed=true;
            this.closing=(async()=>{
                await this.initializing;
                await this.queue;
                if (this.lock) {
                    await this.lock.close(); this.lock=null;
                    // Never turn uncertain durability into a permissive restart.
                    // Reconciliation is intentionally outside this isolated core.
                    if (this.status !== 'DURABILITY_UNCERTAIN') await this.fs.unlink(this.path+'.lock');
                }
            })();
        }
        return this.closing;
    }
}
