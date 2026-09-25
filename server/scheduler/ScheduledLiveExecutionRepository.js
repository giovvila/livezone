import {
    open,
    mkdir,
    unlink,
    realpath,
    lstat
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
    isAbsolute
} from 'node:path';

import {randomUUID} from 'node:crypto';

import {
    scheduledLiveTransactionEnvelope,
    validateScheduledLiveTransactionEnvelope
} from './ScheduledLiveExecutionTransaction.js';

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

        this.status='UNAVAILABLE';
        this.record=null;
        this.queue=Promise.resolve();
        this.closed=false;
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

            this.lock=await open(
                this.path+'.lock',
                'wx',
                0o600
            );

            await this.lock.writeFile(
                JSON.stringify({
                    version:1,
                    processSession:randomUUID()
                })
            );

            await this.lock.sync();

            try{
                if((await lstat(this.path)).isSymbolicLink())
                    fail('SCHEDULED_LIVE_TRANSACTION_CORRUPT');

                file=await open(this.path,'r');
            }
            catch(error){
                if(error.code==='ENOENT'){
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

            const envelope=
                validateScheduledLiveTransactionEnvelope(
                    JSON.parse(
                        buffer
                            .subarray(0,size)
                            .toString('utf8')
                    )
                );

            this.record=envelope.record;
            this.status='READY';
        }
        catch(error){
            this.record=null;

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

    write(record){
        const run=
            this.queue.then(
                ()=>this.writeOnce(record)
            );

        this.queue=run.catch(()=>{});

        return run;
    }

    async writeOnce(record){
        if(
            this.closed ||
            this.status!=='READY' ||
            !this.lock
        ){
            fail('SCHEDULED_LIVE_TRANSACTION_UNAVAILABLE');
        }

        const envelope=
            scheduledLiveTransactionEnvelope(record);

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

            this.record=envelope.record;

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

            await unlink(
                this.path+'.lock'
            ).catch(()=>{});
        }
    }
}
