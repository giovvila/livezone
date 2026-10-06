import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {recoveryIntegrityFixture,save} from '../test-support/RecoveryIntegrityFixture.mjs';
import {artifact} from '../server/recovery/RecoveryContract.js';

const windows={skip:process.platform!=='win32',timeout:180000};
const states=['ledger','auto','schedule','program','authority'];
const capture=async h=>Object.fromEntries(await Promise.all(states.map(async key=>[key,await readFile(h.p[key])])));
async function untouched(h,before,{stage=false,changed=null}={}){
    for(const key of states.filter(k=>k!==changed))assert.deepEqual(await readFile(h.p[key]),before[key],key);
    assert.equal((await artifact(h.p.ledger)).value.schemaVersion,1);
    for(const p of [h.p.migrationIntent,h.p.ledgerWal,h.p.ledger+'.migration.base.stage',h.p.migrationActivated,h.p.migrationCompleted,h.w.audit+'.prepared'])assert.equal(await artifact(p),null,p);
    if(!stage)assert.equal(await artifact(h.p.migrationIntentStage),null);
    assert.equal(await artifact(h.p.gate),null);assert.equal(h.restoreCalls(),0);
}
const mutations={
    trailing:b=>Buffer.concat([b,Buffer.from(' ')]),leading:b=>Buffer.concat([Buffer.from('\n'),b]),
    formatting:b=>Buffer.from(JSON.stringify(JSON.parse(b),null,2)),
    keyOrder:b=>Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(b)).reverse()))),
    crlf:b=>Buffer.from(JSON.stringify(JSON.parse(b),null,2).replaceAll('\n','\r\n')),
    bom:b=>Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),b]),
};
for(const phase of ['begin','prepared'])for(const boundary of ['migration-before-intent','migration-intent-installing'])
for(const [name,mutate] of Object.entries(mutations))test(`Prepare final byte fence: ${phase} / ${boundary} / ${name}`,windows,async t=>{
    const h=await recoveryIntegrityFixture(t);if(phase==='prepared')await h.seedAudit();
    const before=await capture(h),maintenance=await readFile(h.p.maintenance),changed=mutate(maintenance);
    assert.notDeepEqual(changed,maintenance);if(name!=='bom')assert.deepEqual(JSON.parse(changed),JSON.parse(maintenance));
    else assert.throws(()=>JSON.parse(changed));
    let injected=false;h.w.hook=async s=>{if(s===boundary){injected=true;await writeFile(h.p.maintenance,changed);}};
    await assert.rejects(h.w[phase](),e=>['PREFLIGHT_EVIDENCE_CHANGED','MAINTENANCE_CONFLICT'].includes(e.code));
    assert.equal(injected,true);assert.deepEqual(await readFile(h.p.maintenance),changed);
    await untouched(h,before,{stage:boundary.endsWith('installing')});
    const audit=await artifact(h.w.audit);assert.ok(audit);assert.equal(audit.value.before.maintenance.hash,(await import('node:crypto')).createHash('sha256').update(maintenance).digest('hex'));
});

for(const key of ['auto','schedule','program','authority','ledger','scheduled','mediaDelete','mediaManifest','audit'])
test(`Prepare freezes other final evidence: ${key}`,windows,async t=>{
    const h=await recoveryIntegrityFixture(t),before=await capture(h);let changed,path;
    h.w.hook=async s=>{if(s==='migration-before-intent'){
        path=key==='audit'?h.w.audit:h.p[key];const old=await artifact(path);
        changed=old?Buffer.concat([await readFile(path),Buffer.from(' ')]):Buffer.from('{}');await writeFile(path,changed);
    }};
    await assert.rejects(h.w.begin());assert.ok(changed);assert.deepEqual(await readFile(path),changed);
    await untouched(h,before,{changed:key});
});

