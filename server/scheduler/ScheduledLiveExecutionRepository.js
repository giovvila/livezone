import {
    open,
    mkdir,
    unlink,
    realpath,
    lstat,
    readFile
} from 'node:fs/promises';

import {
    renameSync,
    openSync,
    fsyncSync,
    closeSync
} from 'node:fs';

import {
    dirname,
    resolve,
    relative,
    isAbsolute,
    basename,
    join
} from 'node:path';

import {randomUUID} from 'node:crypto';
import {digest, repositoryIdentity, validateLock, journalEnvelope, validateJournal, refuse}
    from './ScheduledExecutionProvenance.js';

const MAX_BYTES=256*1024;

const fail=code=>{
    throw Object.assign(new Error(code),{code});
};

function inside(root,path){
    const relation=relative(root,path);

    return !relation ||
        (!relation.startsWith('..') &&
         !isAbsolute(relation));
}

export default class ScheduledLiveExecutionRepository {

    constructor({
        path,
        publicRoot=resolve('public'),
        authority,
        hook=()=>{}
    }={}){
        if(
            typeof path!=='string' ||
            !isAbsolute(path) ||
            inside(resolve(publicRoot),resolve(path))
        ){
            fail('PRIVATE_SCHEDULED_LIVE_PATH_REQUIRED');
        }

        this.path=resolve(path);
        this.publicRoot=resolve(publicRoot);
        this.hook=hook;
        this.authority=authority;

        this.status='UNAVAILABLE';
        this.record=null;
        this.queue=Promise.resolve();
        this.closed=false;
    }

