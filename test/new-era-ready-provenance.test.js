import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {eraRecordBytes,unsealEra} from '../server/recovery/ExecutionEraContract.js';
import {seal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';

for(const target of ['anchor','journal'])for(const field of ['executionEraId','transitionId'])
test('resealed foreign READY refuses a read-only retry without launch or mutation: '+target+'/'+field,async t=>{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);
    const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
    const runtime=componentLaunch(f);let path,original;
    try{
        await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch,timeoutMs:300000});
        const chain=await workflow.journal(),ready=chain.records.at(-1);
        path=target==='journal'?ready.path:join(chain.era.directory,'start-'+runtime.owners[0].executionOwnership.authorityProcessSession+'.json.ready');
        original=await readFile(path);
        const foreign=eraRecordBytes(seal({...unsealEra(JSON.parse(original)),[field]:'11111111-1111-1111-1111-111111111111'}));
        await writeFile(path,foreign);
        const protectedPaths=[path,f.paths.authority,f.paths.authorityLock,f.paths.program,f.paths.autoLive,f.paths.schedule,f.paths.ledger,f.paths.ledger+'.wal',f.paths.ledgerLock,f.paths.scheduledLock];
        const before=await Promise.all(protectedPaths.map(p=>readFile(p)));let launches=0;
        await assert.rejects(controlledStart({workflow,authorizeStart:true,launch:()=>{launches++;throw Error('FOREIGN_READY_LAUNCH');}}),
            {code:target==='anchor'?'EXECUTION_ERA_START_CHAIN':'NEW_ERA_READY_PROVENANCE'});
        assert.equal(launches,0);
        const after=await Promise.all(protectedPaths.map(p=>readFile(p)));
        for(let i=0;i<before.length;i++)assert.deepEqual(after[i],before[i],protectedPaths[i]);
    }finally{
        if(original)await writeFile(path,original);
        await runtime.close();
    }
});
