import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {executionEraStartup,issueEraEntry,eraAdmits,eraRecordBytes} from '../server/recovery/ExecutionEraContract.js';
import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';
import {seal,hash} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
const grants=async era=>(await readdir(era.directory)).filter(n=>/^grant-.*\.json$/.test(n));
async function ready(t,fn){
 const f=await eraFixture(t);await f.writer.transition(f.authorization);const runtime=componentLaunch(f);
 try{const {owner}=await controlledStart({workflow:new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization}),authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
 const store=owner.scheduler.store,era=executionEraStartup(f.paths.ledger),old=store.listEvents().find(e=>e.type==='source.live');
 const event={...old,id:'era10-new',startAt:'2030-01-01T12:00:00.000Z',endAt:'2030-01-01T12:03:00.000Z'};
 for(const key of ['incarnationId','entryRevision','entryMigration','executionEraId','entryGrantHash'])delete event[key];
 await fn({f,owner,store,era,event,options:{authority:owner.executionOwnership,durability:f.writer.durability}});
 }finally{await runtime.close();}
}
for(const point of ['grant/authorized','grant/durable','grant-schedule/partial-written','grant-schedule/installed','grant-schedule/before-return'])test('same issuance converges after '+point,t=>ready(t,async({store,era,event})=>{
 const before=store.state.revision;store.eraGrantHook=p=>{if(p===point)throw Error('TEMP_UNOBSERVED_RESULT');};
 const failed=await store.insert(event,before);assert.equal(failed.ok,false);store.eraGrantHook=undefined;
 if(!store.state)await store.hydrate();
 const files=await grants(era);const installed=files.length?JSON.parse(await readFile(join(era.directory,files[0]))):null;
 const retry=await store.insert({...event,name:'compatible retry label'},store.state.revision);assert.equal(retry.ok,true,retry.code);
 assert.equal((await grants(era)).length,1);assert.equal(eraAdmits(era,identityForScheduledEvent(store.getEvent(event.id))),true);
 if(installed)assert.equal(store.getEvent(event.id).incarnationId,installed.incarnationId);
 const post=await store.insert(event,before);assert.equal(post.ok,true);assert.equal(post.alreadyPublished,true);
 assert.equal((await grants(era)).length,1);
}));
test('new deliberate issuance after delete receives fresh identity, old grant is stale',t=>ready(t,async({store,era,event})=>{
 assert.equal((await store.insert(event,store.state.revision)).ok,true);const first=store.getEvent(event.id),identity=identityForScheduledEvent(first);
 assert.equal((await store.delete(event.id,store.state.revision)).ok,true);assert.equal(eraAdmits(era,identity),false);
 assert.equal((await store.insert(event,store.state.revision)).ok,true);const second=store.getEvent(event.id);
 assert.notEqual(second.incarnationId,first.incarnationId);assert.equal((await grants(era)).length,2);
 assert.deepEqual(store.state.publishedEraGrants,[first.incarnationId,second.incarnationId]);assert.equal(eraAdmits(era,identity),false);assert.equal(eraAdmits(era,identityForScheduledEvent(second)),true);
}));
test('concurrent duplicate inserts and direct issuance serialize to one grant',t=>ready(t,async({store,era,event,options})=>{
 const direct=await Promise.all([issueEraEntry(era,'direct-duplicate',options),issueEraEntry(era,'direct-duplicate',options)]);assert.deepEqual(direct[0],direct[1]);
 const revision=store.state.revision;const pair=await Promise.all([store.insert(event,revision),store.insert(event,revision)]);
 assert.equal(pair[0].ok,true);assert.equal(pair[1].ok,true);assert.equal(pair[1].alreadyPublished,true);assert.equal((await grants(era)).length,2);
}));
test('pending request changes fail closed and a different new event is independent',t=>ready(t,async({store,era,event})=>{
 store.eraGrantHook=p=>{if(p==='grant-schedule/before-open')throw Error('TEMP_PENDING');};assert.equal((await store.insert(event,store.state.revision)).ok,false);store.eraGrantHook=undefined;
 const files=await grants(era);const result=await store.insert({...event,startAt:'2030-01-01T12:01:00.000Z'},store.state.revision);assert.equal(result.code,'EXECUTION_ERA_GRANT_REQUEST_CONFLICT');assert.deepEqual(await grants(era),files);
 assert.equal((await store.insert({...event,id:'era10-different-event'},store.state.revision)).ok,true);assert.equal((await grants(era)).length,2);
 assert.equal((await store.insert(event,store.state.revision)).ok,true);assert.equal((await grants(era)).length,2);
}));
test('conversion target editorial drift reuses grant; executable predecessor drift rejects',t=>ready(t,async({store,era,event})=>{
 const overlay={...event,id:'era10-conversion',type:'overlay.crawl',payload:{text:'TEMP',position:'bottom',direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true}};
 assert.equal((await store.insert(overlay,store.state.revision)).ok,true);
 store.eraGrantHook=p=>{if(p==='grant-schedule/before-open')throw Error('TEMP_PENDING');};
 const patch={type:'source.live',payload:event.payload};assert.equal((await store.update(overlay.id,patch,store.state.revision)).ok,false);store.eraGrantHook=undefined;
 const first=JSON.parse(await readFile(join(era.directory,(await grants(era))[0])));
 assert.equal((await store.update(overlay.id,{name:'compatible target label'},store.state.revision)).ok,true);
 assert.equal((await store.update(overlay.id,patch,store.state.revision)).ok,true);assert.equal(store.getEvent(overlay.id).incarnationId,first.incarnationId);
 const next={...overlay,id:'era10-conflict'};assert.equal((await store.insert(next,store.state.revision)).ok,true);
 store.eraGrantHook=p=>{if(p==='grant-schedule/before-open')throw Error('TEMP_PENDING');};assert.equal((await store.update(next.id,patch,store.state.revision)).ok,false);store.eraGrantHook=undefined;
 assert.equal((await store.update(next.id,{priority:next.priority+1},store.state.revision)).ok,true);
 const before=await grants(era);assert.equal((await store.update(next.id,patch,store.state.revision)).code,'EXECUTION_ERA_GRANT_REQUEST_CONFLICT');assert.deepEqual(await grants(era),before);
}));
test('corrupt or foreign durable retry anchors and wrong READY fail before new grant',t=>ready(t,async({f,owner,era,options})=>{
 const meta=await issueEraEntry(era,'foreign-anchor',options);const path=join(era.directory,'grant-'+meta.incarnationId+'.json'),bytes=await readFile(path),body=JSON.parse(bytes);delete body.checksum;
 for(const patch of [{executionEraId:'11111111-1111-1111-1111-111111111111'},{requestHash:hash('foreign')},{eventId:'foreign-target'},{repository:f.root+'-foreign'},{approvedHead:'1'.repeat(40)},{transitionId:'11111111-1111-1111-1111-111111111111'},{retirementHash:hash('foreign')},{scheduleBeforeHash:hash('foreign')}]){
 await writeFile(path,eraRecordBytes(seal({...body,...patch})));await assert.rejects(issueEraEntry(era,'foreign-anchor',options),/GRANT_CHANGED|REQUEST_CONFLICT/);assert.equal((await grants(era)).length,1);await writeFile(path,bytes);
 }
 const readyPath=join(era.directory,'start-'+owner.executionOwnership.authorityProcessSession+'.json.ready'),readyBytes=await readFile(readyPath),record=JSON.parse(readyBytes);delete record.checksum;record.recoveryLineage={...record.recoveryLineage,transitionId:'foreign'};
 await writeFile(readyPath,eraRecordBytes(seal(record)));await assert.rejects(issueEraEntry(era,'foreign-anchor',options),/READY_LINEAGE_CHANGED/);await writeFile(readyPath,readyBytes);
 assert.deepEqual(await issueEraEntry(era,'foreign-anchor',options),meta);
}));
test('ambiguous duplicate pending grant evidence is rejected at issuance and admission',t=>ready(t,async({era,options})=>{
 const meta=await issueEraEntry(era,'ambiguous',options),path=join(era.directory,'grant-'+meta.incarnationId+'.json');const body=JSON.parse(await readFile(path));delete body.checksum;
 const schedule=JSON.parse(Buffer.from(body.scheduleBeforeBytes,'base64'));schedule.revision++;const before=Buffer.from(JSON.stringify(schedule)+'\n');const copy={...body,scheduleBeforeBytes:before.toString('base64'),scheduleBeforeHash:hash(before),scheduleRevision:schedule.revision};
 const key=hash({activationHash:copy.activationHash,eventId:copy.eventId,requestHash:copy.requestHash,scheduleBeforeHash:copy.scheduleBeforeHash});copy.incarnationId=key.slice(0,8)+'-'+key.slice(8,12)+'-'+key.slice(12,16)+'-'+key.slice(16,20)+'-'+key.slice(20,32);copy.operationId=copy.incarnationId;const changed=eraRecordBytes(seal(copy));await writeFile(join(era.directory,'grant-'+copy.incarnationId+'.json'),changed);
 await assert.rejects(issueEraEntry(era,'ambiguous',options),/GRANT_AMBIGUOUS/);assert.equal(eraAdmits(era,{identitySchema:2,eventId:'ambiguous',...meta}),false);assert.equal(eraAdmits(era,{identitySchema:2,eventId:'ambiguous',executionEraId:era.executionEraId,incarnationId:copy.incarnationId,entryGrantHash:hash(changed)}),false);assert.equal((await grants(era)).length,2);
}));

