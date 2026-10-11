import test from 'node:test';
import {registerNativeTestRoot} from '../test-support/NativeTempGuard.mjs';
import {recoveryIntegrityFixture,completedIntegrityFixture,save as saveFixture} from '../test-support/RecoveryIntegrityFixture.mjs';
import {phaseChain,lineageContext,phaseRecord} from '../server/recovery/RecoveryLineage.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {RecoveryWorkflow} from '../server/recovery/RecoveryWorkflow.js';
import {paths,artifact} from '../server/recovery/RecoveryContract.js';
import {ledgerSnapshot} from '../server/scheduler/ScheduledEntryLedgerContract.js';
import {recordFor} from '../server/program-output/DurableProgramContract.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';


test('Exact R11 foreign Prepared regression: zero AutoLive mutation and completion', {skip:process.platform!=='win32',timeout:180000}, async()=>{
// Review-only fixture, built independently of R10's test-support and tests.
// Host proofs and service configuration are injected; all files are TEMP.
const head='1270d3e5bd17e206b8f8e78d6404ff7e8a978c3b',foreignHead='0'.repeat(40);
const root=await mkdtemp(join(tmpdir(),'lz-r11-lineage-')),p=paths(root),stamp='2026-10-02T00:00:00.000Z';
registerNativeTestRoot(root);
const save=(path,value)=>writeFile(path,JSON.stringify(value));
try{
    await mkdir(dirname(p.auto),{recursive:true});await mkdir(dirname(p.schedule),{recursive:true});
    const service={Name:'LivezoneNode',State:'Stopped',StartMode:'Disabled',PathName:join(root,'ops/LivezoneNode.exe'),StartName:'LocalSystem',DelayedPresent:false,DelayedValue:0};
    const host={inspect:async()=>({root,branch:'build/1003.9A1',head,administrator:true,service,media:{status:'VERIFIED',Name:'LivezoneMediaMtx'},proof:{absent:true},ports:[],bootstrapPermission:false}),proveOffline:async()=>({absent:true}),reserve:async()=>()=>{}};
    await save(p.maintenance,{Version:1,Repository:root,Head:head,CapturedAt:stamp,Original:{...service,StartMode:'Auto'}});
    await save(p.auto,{version:1,revision:7,enabled:true,armed:true,sourceId:'camera',updatedAt:stamp,migration:null});
    await save(p.authority,{epoch:20});await save(p.ledger,ledgerSnapshot());await save(p.marker,{version:1,authorityEpoch:20});
    await save(p.schedule,{version:2,revision:1,events:[],programPlan:{version:1,timezone:'Europe/Rome',items:[]}});
    const envelope=createProgramOutputEnvelope({version:1,publisherSessionId:'r11',revision:1,publishedAt:stamp,committedAt:stamp,scene:null,source:null,playback:{initialTime:0,duration:120,playing:false,ended:false,state:'paused',startedAt:stamp},graphics:{items:[]},transition:{type:'cut',durationMs:0}});
    await save(p.program,recordFor({envelope,retiredPublisherSessions:[],identity:{sourceFingerprint:null,catalog:null,assets:[]},generation:1,authorityEpoch:20}));
    const w=new RecoveryWorkflow({root,runId:'r11-current',host,expectedHead:head});
    await w.begin();const audit=await w.load();assert.equal(audit.head,head);
    await assert.rejects(readFile(w.audit+'.prepared'),{code:'ENOENT'});
    // Replay a valid-shaped phase marker from another approved HEAD without
    // executing this recovery run's Prepared phase.
    await save(w.audit+'.prepared',{state:'PREPARED_FOR_EXPLICIT_DISARM',head:foreignHead});
    const before=await artifact(p.auto);let error,result;
    try{result=await w.disarm({authorize:true,expectedRevision:audit.before.auto.value.revision,expectedHash:audit.before.auto.hash});}
    catch(e){error=e.code??e.message;}
    const after=await artifact(p.auto),completed=await artifact(w.audit+'.disarm.completed');
    console.log(JSON.stringify({probe:'foreign HEAD PREPARED marker authorizes Disarm',currentHead:head,preparedHead:foreignHead,currentRunPreparedPhaseExecuted:false,
        rejected:!!error,error:error??null,result:result??null,before:{armed:before.value.armed,revision:before.value.revision,hash:before.hash},
        after:{armed:after.value.armed,revision:after.value.revision,hash:after.hash},disarmCompletionPersisted:!!completed,realRuntimeOrServiceAction:false}));
    assert.ok(error,'R11 BLOCKER: Disarm must reject a PREPARED marker from another HEAD before mutation');
    assert.equal(after.hash,before.hash,'R11 BLOCKER: unrelated phase marker must not mutate AutoLive');
    assert.equal(completed,null);
}finally{
    const child=relative(tmpdir(),root);assert.ok(child.startsWith('lz-r11-lineage-')&&!child.startsWith('..')&&!isAbsolute(child));await rm(root,{recursive:true,force:true});
}

});

