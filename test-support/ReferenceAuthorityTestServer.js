import {mkdtempSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after} from 'node:test';
import {createProgramOutputServer as createServer} from '../server/program-output-server.js';
import {assertTestMutationAllowed} from './RuntimeStateGuard.mjs';
export {parseHttpBindConfig,startProgramOutputServer} from '../server/program-output-server.js';

const roots=[];
after(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
// Older endpoint tests exercised read-only default state. D2 writes ownership and
// adoption markers; isolate those files from the actual service's private state.
export function createProgramOutputServer(options={}) {
    const root=mkdtempSync(join(tmpdir(),'lz-authority-server-test-'));roots.push(root);
    const isolated={mediaLibraryRoot:join(root,'media'),assetAuthorityPath:join(root,'authority'),studioStatePath:join(root,'studio.json'),schedulePath:join(root,'schedule.json'),...options};
    for(const key of ['mediaLibraryRoot','assetAuthorityPath','studioStatePath','schedulePath','autoLivePath','autoLiveRecoveryPath','scheduledLiveExecutionPath','scheduledEntryLedgerPath'])
        if(isolated[key]!==undefined)assertTestMutationAllowed(isolated[key]);
    return createServer(isolated);
}