test('ordinary published executable edit retains incarnation and does not issue a new grant',t=>ready(t,async({store,era,event})=>{
 assert.equal((await store.insert(event,store.state.revision)).ok,true);const first=store.getEvent(event.id);
 assert.equal((await store.update(event.id,{startAt:'2030-01-01T12:01:00.000Z'},store.state.revision)).ok,true);const edited=store.getEvent(event.id);
 assert.equal(edited.incarnationId,first.incarnationId);assert.equal(edited.entryRevision,first.entryRevision+1);assert.equal((await grants(era)).length,1);
 assert.equal(eraAdmits(era,identityForScheduledEvent(edited)),true);
}));
test('published LIVE conversion away and back is a deliberate new issuance',t=>ready(t,async({store,era,event})=>{
 assert.equal((await store.insert(event,store.state.revision)).ok,true);const first=store.getEvent(event.id);
 const overlay={type:'overlay.crawl',payload:{text:'TEMP',position:'bottom',direction:'rtl',speed:'medium',repeat:'continuous',styleId:'broadcast-default',background:true}};
 assert.equal((await store.update(event.id,overlay,store.state.revision)).ok,true);assert.equal(eraAdmits(era,identityForScheduledEvent(first)),false);
 assert.equal((await store.update(event.id,{type:'source.live',payload:event.payload},store.state.revision)).ok,true);const next=store.getEvent(event.id);
 assert.notEqual(next.incarnationId,first.incarnationId);assert.equal((await grants(era)).length,2);assert.equal(eraAdmits(era,identityForScheduledEvent(next)),true);
}));
test('publication history is server owned and validated on hydration',t=>ready(t,async({f,store,era,event})=>{
 const forged=await store.insert({...event,publishedEraGrants:['11111111-1111-1111-1111-111111111111']},store.state.revision);assert.equal(forged.code,'INVALID_EVENT');assert.equal((await grants(era)).length,0);
 assert.equal((await store.insert(event,store.state.revision)).ok,true);const bytes=await readFile(f.paths.schedule);const current=JSON.parse(bytes);
 for(const history of ['invalid',[current.events.find(e=>e.id===event.id).incarnationId,current.events.find(e=>e.id===event.id).incarnationId],['not-a-uuid']]){
 await writeFile(f.paths.schedule,JSON.stringify({...current,publishedEraGrants:history})+'\n');assert.equal(await store.hydrate(),null);await writeFile(f.paths.schedule,bytes);assert.ok(await store.hydrate());
 }
}));
test('same partial grant stage cannot be bypassed by unrelated Schedule drift',t=>ready(t,async({store,era,event})=>{
 store.eraGrantHook=p=>{if(p==='grant/partial-written')throw Error('TEMP_PARTIAL_GRANT');};assert.equal((await store.insert(event,store.state.revision)).ok,false);store.eraGrantHook=undefined;
 const before=(await readdir(era.directory)).filter(n=>n.startsWith('grant-'));assert.equal(before.length,1);assert.match(before[0],/\.stage$/);
 assert.equal((await store.update(store.listEvents()[0].id,{name:'unrelated'},store.state.revision)).ok,true);
 assert.equal((await store.insert(event,store.state.revision)).code,'EXECUTION_ERA_GRANT_STAGING_CHANGED');assert.deepEqual((await readdir(era.directory)).filter(n=>n.startsWith('grant-')),before);assert.equal((await grants(era)).length,0);
}));