const windows={skip:process.platform!=='win32',timeout:180000};
for(const kind of ['head','runId','root','auditHash','predecessorHash','version','malformed','truncated','copied','replacement','audit-replacement','stale-attempt','bare-head','plan-replacement','completion-replacement'])test('Prepared lineage rejects with zero AutoLive mutation: '+kind,windows,async t=>{
    const h=await recoveryIntegrityFixture(t);
    const auto=(await artifact(h.p.auto)).value;auto.armed=true;await saveFixture(h.p.auto,auto);
    await h.seedAudit();
    await saveFixture(h.w.audit+'.prepared',phaseRecord(await lineageContext(h.w),'prepared',null,{state:'PREPARED_FOR_EXPLICIT_DISARM',head:h.w.expected.head}));
    const before=await readFile(h.p.auto),audit=await h.w.load(),marker=h.w.audit+'.prepared';
    const replace=async()=>{const v=(await artifact(marker)).value;v.lineage.head='0'.repeat(40);await saveFixture(marker,v);};
    if(kind==='replacement')h.w.hook=async stage=>{if(stage==='disarm-prepared')await replace();};
    else if(kind==='plan-replacement')h.w.hook=async stage=>{if(stage==='disarm-prepared'){const path=h.w.audit+'.disarm',v=(await artifact(path)).value;v.at='2026-10-04T00:00:00.000Z';await saveFixture(path,v);}};
    else if(kind==='completion-replacement')h.w.hook=async stage=>{if(stage==='disarm-prepared')await saveFixture(h.w.audit+'.disarm.completed',{state:'COMPLETED',foreign:true});};
    else if(kind==='audit-replacement')h.w.hook=async stage=>{if(stage==='disarm-prepared'){const a=await h.w.load();a.at='2026-10-03T00:00:00.000Z';await saveFixture(h.w.audit,a);}};
    else if(kind==='stale-attempt'){const a=await h.w.load();a.at='2026-10-03T00:00:00.000Z';await saveFixture(h.w.audit,a);}
    else if(kind==='bare-head'){const v=(await artifact(marker)).value;v.head='0'.repeat(40);await saveFixture(marker,v);}
    else if(kind==='truncated')await writeFile(marker,'{"lineage":');
    else if(kind==='malformed')await saveFixture(marker,{lineage:{}});
    else if(kind==='copied'){
        const other=await recoveryIntegrityFixture(t);await other.w.begin();await other.w.prepared();await writeFile(marker,await readFile(other.w.audit+'.prepared'));
    }else{const v=(await artifact(marker)).value;v.lineage[kind]=kind==='version'?99:'foreign';await saveFixture(marker,v);}
    await assert.rejects(h.w.disarm({authorize:true,expectedRevision:audit.before.auto.value.revision,expectedHash:audit.before.auto.hash}));
    assert.deepEqual(await readFile(h.p.auto),before);
    if(kind==='completion-replacement')assert.deepEqual((await artifact(h.w.audit+'.disarm.completed')).value,{state:'COMPLETED',foreign:true});
    else assert.equal(await artifact(h.w.audit+'.disarm.completed'),null);
});
test('Start replacement immediately before launch rejects with zero launches',windows,async t=>{
    const h=await recoveryIntegrityFixture(t);await h.w.begin();await h.w.prepared();const a=await h.w.load();
    await h.w.disarm({authorize:true,expectedRevision:a.before.auto.value.revision,expectedHash:a.before.auto.hash});
    let launches=0;h.w.hook=async stage=>{if(stage==='before-controlled-launch'){const path=h.w.audit+'.start',v=(await artifact(path)).value;v.lineage.runId='foreign';await saveFixture(path,v);}};
    const auto=await readFile(h.p.auto);
    await assert.rejects(controlledStart({workflow:h.w,authorizeStart:true,launch:()=>{launches++;throw Error('UNEXPECTED_LAUNCH');}}));
    assert.equal(launches,0);assert.deepEqual(await readFile(h.p.auto),auto);assert.equal(await artifact(h.w.audit+'.ready'),null);
});
test('Restore plan replacement before SCM rejects with zero service mutation',windows,async t=>{
    const h=await completedIntegrityFixture(t);h.w.hook=async stage=>{if(stage==='before-service-restore'){const path=h.w.audit+'.restore-prepared',v=(await artifact(path)).value;v.lineage.runId='foreign';await saveFixture(path,v);}};
    const ledger=await readFile(h.p.ledger);await assert.rejects(h.w.restore());assert.equal(h.restoreCalls(),0);assert.deepEqual(await readFile(h.p.ledger),ledger);
});
test('Disarm completion replacement inside migration reservation rejects before migration writes',windows,async t=>{
    const h=await recoveryIntegrityFixture(t);await h.w.begin();await h.w.prepared();const a=await h.w.load();
    await h.w.disarm({authorize:true,expectedRevision:a.before.auto.value.revision,expectedHash:a.before.auto.hash});
    const before=await readFile(h.p.ledger),auto=await readFile(h.p.auto);
    h.host.reserve=async()=>{const path=h.w.audit+'.disarm.completed',v=(await artifact(path)).value;v.lineage.runId='foreign';await saveFixture(path,v);return ()=>{};};
    await assert.rejects(h.w.reserveStart({authorizeStart:true}));
    assert.deepEqual(await readFile(h.p.ledger),before);assert.deepEqual(await readFile(h.p.auto),auto);
    for(const path of [h.p.ledgerWal,h.p.migrationActivated,h.p.migrationCompleted,h.w.audit+'.start'])assert.equal(await artifact(path),null);
});
test('Correct lineage accepts Prepared, repeated Disarm, and migrated Start reservation',windows,async t=>{
    const h=await recoveryIntegrityFixture(t);await h.w.begin();await h.w.prepared();await h.w.prepared();
    const a=await h.w.load(),options={authorize:true,expectedRevision:a.before.auto.value.revision,expectedHash:a.before.auto.hash};
    await h.w.disarm(options);await h.w.disarm(options);await h.w.reserveStart({authorizeStart:true});await h.w.reserveStart({authorizeStart:true});await phaseChain(h.w,'start');
});
for(const phase of ['disarm.completed','start','ready','restore-completed'])test('Foreign '+phase+' rejects before mutation',windows,async t=>{
    const h=await completedIntegrityFixture(t);
    if(phase==='restore-completed')await h.w.restore();
    const path=h.w.audit+'.'+phase,v=(await artifact(path)).value;v.lineage.runId='foreign';await saveFixture(path,v);
    const before=await readFile(h.p.auto),calls=h.restoreCalls();
    const ledgerBefore=await readFile(h.p.ledger),walBefore=await readFile(h.p.ledgerWal);
    if(phase==='disarm.completed')await assert.rejects(h.w.reserveStart({authorizeStart:true}));else await assert.rejects(h.w.restore());
    assert.deepEqual(await readFile(h.p.auto),before);assert.equal(h.restoreCalls(),calls);
    assert.deepEqual(await readFile(h.p.ledger),ledgerBefore);assert.deepEqual(await readFile(h.p.ledgerWal),walBefore);
});