    assertAuthority(){
        const a=this.authority;
        if (!a || a.available!==true || a.closed || !isAbsolute(a.path || '') ||
            !Number.isSafeInteger(a.authorityEpoch) || a.authorityEpoch<1 ||
            typeof a.authorityProcessSession!=='string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(a.authorityProcessSession))
            refuse('SCHEDULED_AUTHORITY_UNAVAILABLE');
        if (this.owner && (this.owner.authorityEpoch!==a.authorityEpoch ||
            this.owner.authorityProcessSession!==a.authorityProcessSession ||
            this.owner.authorityId!==repositoryIdentity(a.path)))
            refuse('SCHEDULED_AUTHORITY_CHANGED');
    }

    async initialize(){
        if(this.initializing)
            return this.initializing;

        this.initializing=this.initializeOnce();

        return this.initializing;
    }

    async initializeOnce(){
        let file;

        try{
            await this.authority?.ready;
            this.assertAuthority();
            if(this.closed) return;
            await mkdir(
                dirname(this.path),
                {recursive:true}
            );

            const directory=
                await realpath(dirname(this.path));

            const publicPath=
                await realpath(this.publicRoot)
                    .catch(()=>this.publicRoot);

            if(inside(publicPath,directory))
                fail('PRIVATE_SCHEDULED_LIVE_PATH_REQUIRED');

            this.repositoryId=repositoryIdentity(join(directory,basename(this.path)));

            this.lock=await open(
                this.path+'.lock',
                'wx',
                0o600
            );

            this.assertAuthority();
            this.owner={schemaVersion:2,repositoryId:this.repositoryId,
                processSession:randomUUID(),processId:process.pid,
                authorityEpoch:this.authority.authorityEpoch,
                authorityProcessSession:this.authority.authorityProcessSession,
                authorityId:repositoryIdentity(this.authority.path),
                createdAt:new Date().toISOString(),initialJournalHash:null};

            try{
                if((await lstat(this.path)).isSymbolicLink())
                    fail('SCHEDULED_LIVE_TRANSACTION_CORRUPT');

                file=await open(this.path,'r');
            }
            catch(error){
                if(error.code==='ENOENT'){
                    await this.installLock();
                    this.status='READY';
                    return;
                }

                throw error;
            }

            const stat=await file.stat();

            if(!stat.isFile() || stat.size>MAX_BYTES)
                fail('SCHEDULED_LIVE_TRANSACTION_CORRUPT');

            const buffer=Buffer.alloc(MAX_BYTES+1);

            let size=0;

            while(size<buffer.length){
                const result=
                    await file.read(
                        buffer,
                        size,
                        buffer.length-size,
                        null
                    );

                if(!result.bytesRead)
                    break;

                size+=result.bytesRead;
            }

            if(size>MAX_BYTES)
                fail('SCHEDULED_LIVE_TRANSACTION_CORRUPT');

            const bytes=buffer.subarray(0,size);
            const journal=JSON.parse(bytes.toString('utf8'));
            const envelope=validateJournal(journal,this.repositoryId);
            const previous=journal.provenance;
            if(previous.authorityId!==this.owner.authorityId ||
                previous.authorityEpoch>this.owner.authorityEpoch ||
                (previous.authorityEpoch===this.owner.authorityEpoch &&
                 previous.authorityProcessSession!==this.owner.authorityProcessSession))
                refuse('SCHEDULED_JOURNAL_AUTHORITY_MISMATCH');
            this.owner.initialJournalHash=digest(bytes);
            await this.installLock();

            this.record=envelope.record;
            this.status='READY';
        }
        catch(error){
            this.record=null;
            this.error=error.code || error.message;

            this.status=
                error.code==='EEXIST'
                    ? 'LOCKED'
                    : 'CORRUPT';
        }
        finally{
            if(file)
                await file.close().catch(()=>{});
        }
    }

    async installLock(){
        this.assertAuthority();
        validateLock(this.owner,this.repositoryId);
        this.lockBytes=JSON.stringify(this.owner);
        await this.lock.writeFile(this.lockBytes);
        await this.lock.sync();
        this.assertAuthority();
    }

    write(record){
        const run=
            this.queue.then(
                ()=>this.writeOnce(record)
            );

        this.queue=run.catch(()=>{});

        return run;
    }

    async writeOnce(record){
        this.assertAuthority();
        if(
            this.closed ||
            this.status!=='READY' ||
            !this.lock
        ){
            fail('SCHEDULED_LIVE_TRANSACTION_UNAVAILABLE');
        }

        const envelope=
            journalEnvelope(record,this.owner);

        const bytes=Buffer.from(
            JSON.stringify(envelope)+'\n'
        );

        if(bytes.length>MAX_BYTES)
            fail('SCHEDULED_LIVE_TRANSACTION_TOO_LARGE');

        const temp=
            this.path+'.'+randomUUID()+'.tmp';

        let file;
        let replacing=false;

        try{
            file=await open(temp,'wx',0o600);

            this.hook('opened');

            let offset=0;

            while(offset<bytes.length){
                const result=
                    await file.write(
                        bytes,
                        offset,
                        bytes.length-offset,
                        null
                    );

                if(!result.bytesWritten)
                    fail('SCHEDULED_LIVE_TRANSACTION_SHORT_WRITE');

                offset+=result.bytesWritten;
            }

            this.hook('written');

            await file.sync();

            this.hook('flushed');

            await file.close();
            file=null;

            this.hook('staged');

            if(this.closed)
                fail('SCHEDULED_LIVE_TRANSACTION_UNAVAILABLE');

            this.hook('before-replace');
            this.assertAuthority();
            if(await readFile(this.path+'.lock','utf8')!==this.lockBytes)
                refuse('SCHEDULED_LOCK_CHANGED');
            this.assertAuthority();

            replacing=true;

            renameSync(temp,this.path);

            this.hook('replaced');

            const fd=openSync(this.path,'r+');

            try{
                fsyncSync(fd);
            }
            finally{
                closeSync(fd);
            }

            this.record=envelope.transaction.record;

            this.hook('installed');

            return this.record;
        }
        catch(error){
            if(replacing)
                this.status='RECOVERY_BLOCKED';

            throw error;
        }
        finally{
            if(file)
                await file.close().catch(()=>{});

            await unlink(temp).catch(()=>{});
        }
    }

    async close(){
        if(this.closed)
            return;

        this.closed=true;

        await this.initializing;
        await this.queue;

        if(this.lock){
            await this.lock.close();
            this.lock=null;
            // Never remove a replacement lock belonging to another session.
            const bytes=await readFile(this.path+'.lock','utf8').catch(()=>null);
            if(bytes===(this.lockBytes ?? ''))
                await unlink(this.path+'.lock').catch(()=>{});
        }
    }
}