for(const target of ['audit','completion'])test(`Prepare binds reconciled AutoLive ${target} bytes`,windows,async t=>{
    const h=await recoveryIntegrityFixture(t),owner={pid:123456,authorityProcessSession:'r24-original'};
    await save(h.p.authorityLock,owner);await h.seedAudit();const before=await capture(h);
    const archive=h.p.authority+'.lock.reconciled-r24',audit=h.p.authority+'.reconciliation-r24.json';
    await writeFile(archive,await readFile(h.p.authorityLock));await unlink(h.p.authorityLock);
    await save(audit,{state:'PREPARED',previousOwner:owner,epoch:20,path:h.p.authority,archive,proof:{absent:true}});
    await save(audit+'.completed',{state:'COMPLETED',archive,epoch:20});
    const path=target==='audit'?audit:audit+'.completed';let changed;
    h.w.hook=async s=>{if(s==='migration-before-intent'){changed=Buffer.concat([await readFile(path),Buffer.from(' ')]);await writeFile(path,changed);}};
    await assert.rejects(h.w.prepared(),{code:'PREFLIGHT_EVIDENCE_CHANGED'});assert.ok(changed);assert.deepEqual(await readFile(path),changed);
    await untouched(h,before);
});

test('Prepare rejected race retains audit; only a canonical retry creates intent and Prepared',windows,async t=>{
    const h=await recoveryIntegrityFixture(t),before=await capture(h),maintenance=await readFile(h.p.maintenance);
    h.w.hook=async s=>{if(s==='migration-before-intent')await writeFile(h.p.maintenance,Buffer.concat([maintenance,Buffer.from(' ')]));};
    await assert.rejects(h.w.begin(),{code:'PREFLIGHT_EVIDENCE_CHANGED'});await untouched(h,before);
    const audit=await readFile(h.w.audit);h.w.hook=()=>{};
    await save(h.p.maintenance,{...JSON.parse(maintenance),Repository:h.root+'-foreign'});
    await assert.rejects(h.w.begin(),{code:'MAINTENANCE_CONFLICT'});assert.equal(await artifact(h.p.migrationIntent),null);
    await writeFile(h.p.maintenance,maintenance);await h.w.begin();await h.w.prepared();
    assert.ok(await artifact(h.p.migrationIntent));assert.ok(await artifact(h.w.audit+'.prepared'));assert.deepEqual(await readFile(h.w.audit),audit);
    for(const key of states)assert.deepEqual(await readFile(h.p[key]),before[key]);assert.equal(h.restoreCalls(),0);
});

test('Prepare resumes an authorized partial intent without changing ledger history',windows,async t=>{
    const h=await recoveryIntegrityFixture(t),before=await capture(h);
    h.w.hook=s=>{if(s==='migration-intent-partial')throw Object.assign(Error('injected'),{code:'R24_INTERRUPTED'});};
    await assert.rejects(h.w.begin(),{code:'R24_INTERRUPTED'});assert.ok(await artifact(h.p.migrationIntentStage));
    const audit=await readFile(h.w.audit);h.w.hook=()=>{};await h.w.begin();await h.w.prepared();
    assert.ok(await artifact(h.p.migrationIntent));assert.equal(await artifact(h.p.migrationIntentStage),null);
    assert.deepEqual(await readFile(h.w.audit),audit);for(const key of states)assert.deepEqual(await readFile(h.p[key]),before[key]);
    assert.ok(await artifact(h.w.audit+'.prepared'));assert.equal(h.restoreCalls(),0);
});

test('Prepare detects intent byte changes after installation before Prepared authorization',windows,async t=>{
    const h=await recoveryIntegrityFixture(t);await h.seedAudit();const before=await capture(h);let changed;
    h.w.hook=async s=>{if(s==='migration-after-intent'){changed=Buffer.concat([await readFile(h.p.migrationIntent),Buffer.from(' ')]);await writeFile(h.p.migrationIntent,changed);}};
    await assert.rejects(h.w.prepared(),{code:'MIGRATION_INTENT_CHANGED'});assert.ok(changed);
    assert.deepEqual(await readFile(h.p.migrationIntent),changed);assert.equal(await artifact(h.w.audit+'.prepared'),null);
    for(const key of states)assert.deepEqual(await readFile(h.p[key]),before[key]);assert.equal(h.restoreCalls(),0);
});
