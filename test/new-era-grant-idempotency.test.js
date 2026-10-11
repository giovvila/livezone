import test from 'node:test';
import assert from 'node:assert/strict';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {executionEraStartup,issueEraEntry} from '../server/recovery/ExecutionEraContract.js';
test('same unobserved grant issuance retry retains one executable identity',async t=>{
 const f=await eraFixture(t);await f.writer.transition(f.authorization);
 const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
 const runtime=componentLaunch(f);
 try{
  const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const era=executionEraStartup(f.paths.ledger),options={authority:owner.executionOwnership,durability:f.writer.durability};
  const first=await issueEraEntry(era,'new-grant-retry',options);
  // Caller died or failed before Schedule publication; the identical request
  // must not allocate a second executable incarnation on legitimate retry.
  const second=await issueEraEntry(era,'new-grant-retry',options);
  assert.deepEqual(second,first);
 }finally{await runtime.close();}
});
