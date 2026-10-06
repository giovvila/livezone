import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {recoveryIntegrityFixture} from '../test-support/RecoveryIntegrityFixture.mjs';
import {artifact} from '../server/recovery/RecoveryContract.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';

const windows={skip:process.platform!=='win32',timeout:180000};
const mutations={
    trailing:b=>Buffer.concat([b,Buffer.from(' ')]),
    leading:b=>Buffer.concat([Buffer.from('\n '),b]),
    formatting:b=>Buffer.from(JSON.stringify(JSON.parse(b),null,2)),
    crlf:b=>Buffer.from(JSON.stringify(JSON.parse(b),null,2).replaceAll('\n','\r\n')),
    keyOrder:b=>Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(b)).reverse()))),
    bom:b=>Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),b]),
    repository:b=>Buffer.from(JSON.stringify({...JSON.parse(b),Repository:'C:\\foreign'})),
    configuration:b=>Buffer.from(JSON.stringify({...JSON.parse(b),Original:{...JSON.parse(b).Original,PathName:'foreign.exe'}})),
    serviceState:b=>Buffer.from(JSON.stringify({...JSON.parse(b),Original:{...JSON.parse(b).Original,State:'Running'}})),
    originalService:b=>Buffer.from(JSON.stringify({...JSON.parse(b),Original:{...JSON.parse(b).Original,StartMode:'Manual'}})),
    version:b=>Buffer.from(JSON.stringify({...JSON.parse(b),Version:2})),
    identity:b=>Buffer.from(JSON.stringify({...JSON.parse(b),Head:'0'.repeat(40)})),
};
for(const boundary of ['before-mutation-recheck','migration-before-intent','migration-after-completion'])
for(const [name,mutate] of Object.entries(mutations))test(`Start maintenance byte fence: ${boundary} / ${name}`,windows,async t=>{
    const h=await recoveryIntegrityFixture(t);
    await h.w.begin();await h.w.prepared();const audit=await h.w.load();
    await h.w.disarm({authorize:true,expectedRevision:audit.before.auto.value.revision,expectedHash:audit.before.auto.hash});
    await unlink(h.p.migrationIntent);
    const names=['ledger','authority','auto','schedule','program'];
    const before=Object.fromEntries(await Promise.all(names.map(async n=>[n,await readFile(h.p[n])])));
    const maintenance=await readFile(h.p.maintenance),changed=mutate(maintenance);
    assert.notDeepEqual(changed,maintenance);
    if(['trailing','leading','formatting','crlf','keyOrder'].includes(name))assert.deepEqual(JSON.parse(changed),JSON.parse(maintenance));
    let injected=false,launchCount=0;
    h.w.hook=async stage=>{if(stage===boundary){injected=true;await writeFile(h.p.maintenance,changed);}};
    const attempt=boundary==='migration-before-intent'&&name==='trailing'?
        controlledStart({workflow:h.w,authorizeStart:true,launch:()=>{launchCount++;throw Error('UNEXPECTED_LAUNCH');}}):
        h.w.reserveStart({authorizeStart:true});
    await assert.rejects(attempt,error=>['MAINTENANCE_RECORD_CHANGED','MAINTENANCE_CONFLICT','PREFLIGHT_EVIDENCE_CHANGED'].includes(error.code));
    assert.equal(injected,true);assert.deepEqual(await readFile(h.p.maintenance),changed);
    for(const n of names.filter(n=>boundary!=='migration-after-completion'||n!=='ledger'))assert.deepEqual(await readFile(h.p[n]),before[n],n);
    if(boundary!=='migration-after-completion'){
        assert.equal((await artifact(h.p.ledger)).value.schemaVersion,1);
        for(const p of [h.p.migrationIntent,h.p.ledgerWal,h.p.migrationActivated,h.p.migrationCompleted])assert.equal(await artifact(p),null,p);
    }
    assert.equal(await artifact(h.w.audit+'.start'),null);
    assert.equal(await artifact(h.p.gate),null);
    assert.equal(launchCount,0);assert.equal(h.restoreCalls(),0);
});
for(const key of ['authorityLock','scheduledLock','mediaManifest','mediaDelete'])test(`Start frozen evidence: ${key} appears before intent`,windows,async t=>{
    const h=await recoveryIntegrityFixture(t);
    await h.w.begin();await h.w.prepared();const audit=await h.w.load();
    await h.w.disarm({authorize:true,expectedRevision:audit.before.auto.value.revision,expectedHash:audit.before.auto.hash});
    await unlink(h.p.migrationIntent);
    const before=await readFile(h.p.ledger);
    h.w.hook=async stage=>{if(stage==='migration-before-intent')await writeFile(h.p[key],'{}');};
    await assert.rejects(h.w.reserveStart({authorizeStart:true}),error=>['PREFLIGHT_EVIDENCE_CHANGED','LOCK_RECONCILIATION_REQUIRED'].includes(error.code));
    assert.deepEqual(await readFile(h.p.ledger),before);
    for(const p of [h.p.migrationIntent,h.p.ledgerWal,h.p.migrationActivated,h.p.migrationCompleted,h.w.audit+'.start'])assert.equal(await artifact(p),null);
    assert.equal(h.restoreCalls(),0);
});
test('Start retains created migration intent byte identity before WAL mutation',windows,async t=>{
    const h=await recoveryIntegrityFixture(t);
    await h.w.begin();await h.w.prepared();const audit=await h.w.load();
    await h.w.disarm({authorize:true,expectedRevision:audit.before.auto.value.revision,expectedHash:audit.before.auto.hash});
    await unlink(h.p.migrationIntent);const before=await readFile(h.p.ledger);
    let changed;
    h.w.hook=async stage=>{if(stage==='migration-after-intent'){
        const bytes=await readFile(h.p.migrationIntent);changed=Buffer.concat([bytes,Buffer.from(' ')]);
        assert.deepEqual(JSON.parse(changed),JSON.parse(bytes));await writeFile(h.p.migrationIntent,changed);
    }};
    await assert.rejects(h.w.reserveStart({authorizeStart:true}),{code:'MIGRATION_INTENT_CHANGED'});
    assert.ok(changed);assert.deepEqual(await readFile(h.p.migrationIntent),changed);
    assert.deepEqual(await readFile(h.p.ledger),before);
    for(const p of [h.p.ledgerWal,h.p.migrationActivated,h.p.migrationCompleted,h.w.audit+'.start'])assert.equal(await artifact(p),null);
    assert.equal(h.restoreCalls(),0);
});
