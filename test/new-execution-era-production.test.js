import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {eraFixture,HEAD,BRANCH,testDurability} from '../test-support/NewExecutionEraFixture.js';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {ERA_PHASES,executionEraStartup,eraAdmits,issueEraEntry} from '../server/recovery/ExecutionEraContract.js';
import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';
import {inspectV2,hash} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import ScheduleStore from '../server/scheduler/ScheduleStore.js';
import {CleanLedgerV1Migration} from '../server/recovery/CleanLedgerV1Migration.js';
import BrowserExecutionOwnership from '../server/autolive/BrowserExecutionOwnership.js';
import LegacyLedger from '../server/scheduler/ScheduledEntryLedgerRepository.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';

test('exact real twelve-artifact bytes: eligibility and zero-write DryRun',async t=>{
    const f=await eraFixture(t),before=await readdir(f.root);
    assert.equal(f.view.program.generation,47);assert.equal(f.view.program.acceptedAuthorityEpoch,20);assert.equal(f.view.observedEpoch,22);
    assert.equal((await f.writer.dryRun({expectedInventoryHash:f.view.inventoryHash})).classification,'EXACT_ELIGIBLE_LEGACY_STATE');
    assert.deepEqual(await readdir(f.root),before);
    await writeFile(f.paths.program,Buffer.concat([await readFile(f.paths.program),Buffer.from(' ')]));
    assert.equal((await f.writer.dryRun({expectedInventoryHash:f.view.inventoryHash})).classification,'CHANGED_LEGACY_STATE');
});
test('explicit complete authorization is mandatory and revalidated at final mutation fence',async t=>{
    const f=await eraFixture(t);
    await assert.rejects(f.writer.plan({principal:'operator',approvedHead:HEAD,approvedBranch:BRANCH,expectedInventoryHash:f.view.inventoryHash}),/EXPLICIT_AUTHORIZATION/);
    await writeFile(f.paths.authority,Buffer.concat([await readFile(f.paths.authority),Buffer.from(' ')]));
    await assert.rejects(f.writer.transition(f.authorization),/EVIDENCE_CHANGED/);
    assert.ok(!(await readdir(f.root)).includes('execution-era'));
});
test('whole-domain retirement, distinct UUIDs, fresh BASE, retained PROGRAM/AutoLive/epoch and idempotence',async t=>{
    const f=await eraFixture(t),preserved=await Promise.all(['program','autoLive','authority'].map(k=>readFile(f.paths[k])));
    assert.equal((await f.writer.transition(f.authorization)).status,'ACTIVATED_OFFLINE');
    const era=executionEraStartup(f.paths.ledger),state=await inspectV2(f.paths.ledger);
    assert.equal(new Set([era.executionEraId,era.ledgerId,era.transitionId]).size,3);
    assert.equal(state.current.generation,0);assert.deepEqual(state.current.entries,[]);assert.equal(state.records.length,1);
    assert.equal(state.records[0].data.snapshot.executionEraId,era.executionEraId);
    const schedule=JSON.parse(await readFile(f.paths.schedule));
    assert.equal(schedule.revision,55);assert.deepEqual(schedule.events,JSON.parse(await readFile(join(era.directory+'-forensic','blob-'+f.view.inventory.find(i=>i.key==='schedule').sha256))).events);
    for(const e of schedule.events.filter(e=>e.type==='source.live'))assert.equal(eraAdmits(era,identityForScheduledEvent(e)),false);
    const historical=schedule.events.find(e=>e.type==='source.live');
    assert.equal(eraAdmits(era,identityForScheduledEvent({...historical,id:'unknown-deleted-old-identity'})),false);
    assert.equal(eraAdmits(era,identityForScheduledEvent({...historical,executionEraId:era.executionEraId,entryGrantHash:hash('forged')})),false);
    assert.equal((await f.writer.transition(f.authorization)).status,'ALREADY_TRANSITIONED');
    assert.equal((await f.writer.dryRun()).classification,'ALREADY_TRANSITIONED');
    for(const [index,key] of ['program','autoLive','authority'].entries())assert.deepEqual(await readFile(f.paths[key]),preserved[index]);
    for(const item of f.view.inventory.filter(i=>i.present))assert.equal(hash(await readFile(join(era.directory+'-forensic','blob-'+item.sha256))),item.sha256);
});
for(const phase of ERA_PHASES)test('retry durable phase '+phase+' retains transition, era and ledger',async t=>{
    let crash=true;const f=await eraFixture(t,{hook(point){if(crash&&point==='phase:'+phase){crash=false;throw Error('TEMP_INTERRUPTION');}}});
    await assert.rejects(f.writer.transition(f.authorization),/TEMP_INTERRUPTION/);
    if(phase!=='activated')assert.throws(()=>executionEraStartup(f.paths.ledger));
    await new NewExecutionEra({...f.options,hook:()=>{}}).transition(f.authorization);
    assert.equal(executionEraStartup(f.paths.ledger).executionEraId,f.authorization.executionEraId);
    assert.equal((await inspectV2(f.paths.ledger)).records.length,1);
});
for(const boundary of ['before-open','opened','partial-written','written','file-flushed','namespace-flushed','before-install','installed','durable']){
    for(const artifact of ['authorized.json','manifest.json','ledger.json','ledger.json.wal','schedule.json.era-']){
        test('retry '+artifact+' at '+boundary,async t=>{
            let crash=true;const f=await eraFixture(t,{hook(point,path){if(crash&&point===boundary&&basename(path).startsWith(artifact)){crash=false;throw Error('TEMP_INTERRUPTION');}}});
            await assert.rejects(f.writer.transition(f.authorization),/TEMP_INTERRUPTION/);
            await new NewExecutionEra({...f.options,hook:()=>{}}).transition(f.authorization);
            assert.equal(executionEraStartup(f.paths.ledger).executionEraId,f.authorization.executionEraId);
        });
    }
}
test('changed evidence inside before-install hook stops dependent installation',async t=>{
    let f,changed=false;f=await eraFixture(t,{hook(point,path){if(!changed&&point==='before-install'&&basename(path)==='authorized.json'){changed=true;/* mutation is completed synchronously before final fence */
        // writeFileSync deliberately models a concurrent external writer.
        mutate(f.paths.program);
    }}});
    await assert.rejects(f.writer.transition(f.authorization),/EVIDENCE_CHANGED/);
    await assert.rejects(readFile(join(f.root,'execution-era','authorized.json')),/ENOENT/);
});
import {appendFileSync} from 'node:fs';
const mutate=path=>appendFileSync(path,' ');
test('ambiguous partial bytes fail closed; changed approval cannot create another era',async t=>{
    let crash=true;const f=await eraFixture(t,{hook(point,path){if(crash&&point==='partial-written'&&basename(path)==='authorized.json'){crash=false;throw Error('TEMP_INTERRUPTION');}}});
    await assert.rejects(f.writer.transition(f.authorization));
    await writeFile(join(f.root,'execution-era','authorized.json.stage'),'conflicting bytes');
    await assert.rejects(new NewExecutionEra({...f.options,hook:()=>{}}).transition(f.authorization),/STAGING_CONFLICT/);
});
test('new future live issuance, old edit/type/delete/recreate fences and forensic loss',async t=>{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);const era=executionEraStartup(f.paths.ledger);
    const runtime=componentLaunch(f);t.after(()=>runtime.close());
    const {owner}=await controlledStart({workflow:new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization}),
        authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
    const store=owner.scheduler.store;
    const old=store.listEvents().find(e=>e.type==='source.live'),fresh={...old,id:'genuinely-new-future',startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:03:00.000Z'};
    for(const k of ['incarnationId','entryRevision','entryMigration'])delete fresh[k];
    assert.equal((await store.insert({...fresh,executionEraId:era.executionEraId},store.state.revision)).code,'SERVER_OWNED_IDENTITY');
    assert.equal((await store.insert(fresh,store.state.revision)).ok,true);
    assert.equal(eraAdmits(era,identityForScheduledEvent(store.getEvent(fresh.id))),true);
    const beforeOldEdit=await readFile(f.paths.schedule);
    assert.equal((await store.update(old.id,{startAt:fresh.startAt,endAt:fresh.endAt},store.state.revision)).code,'EXECUTION_ERA_GRANT_CHANGED');
    assert.deepEqual(await readFile(f.paths.schedule),beforeOldEdit);
    assert.deepEqual(store.getEvent(old.id),old);
    assert.equal(eraAdmits(era,identityForScheduledEvent(store.getEvent(old.id))),false);
    assert.equal((await store.update(old.id,{name:'retired editorial label'},store.state.revision)).ok,true);
    await store.delete(old.id,store.state.revision);
    assert.equal((await store.insert({...fresh,id:old.id},store.state.revision)).code,'OLD_EXECUTION_DOMAIN_RETIRED');
    await runtime.close();
    await unlink(join(era.directory,'retired.json'));assert.throws(()=>executionEraStartup(f.paths.ledger),/RESUME_REQUIRED/);
});
test('legacy lock cannot enter clean migration; NEW ERA writer imports no migration implementation',async t=>{
    const f=await eraFixture(t);const migration=new CleanLedgerV1Migration({path:f.paths.ledger,authorityPath:f.paths.authority,scheduledPath:f.paths.scheduledJournal,root:f.root,host:f.options.host,expected:f.options.expected});
    await assert.rejects(migration.view(),/LEGACY_LEDGER_LOCK_UNVERIFIABLE/);
    const code=await readFile(new URL('../server/recovery/NewExecutionEra.js',import.meta.url),'utf8');
    assert.ok(!code.includes('CleanLedgerV1Migration'));
    for(const file of ['NewExecutionEra.js','ExecutionEraContract.js'])assert.ok(!/AutoLiveSafeHttp|ManagedIngestTransport|MediaMtxCookieFixture/.test(await readFile(new URL('../server/recovery/'+file,import.meta.url),'utf8')));
});
for(const boundary of ['before-archive','archived'])for(const key of ['authorityLock','ledger','ledgerLock','bootstrap','scheduledLock']){
    test('exact archive retry '+key+' at '+boundary,async t=>{
        let crash=true,f;f=await eraFixture(t,{hook(point,path){if(crash&&point===boundary&&path===f.paths[key]){crash=false;throw Error('TEMP_ARCHIVE_INTERRUPTION');}}});
        await assert.rejects(f.writer.transition(f.authorization),/TEMP_ARCHIVE_INTERRUPTION/);
        await new NewExecutionEra({...f.options,hook:()=>{}}).transition(f.authorization);
        assert.equal(hash(await readFile(f.paths[key]+'.retired-era-'+f.authorization.transitionId)),f.view.inventory.find(i=>i.key===key).sha256);
    });
}
test('phase/manifest formatting changes and a missing canonical Ledger cannot downgrade era authority',async t=>{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);
    const era=executionEraStartup(f.paths.ledger),path=join(era.directory,'retired.json'),bytes=await readFile(path);
    await writeFile(path,Buffer.concat([bytes,Buffer.from(' ')]));assert.throws(()=>executionEraStartup(f.paths.ledger),/PHASE_BYTES_CHANGED/);
    await writeFile(path,bytes);
    const manifest=join(era.directory+'-forensic','manifest.json'),manifestBytes=await readFile(manifest);
    await writeFile(manifest,Buffer.concat([manifestBytes,Buffer.from(' ')]));assert.throws(()=>executionEraStartup(f.paths.ledger),/MANIFEST_BYTES_CHANGED/);
    await writeFile(manifest,manifestBytes);
    const legacy=new LegacyLedger({path:f.paths.ledger,create:true});await legacy.initialize();assert.equal(legacy.status,'UNAVAILABLE');assert.equal(legacy.error,'LEDGER_V2_REPOSITORY_REQUIRED');await legacy.close();
    await unlink(f.paths.ledger);const missing=new LegacyLedger({path:f.paths.ledger,create:true});await missing.initialize();assert.equal(missing.status,'UNAVAILABLE');await missing.close();
    await assert.rejects(readFile(f.paths.ledger),/ENOENT/);
});
test('unknown old ledger staging makes DryRun unsupported without persistent writes',async t=>{
    const f=await eraFixture(t);await writeFile(f.paths.ledger+'.unknown.stage','unreviewed historical bytes');
    const names=await readdir(f.root),view=await f.writer.dryRun();assert.equal(view.classification,'UNSUPPORTED_STATE');assert.deepEqual(await readdir(f.root),names);
});
test('first new owner refuses a semantic-only PROGRAM rewrite before epoch mutation',async t=>{
    const f=await eraFixture(t);await f.writer.transition(f.authorization);
    await writeFile(f.paths.program,Buffer.concat([await readFile(f.paths.program),Buffer.from(' ')]));
    const owner=new BrowserExecutionOwnership({path:f.paths.authority,eraLedgerPath:f.paths.ledger,eraDurability:testDurability});await owner.ready;
    assert.equal(owner.available,false);assert.equal(owner.initializationError,'EXECUTION_ERA_RETAINED_EVIDENCE_CHANGED');assert.equal(JSON.parse(await readFile(f.paths.authority)).epoch,22);await owner.close();
});
