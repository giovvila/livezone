import {join,dirname} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {ledgerSnapshot,entryConsumption} from '../server/scheduler/ScheduledEntryLedgerContract.js';
import {scheduledEntryIdentity} from '../server/scheduler/ScheduledEntryIdentity.js';
import {CleanLedgerV1Migration} from '../server/recovery/CleanLedgerV1Migration.js';
export const HEAD='1270d3e5bd17e206b8f8e78d6404ff7e8a978c3b';
export const identity=n=>scheduledEntryIdentity({eventId:'migration-'+n,incarnationId:'12345678-1234-1234-1234-123456789abc',entryRevision:1,
    type:'source.live',sourceId:'camera',startAt:'2026-10-02T12:00:00.000Z',endAt:'2026-10-02T12:05:00.000Z'});
export function migrationFixture(root,options={}) {
    const path=options.path??join(root,'ledger.json'),authorityPath=options.authorityPath??join(root,'authority.execution');
    const host=options.host??{inspect:async()=>({root,branch:'build/1003.9A1',head:HEAD,administrator:true,
        service:{Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled'},media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},
        bootstrapPermission:false,proof:{absent:true},ports:[]}),proveOffline:async()=>({absent:true}),reserve:async()=>()=>{}};
    return new CleanLedgerV1Migration({path,authorityPath,root,host,expected:{branch:'build/1003.9A1',head:HEAD},...options});
}
export async function seedMigration(root,{entries=3,...options}={}) {
    const migration=migrationFixture(root,options);await mkdir(dirname(migration.path),{recursive:true});
    const snapshot=ledgerSnapshot({generation:entries,entries:Array.from({length:entries},(_,n)=>entryConsumption(identity(n),
        {authorityEpoch:20,authorityProcessSession:'original-authority',consumedAt:'2026-10-02T12:01:00.000Z'}))});
    await writeFile(migration.path,JSON.stringify(snapshot)+'\n');
    await writeFile(migration.path+'.bootstrap',JSON.stringify({version:1,authorityEpoch:20}));
    await writeFile(migration.authorityPath,JSON.stringify({epoch:20}));
    return {migration,snapshot};
}
