import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {executionEraStartup,issueEraEntry,eraAdmits,eraRecordBytes,unsealEra} from '../server/recovery/ExecutionEraContract.js';
import {seal,hash,inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';
test('grant authorization, retirement and corrupt/foreign evidence fail closed',async t=>{
 const f=await eraFixture(t);await f.writer.transition(f.authorization);const runtime=componentLaunch(f);
 try{
  const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});
  const {owner}=await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
  const era=executionEraStartup(f.paths.ledger),options={authority:owner.executionOwnership,durability:f.writer.durability};
  await t.test('missing active authority',async()=>{await assert.rejects(issueEraEntry(era,'new',{}),/AUTHORITY_REQUIRED/);});
  await t.test('grant cannot substitute for ControlledStart READY',async()=>{
   const before=await readdir(era.directory);owner.executionOwnership.eraReady=false;
   try{await assert.rejects(issueEraEntry(era,'before-ready',options),/READY_REQUIRED/);assert.deepEqual(await readdir(era.directory),before);}
   finally{owner.executionOwnership.eraReady=true;}
  });
  for(const id of ['live-01091877-5a16-4986-9ac8-8986504567a6','live-29771f19-e4f2-49ab-b5ac-cde3863a6e6d'])await t.test('known retired '+id,async()=>{await assert.rejects(issueEraEntry(era,id,options),/RETIRED/);});
  const old=JSON.parse(await readFile(f.paths.schedule)).events.find(e=>e.type==='source.live');
  await t.test('unbound legacy executable identity cannot be relabeled',async()=>{
   const result=await owner.scheduler.store.insert({...old,id:'another-legacy'},owner.scheduler.store.getSnapshot().revision);assert.equal(result.code,'SERVER_OWNED_IDENTITY');assert.equal(eraAdmits(era,identityForScheduledEvent({...old,id:'another-legacy'})),false);
  });
  const metadata=await issueEraEntry(era,'new-grant-contract',options),identity=identityForScheduledEvent({...old,id:'new-grant-contract',...metadata});
  const path=join(era.directory,'grant-'+metadata.incarnationId+'.json'),bytes=await readFile(path),body=unsealEra(JSON.parse(bytes));
  await t.test('grant is eligible but does not consume Ledger',async()=>{assert.equal(eraAdmits(era,identity,{requirePublished:false}),true);assert.equal(eraAdmits(era,identity),false);assert.equal((await inspectV2(f.paths.ledger)).current.entries.length,0);});
  await t.test('unreconciled staging cannot become executable',async()=>{await writeFile(path+'.stage',bytes.subarray(0,bytes.length/2));assert.equal(eraAdmits(era,identity,{requirePublished:false}),false);await unlink(path+'.stage');});
  for(const [label,patch] of [['wrong era',{executionEraId:'11111111-1111-1111-1111-111111111111'}],['wrong entry',{eventId:'foreign-event'}],['wrong activation',{activationHash:hash('foreign')}],['wrong predecessor',{scheduleBeforeHash:hash('foreign')}],['wrong HEAD',{approvedHead:'1'.repeat(40)}],['wrong retirement',{retirementHash:hash('foreign')}],['wrong repository',{repository:f.root+'-foreign'}],['stale transition',{transitionId:'11111111-1111-1111-1111-111111111111'}]])await t.test(label,async()=>{
   const changed=eraRecordBytes(seal({...body,...patch}));await writeFile(path,changed);assert.equal(eraAdmits(era,{...identity,entryGrantHash:hash(changed)},{requirePublished:false}),false);await writeFile(path,bytes);
  });
  for(const [label,changed] of [['truncated',bytes.subarray(0,bytes.length/2)],['malformed',Buffer.from('{bad')],['byte changed',Buffer.concat([bytes,Buffer.from(' ')])]])await t.test(label,async()=>{
   await writeFile(path,changed);assert.equal(eraAdmits(era,identity,{requirePublished:false}),false);await writeFile(path,bytes);
  });
  await t.test('foreign copied grant cannot authorize another incarnation',async()=>{const other='11111111-1111-1111-1111-111111111111';await writeFile(join(era.directory,'grant-'+other+'.json'),bytes);assert.equal(eraAdmits(era,{...identity,incarnationId:other},{requirePublished:false}),false);await unlink(join(era.directory,'grant-'+other+'.json'));});
  await t.test('actual grant from a previous TEMP era is never adopted',async()=>{
   const other=await eraFixture(t);await other.writer.transition(other.authorization);const previous=componentLaunch(other);
   try{
    const started=await controlledStart({workflow:new NewEraRecoveryWorkflow({writer:other.writer,authorization:other.authorization}),authorizeStart:true,authorizeReconciliation:true,launch:previous.launch});
    const foreign=await issueEraEntry(executionEraStartup(other.paths.ledger),'new-grant-contract',{authority:started.owner.executionOwnership,durability:other.writer.durability});
    const content=await readFile(join(other.writer.directory,'grant-'+foreign.incarnationId+'.json'));
    await writeFile(join(era.directory,'grant-'+foreign.incarnationId+'.json'),content);
    assert.equal(eraAdmits(era,{...identity,incarnationId:foreign.incarnationId,entryGrantHash:hash(content)},{requirePublished:false}),false);await unlink(join(era.directory,'grant-'+foreign.incarnationId+'.json'));
   }finally{await previous.close();}
  });
  await t.test('corrupt staged retry is review-required without second identity',async()=>{
   const copy=await issueEraEntry(era,'pending-corrupt',options);const p=join(era.directory,'grant-'+copy.incarnationId+'.json');await writeFile(p+'.stage','foreign');const count=(await readdir(era.directory)).length;
   await assert.rejects(issueEraEntry(era,'pending-corrupt',options),/STAGING_CHANGED/);assert.equal((await readdir(era.directory)).length,count);await unlink(p+'.stage');
  });
  await t.test('failed grant Schedule publication uses approved namespace cleanup',async()=>{
   const store=owner.scheduler.store,original=store.eraDurability,removed=[];
   store.eraDurability={...original,remove:async path=>{removed.push(path);return original.remove(path);}};
   store.eraGrantHook=point=>{if(point==='grant-schedule/written')throw Error('TEMP_PUBLICATION_FAILURE');};
   const event={...old,id:'grant-publication-failure'};
   for(const key of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete event[key];
   try{const outcome=await store.insert(event,store.state.revision);assert.equal(outcome.code,'PERSISTENCE_FAILED');assert.equal(removed.length,1);}
   finally{store.eraGrantHook=undefined;store.eraDurability=original;}
  });
  await t.test('editorial and ignored timestamp changes do not allocate a second executable identity',async()=>{
   const store=owner.scheduler.store,event={...old,id:'semantic-grant-retry',name:'first label'};
   for(const key of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete event[key];
   store.eraGrantHook=point=>{if(point==='grant-schedule/before-open')throw Error('TEMP_NO_PUBLICATION');};
   try{assert.equal((await store.insert(event,store.state.revision)).code,'PERSISTENCE_FAILED');}
   finally{store.eraGrantHook=undefined;}
   const names=(await readdir(era.directory)).filter(name=>/^grant-.*\.json$/.test(name));
   const grants=await Promise.all(names.map(async name=>JSON.parse(await readFile(join(era.directory,name)))));
   const first=grants.find(record=>record.eventId===event.id);
   assert.ok(first);assert.equal((await store.insert({...event,name:'new label',createdAt:'2030-01-01T00:00:00.000Z'},store.state.revision)).ok,true);
   assert.equal(store.getEvent(event.id).incarnationId,first.incarnationId);
   assert.equal((await readdir(era.directory)).filter(name=>/^grant-.*\.json$/.test(name)).length,names.length);
  });
 }finally{await runtime.close();}
});
