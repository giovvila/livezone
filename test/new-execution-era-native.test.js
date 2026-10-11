import test from 'node:test';
import assert from 'node:assert/strict';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {ERA_PHASES,executionEraStartup} from '../server/recovery/ExecutionEraContract.js';
import {inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
const windows={skip:process.platform!=='win32'||process.arch!=='x64'};
for(const phase of ERA_PHASES)test('approved native TEMP interruption and retry after '+phase,windows,async t=>{
    let interrupted=false;
    const f=await eraFixture(t,{native:true,hook(point){if(!interrupted&&point==='phase:'+phase){interrupted=true;throw Error('NATIVE_TEMP_INTERRUPTION');}}});
    await assert.rejects(f.writer.transition(f.authorization),/NATIVE_TEMP_INTERRUPTION/);
    assert.equal(interrupted,true);
    await new NewExecutionEra({...f.options,hook:()=>{}}).transition(f.authorization);
    assert.equal(executionEraStartup(f.paths.ledger).executionEraId,f.authorization.executionEraId);
    assert.equal((await inspectV2(f.paths.ledger)).records.length,1);
});
