import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {createProgramOutputServer} from '../server/program-output-server.js';

async function snapshot(root){
    const result=[];
    async function visit(directory){
        for(const item of await readdir(directory,{withFileTypes:true})){
            const path=join(directory,item.name);
            if(item.isDirectory())await visit(path);else result.push([path,await readFile(path)]);
        }
    }
    await visit(root);return result.sort((a,b)=>a[0].localeCompare(b[0]));
}
for(const stage of ['offline-activated','workflow-object-without-reservation'])
test('ordinary production construction refuses NEW ERA before canonical ControlledStart: '+stage,async t=>{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);
    const before=await snapshot(f.root);
    const options={studioStatePath:f.paths.studio,schedulePath:f.paths.schedule,autoLivePath:f.paths.autoLive,
        autoLiveRecoveryPath:f.paths.autoLive+'.recovery',scheduledLiveExecutionPath:f.paths.scheduledJournal,
        scheduledEntryLedgerPath:f.paths.ledger,mediaLibraryRoot:join(f.root,'media'),
        publisherToken:'TEMP-new-era-start-fence-token',
        ...(stage==='workflow-object-without-reservation'?{executionOwnershipOptions:{eraRecovery:{newEra:true}}}:{})};
    assert.throws(()=>createProgramOutputServer(options),{code:'EXECUTION_ERA_CONTROLLED_START_REQUIRED'});
    assert.deepEqual(await snapshot(f.root),before);
});
