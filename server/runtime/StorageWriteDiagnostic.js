import {open,unlink,stat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';

// Explicit administrative diagnostic. Never imported or called by readiness.
// CREATE_DELETE is scoped to this process/path/time, not a durability proof.
export async function probeStorageWriteability(directory,{authorizeStorageProbe=false,
    operations={open,unlink,stat}}={}){
    if(authorizeStorageProbe!==true)throw new Error('STORAGE_PROBE_AUTHORIZATION_REQUIRED');
    if(typeof directory!=='string'||!isAbsolute(directory))throw new Error('ABSOLUTE_DIRECTORY_REQUIRED');
    if(!(await operations.stat(directory)).isDirectory())throw new Error('STORAGE_DIRECTORY_REQUIRED');
    const path=join(directory,`.ready-${randomUUID()}.tmp`);
    let handle,created=false;
    try{
        handle=await operations.open(path,'wx');created=true;
        await handle.close();handle=null;
    }finally{
        try{if(handle)await handle.close();}
        finally{if(created)await operations.unlink(path);}
    }
    return Object.freeze({operation:'MUTATING_STORAGE_DIAGNOSTIC',capability:'CREATE_DELETE',
        durability:'NOT_PROVEN',scope:'CURRENT_PROCESS_DIRECTORY_TIME'});
}
