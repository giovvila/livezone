import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,unlink} from 'node:fs/promises';
import {recoveryIntegrityFixture,save} from '../test-support/RecoveryIntegrityFixture.mjs';
import {artifact} from '../server/recovery/RecoveryContract.js';

const windows={skip:process.platform!=='win32',timeout:180000};
async function prepared(t){
    const h=await recoveryIntegrityFixture(t);
    await h.w.begin();await h.w.prepared();const a=await h.w.load();
    await h.w.disarm({authorize:true,expectedRevision:a.before.auto.value.revision,expectedHash:a.before.auto.hash});
    return h;
}
async function conflict(h){
    const record=(await artifact(h.p.maintenance)).value;record.Repository=h.root+'-foreign';await save(h.p.maintenance,record);
}
async function unchanged(h,before){
    for(const [name,bytes] of Object.entries(before))assert.deepEqual(await readFile(h.p[name]),bytes,name);
    assert.equal((await artifact(h.p.ledger)).value.schemaVersion,1);
    for(const path of [h.p.ledgerWal,h.p.migrationActivated,h.p.migrationCompleted,h.w.audit+'.start'])assert.equal(await artifact(path),null,path);
}
for(const race of [false,true])test('Start maintenance conflict leaves v1 and all authority data unchanged: '+(race?'exclusive recheck':'initial preflight'),windows,async t=>{
    const h=await prepared(t);await unlink(h.p.migrationIntent);
    const before=Object.fromEntries(await Promise.all(['ledger','auto','schedule','program','authority'].map(async name=>[name,await readFile(h.p[name])])));
    let reservations=0;h.host.reserve=async()=>{reservations++;if(race)await conflict(h);return ()=>{};};
    if(!race)await conflict(h);
    await assert.rejects(h.w.reserveStart({authorizeStart:true}),{code:'MAINTENANCE_CONFLICT'});
    await unchanged(h,before);assert.equal(await artifact(h.p.migrationIntent),null);
    assert.equal(reservations,race?1:0);assert.equal(await artifact(h.p.gate),null);
});
test('Start resumes its durable interrupted migration and retries the same reservation',windows,async t=>{
    const h=await prepared(t);await unlink(h.p.migrationIntent);
    let interrupted=false;
    h.w.hook=stage=>{if(stage==='migration-snapshot-installed'){interrupted=true;throw Object.assign(Error('injected crash'),{code:'INJECTED_CRASH'});}};
    await assert.rejects(h.w.reserveStart({authorizeStart:true}),{code:'INJECTED_CRASH'});
    assert.equal(interrupted,true);assert.ok(await artifact(h.p.migrationIntent));
    assert.equal(await artifact(h.w.audit+'.start'),null);
    h.w.hook=()=>{};
    const start=await h.w.reserveStart({authorizeStart:true});
    assert.equal(start.ledgerProtocolVersion,2);assert.ok(await artifact(h.p.migrationCompleted));
    assert.deepEqual(await h.w.reserveStart({authorizeStart:true}),start);
});
