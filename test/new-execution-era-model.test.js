import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {NewExecutionEraModel,knownSnapshot,dryRun,modelAuthorization,STAGES} from '../test-support/NewExecutionEraModel.mjs';

async function fixture(t){
    const directory=await mkdtemp(join(tmpdir(),'lz-new-era-model-'));
    t.after(async()=>{const rel=relative(resolve(tmpdir()),resolve(directory));assert.ok(rel.startsWith('lz-new-era-model-')&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(directory,{recursive:true,force:true});});
    return {directory,model:new NewExecutionEraModel(directory)};
}
test('supplied snapshot is known unverifiable legacy, never exact-byte qualified',()=>{
    const snapshot=knownSnapshot(),before=JSON.stringify(snapshot),result=dryRun(snapshot);
    assert.equal(result.classification,'LEGACY_LEDGER_LOCK_UNVERIFIABLE');
    assert.equal(result.fingerprint,'KNOWN_SUPPLIED_SUMMARY');assert.equal(result.eligibleForRealExecution,false);
    assert.equal(result.exactBytesVerified,false);assert.equal(JSON.stringify(snapshot),before);
    assert.equal(snapshot.marker.authorityEpoch,21);assert.equal(snapshot.epoch,22);
});
for(const field of ['epoch','head','program','auto','schedule','ledger','ledgerLock','marker','authorityLock','scheduledLock','observedV2'])test('changed '+field+' cannot qualify',()=>{
    const snapshot=knownSnapshot();snapshot[field]=null;assert.equal(dryRun(snapshot).fingerprint,'CHANGED_OR_UNKNOWN');
    assert.equal(dryRun(snapshot).eligibleForRealExecution,false);
});
test('model refuses real workspace directories',()=>assert.throws(()=>new NewExecutionEraModel(process.cwd()),/TEMP_ONLY/));
test('explicit complete authorization required before any phase',async t=>{
    const {model}=await fixture(t);await assert.rejects(model.transition({}),/AUTHORIZATION_REQUIRED/);
    assert.deepEqual(await model.records(),[]);
});
for(const stage of STAGES)test('model completed-record interruption/retry '+stage,async t=>{
    const {directory,model}=await fixture(t),snapshot=knownSnapshot(),auth=modelAuthorization(snapshot);
    await assert.rejects(model.transition(auth,{interruptAfter:stage}),/MODEL_INTERRUPTION/);
    const first=(await model.records())[0].payload;
    const restart=new NewExecutionEraModel(directory);
    if(stage!=='ACTIVATED')assert.equal(await restart.admission({executionEraId:first.executionEraId},[]),false);
    const completed=await restart.transition(auth);
    assert.equal(completed.executionEraId,first.executionEraId);assert.equal(completed.ledgerId,first.ledgerId);
    assert.deepEqual(completed.ledger,{generation:0,entries:[]});assert.deepEqual(completed.snapshot,snapshot);
    assert.deepEqual(await restart.transition(auth),completed);assert.equal((await restart.records()).length,STAGES.length);
});
test('model retirement rejects historical events, clock edits, reload, epoch changes and relabeling without grants',async t=>{
    const {directory,model}=await fixture(t),snapshot=knownSnapshot();
    const state=await model.transition(modelAuthorization(snapshot));const restart=new NewExecutionEraModel(directory);
    for(const id of snapshot.schedule.knownHistoricalIds){
        assert.equal(await restart.admission({id},[]),false);
        assert.equal(await restart.admission({id,executionEraId:state.executionEraId,startAt:'2099-01-01',epoch:999},[]),false);
    }
    assert.equal(await restart.admission({id:'unknown-old-history',executionEraId:state.executionEraId},[]),false);
    const event={id:'new-future-event',incarnationId:'new-server-incarnation',executionEraId:state.executionEraId};
    const grant={eventId:event.id,incarnationId:event.incarnationId,executionEraId:event.executionEraId};
    assert.equal(await restart.admission(event,[grant]),true);
    assert.equal(await restart.admission({...event,incarnationId:'edited'},[grant]),false);
    assert.deepEqual(state.snapshot.auto,snapshot.auto);assert.equal(state.snapshot.auto.armed,false);
    assert.deepEqual(state.snapshot.program,snapshot.program);assert.equal(state.snapshot.program.acceptedAuthorityEpoch,20);
});
test('changed forensic evidence blocks resume',async t=>{
    const {directory,model}=await fixture(t);await assert.rejects(model.transition(modelAuthorization(knownSnapshot()),{interruptAfter:'FORENSIC_SNAPSHOT'}));
    const path=join(directory,'1-FORENSIC_SNAPSHOT.json');const record=JSON.parse(await readFile(path));record.payload.snapshot.epoch++;
    await writeFile(path,JSON.stringify(record));await assert.rejects(new NewExecutionEraModel(directory).records(),/CHAIN_CHANGED/);
});
test('competing model plans cannot publish two era identities',async t=>{
    const {directory,model}=await fixture(t),auth=modelAuthorization(knownSnapshot());
    const results=await Promise.allSettled([model.transition(auth),new NewExecutionEraModel(directory).transition(auth)]);
    assert.ok(results.some(r=>r.status==='fulfilled'));
    const winner=results.find(r=>r.status==='fulfilled').value;
    for(const result of results)if(result.status==='fulfilled')assert.deepEqual(result.value,winner);
    assert.deepEqual(await new NewExecutionEraModel(directory).transition(auth),winner);
});
test('torn model record fails closed; this model does not claim partial-write recovery',async t=>{
    const {directory,model}=await fixture(t);
    await writeFile(join(directory,'0-AUTHORIZED.json'),'{');
    await assert.rejects(model.transition(modelAuthorization(knownSnapshot())));
    await assert.rejects(model.admission({id:'old'},[]));
});
test('missing predecessor cannot grant model activation',async t=>{
    const {directory,model}=await fixture(t);
    await writeFile(join(directory,'5-ACTIVATED.json'),'{}');
    await assert.rejects(model.admission({id:'old'},[]),/PHASE_GAP/);
});
