import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {executionEraStartup} from '../server/recovery/ExecutionEraContract.js';
import BrowserExecutionOwnership from '../server/autolive/BrowserExecutionOwnership.js';
import {hash,inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
for(const point of ['owner-lock-durable','before-epoch-install','epoch-durable','authority-ready-durable']){
    test('native authority interruption '+point+' retains orphan and prevents duplicate owner/epoch',
        {skip:process.platform!=='win32'},async t=>{
        let first,second;
        t.after(async()=>{await first?.close();await second?.close();});
        const f=await eraFixture(t,{native:true});await f.writer.transition(f.authorization);
        const originalLedger=hash(await readFile(f.paths.ledger)),originalProgram=hash(await readFile(f.paths.program)),originalAuto=hash(await readFile(f.paths.autoLive));
        first=new BrowserExecutionOwnership({path:f.paths.authority,eraLedgerPath:f.paths.ledger,eraHook(stage){if(stage===point)throw Error('TEMP_AUTHORITY_INTERRUPTION');}});
        await first.ready;assert.equal(first.available,false);assert.equal(first.initializationError,'TEMP_AUTHORITY_INTERRUPTION');
        const epoch=JSON.parse(await readFile(f.paths.authority)).epoch;
        assert.equal(epoch,['epoch-durable','authority-ready-durable'].includes(point)?23:22);
        const orphan=hash(await readFile(f.paths.authorityLock));await first.close();
        second=new BrowserExecutionOwnership({path:f.paths.authority,eraLedgerPath:f.paths.ledger});await second.ready;
        assert.equal(second.available,false);assert.equal(second.initializationError,point==='epoch-durable'?'EXECUTION_ERA_RETAINED_EVIDENCE_CHANGED':'EEXIST');
        assert.equal(JSON.parse(await readFile(f.paths.authority)).epoch,epoch);assert.equal(hash(await readFile(f.paths.authorityLock)),orphan);
        assert.equal(hash(await readFile(f.paths.ledger)),originalLedger);assert.equal((await inspectV2(f.paths.ledger)).records.length,1);
        assert.equal(executionEraStartup(f.paths.ledger).executionEraId,f.authorization.executionEraId);
        assert.equal((await f.writer.transition(f.authorization)).status,'ALREADY_TRANSITIONED');
        assert.equal(hash(await readFile(f.paths.program)),originalProgram);assert.equal(hash(await readFile(f.paths.autoLive)),originalAuto);
        // Explicit offline owner reconciliation is deliberately not simulated by
        // deleting a lock. This test proves the fail-closed state, not READY resume.
    });
}
