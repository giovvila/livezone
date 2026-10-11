import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readOnlyFilesystemObserver} from '../test-support/ReadOnlyFilesystemObserver.js';
const observer=readOnlyFilesystemObserver();
const {eraFixture}=await import('../test-support/NewExecutionEraFixture.js');
const {componentLaunch}=await import('../test-support/NewEraControlledRuntime.js');
const {NewEraRecoveryWorkflow}=await import('../server/recovery/NewEraRecoveryWorkflow.js');
const {NewExecutionEra}=await import('../server/recovery/NewExecutionEra.js');
const {controlledStart}=await import('../server/recovery/ControlledStart.js');
const {verifyPermanentCapability,sha}=await import('../server/recovery/PermanentCapabilityContract.js');
const {verifyLocalSystemCapabilityProof}=await import('../server/recovery/LocalSystemCapabilityProof.js');
const {approvedPermanentProofHash}=await import('../server/recovery/PermanentCapabilityApproval.js');
const {verifiedCapabilityStorage}=await import('../server/recovery/VerifiedCapabilityStorage.js');
const source=process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY;
assert.ok(source,'explicit unchanged ERA20 deployable fixture required');
const manifest=JSON.parse(fs.readFileSync(join(source,'manifest.json')));
const compatibility={machine:manifest.machine,volume:{volume:manifest.volume,volumeSerial:manifest.volumeSerial,filesystem:'NTFS',local:true}};
const zeros=()=>Object.fromEntries(Object.keys(observer.counts).map(k=>[k,0]));
const reset=()=>{for(const key of Object.keys(observer.counts))observer.counts[key]=0;};
async function fixture(t){
    const f=await eraFixture(t);let exercises=0;
    const capability=()=>{exercises++;observer.event('native');observer.event('directorySync');observer.event('namespace');return {testDouble:true,volume:manifest.volume};};
    f.options={...f.options,runtimeCapabilityProof:source,native:{capability},
        verifyRuntimeCapability:(directory,options)=>verifyPermanentCapability(directory,{...options,approvalHash:approvedPermanentProofHash,compatibility})};
    f.writer=new NewExecutionEra(f.options);
    f.authorization=await f.writer.plan({principal:'ERA23 fixture',approvedHead:f.authorization.approvedHead,approvedBranch:f.authorization.approvedBranch,
        expectedInventoryHash:f.view.inventoryHash,authorizeNewEra:true,retireWholeLegacyDomain:true});
    f.workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization,verifyCapabilityStorage:()=>({testDouble:true,volume:manifest.volume})});
    f.exercises=()=>exercises;return f;
}
async function observe(operation){reset();observer.enable();try{return await operation();}finally{observer.disable();}}
function copy(t){const root=fs.mkdtempSync(join(tmpdir(),'lz-era23-proof-'));fs.cpSync(source,root,{recursive:true});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('exact R5 RED to GREEN after READY: identical journal/review/completion and zero filesystem/native/service operations',async t=>{
    const f=await fixture(t);await f.writer.transition(f.authorization);const runtime=componentLaunch(f);
    try{
        const before=f.exercises();await controlledStart({workflow:f.workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
        assert.ok(f.exercises()>before,'actual start retains active durability verification');
        // Exact previous CLI expression, deliberately exercised only in TEMP.
        const legacy=await observe(async()=>({journal:await f.workflow.journal(),review:await f.workflow.recoveryReview(),completed:await f.workflow.completedStart()}));
        assert.equal(observer.counts.directorySync,1);assert.equal(observer.counts.native,1);
        t.diagnostic('RED legacy capability => directorySync=1 native=1 namespace=1');
        const green=await observe(()=>f.workflow.startReview());
        for(const key of ['journal','review','completed'])assert.deepEqual(green[key],legacy[key]);
        assert.equal(green.proof.proofHash,f.authorization.authorizedProofHash);assert.equal(green.readOnly,true);
        assert.deepEqual(observer.counts,zeros());t.diagnostic('GREEN '+JSON.stringify(observer.counts));
    }finally{observer.disable();await runtime.close();}
});
test('observer detects each prohibited filesystem operation rather than only final byte equality',async t=>{
    const root=fs.mkdtempSync(join(tmpdir(),'lz-era23-observation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const {open,writeFile,rename,unlink,mkdir}=await import('node:fs/promises');
    await observe(async()=>{await mkdir(join(root,'dir'));await writeFile(join(root,'a'),'bytes');const h=await open(join(root,'a'),'r+');
        try{await h.writeFile('x');await h.truncate(1);await h.sync();}finally{await h.close();}
        await rename(join(root,'a'),join(root,'b'));await unlink(join(root,'b'));observer.event('directorySync');observer.event('namespace');});
    for(const key of ['create','write','truncate','rename','delete','fileSync','directorySync','namespace'])assert.ok(observer.counts[key]>0,key);
});
test('activated inspection requires canonical proof before READY without exercising durability',async t=>{
    const f=await fixture(t);await f.writer.transition(f.authorization);const review=await observe(()=>f.workflow.startReview());
    assert.equal(review.completed,null);assert.equal(review.proof.proofHash,approvedPermanentProofHash);assert.deepEqual(observer.counts,zeros());
});
test('missing proof fails closed without automatic probe or namespace work',async t=>{
    const f=await fixture(t);await f.writer.transition(f.authorization);f.writer.runtimeCapabilityProof=undefined;
    await assert.rejects(observe(()=>f.workflow.startReview()),{code:'LOCALSYSTEM_CAPABILITY_PROOF_REQUIRED'});assert.deepEqual(observer.counts,zeros());
});
for(const name of ['manifest.json','receipt.json'])test('read-only review rejects tampered '+name+' without exercise',async t=>{
    const f=await fixture(t);await f.writer.transition(f.authorization);const root=copy(t);fs.appendFileSync(join(root,name),' ');f.writer.runtimeCapabilityProof=root;
    await assert.rejects(observe(()=>f.workflow.startReview()),{code:name==='manifest.json'?'PERMANENT_PROOF_APPROVAL':'PERMANENT_PROOF_ARTIFACT_CHANGED'});assert.deepEqual(observer.counts,zeros());
});
for(const field of ['sid','account','helper','gate','protocol','architecture','machine','producer'])test('read-only review rejects incompatible '+field+' without exercise',async t=>{
    const f=await fixture(t);await f.writer.transition(f.authorization);const root=copy(t),m=JSON.parse(fs.readFileSync(join(root,'manifest.json')));
    if(field==='machine'||field==='producer'){
        const path=join(root,'receipt.json'),receipt=JSON.parse(fs.readFileSync(path));
        if(field==='machine'){m.machine.value='0'.repeat(64);receipt.machine=m.machine;}else receipt.inputs[0].sha256='0'.repeat(64);
        fs.writeFileSync(path,JSON.stringify(receipt));m.artifacts.find(a=>a.name==='receipt.json').sha256=sha(fs.readFileSync(path));
    }else m[field]=field==='protocol'?2:field==='helper'||field==='gate'?'0'.repeat(64):'FOREIGN';
    fs.writeFileSync(join(root,'manifest.json'),JSON.stringify(m));const approvalHash=sha(fs.readFileSync(join(root,'manifest.json')));
    // Test-only external approval for semantic rejection after exact hashes pass.
    f.writer.verifyRuntimeCapability=(directory,options)=>verifyPermanentCapability(directory,{...options,approvalHash,compatibility});f.writer.runtimeCapabilityProof=root;
    await assert.rejects(observe(()=>f.workflow.startReview()),{code:field==='machine'?'PERMANENT_PROOF_FOREIGN_MACHINE_VOLUME':field==='producer'?'PERMANENT_PROOF_STALE':'PERMANENT_PROOF_CONTRACT'});
    assert.deepEqual(observer.counts,zeros());
});
test('superseded manifest rejected by unchanged production approval before exercise',async t=>{
    const f=await fixture(t);await f.writer.transition(f.authorization);const root=copy(t);fs.appendFileSync(join(root,'manifest.json'),'\n');f.writer.runtimeCapabilityProof=root;
    await assert.rejects(observe(()=>f.workflow.startReview()),{code:'PERMANENT_PROOF_APPROVAL'});assert.deepEqual(observer.counts,zeros());
});
test('other read-only dryrun inspect and transition-status retain zero active capability operations',async t=>{
    const f=await fixture(t);await observe(async()=>{await f.writer.dryRun();await f.writer.inspectRecovery();await f.writer.transitionStatus(f.authorization);});
    assert.deepEqual(observer.counts,zeros());
    const status=await f.writer.transitionStatus(f.authorization);const before=f.exercises();await f.writer.transition(f.authorization,{phase:'authorized',expectedCheckpointHash:status.checkpointHash});
    assert.ok(f.exercises()>before);assert.equal((await f.writer.transitionStatus(f.authorization)).completedPhase,'authorized');
    await observe(async()=>{await f.writer.dryRun();await f.writer.inspectRecovery();await f.writer.transitionStatus(f.authorization);});assert.deepEqual(observer.counts,zeros());
});
test('production canonical verifier and storage comparison use metadata only with same proofHash',async t=>{
    const f=await fixture(t);
    const proof=await observe(()=>verifyLocalSystemCapabilityProof(source,{serviceIdentity:'LocalSystem'}));
    assert.equal(proof.proofHash,approvedPermanentProofHash);assert.deepEqual(observer.counts,zeros());
    const storage=await observe(()=>verifiedCapabilityStorage(f.root,proof,source));
    assert.equal(storage.volume,manifest.volume);assert.equal(storage.volumeSerial,manifest.volumeSerial);assert.equal(storage.directory,f.root);assert.deepEqual(observer.counts,zeros());
});
test('partial READY staging verification is read-only and still rejects a conflicting prefix',async t=>{
    const f=await fixture(t);await f.writer.transition(f.authorization);const runtime=componentLaunch(f);
    try{
        await controlledStart({workflow:f.workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
        const ready=(await f.workflow.journal()).records.at(-1);assert.equal(ready.body.state,'READY');
        fs.unlinkSync(ready.path);fs.writeFileSync(ready.path+'.stage',ready.bytes.subarray(0,Math.floor(ready.bytes.length/2)));
        const review=await observe(()=>f.workflow.startReview());assert.equal(review.completed.result.ready,true);assert.deepEqual(observer.counts,zeros());
        fs.writeFileSync(ready.path+'.stage','CONFLICT');
        await assert.rejects(observe(()=>f.workflow.startReview()),{code:'NEW_ERA_READY_STAGING_CONFLICT'});assert.deepEqual(observer.counts,zeros());
    }finally{observer.disable();await runtime.close();}
});
test('canonical production proof and read-only storage validate completed READY without native execution',async t=>{
    const f=await fixture(t);await f.writer.transition(f.authorization);
    const storage={helper:'livezone-windows-ledger-durability',version:'1.0.0',protocol:1,architecture:'x64',command:'capability',ok:true,
        directory:(await import('node:path')).dirname(f.paths.ledger),volume:manifest.volume,volumeSerial:manifest.volumeSerial,filesystem:'NTFS',local:true,barrier:'NTFS_DIRECTORY_FLUSH'};
    f.writer.native={capability:()=>storage};
    const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});const runtime=componentLaunch(f);
    try{
        await controlledStart({workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
        const before={journal:await workflow.journal(),review:await workflow.recoveryReview(),completed:await workflow.completedStart()};
        f.writer.verifyRuntimeCapability=verifyLocalSystemCapabilityProof;
        f.writer.native={capability:()=>{observer.event('native');throw Error('FORBIDDEN_NATIVE_EXERCISE');}};
        const after=await observe(()=>workflow.startReview());for(const key of ['journal','review','completed'])assert.deepEqual(after[key],before[key]);
        assert.equal(after.proof.proofHash,approvedPermanentProofHash);assert.deepEqual(observer.counts,zeros());
    }finally{observer.disable();await runtime.close();}
});
test('actual start-review CLI dispatch after READY returns identical evidence with zero observed mutations',async t=>{
    const f=await fixture(t),{paths:recoveryPaths}=await import('../server/recovery/RecoveryContract.js'),p=recoveryPaths(f.root);
    const paths={ledger:p.ledger,ledgerLock:p.ledgerLock,bootstrap:p.marker,authority:p.authority,authorityLock:p.authorityLock,
        scheduledLock:p.scheduledLock,scheduledJournal:p.scheduled,schedule:p.schedule,program:p.program,autoLive:p.auto,
        studio:p.studio,mediaManifest:p.mediaManifest,configuration:join(f.root,'public/config/config.json')};
    const {dirname}=await import('node:path');
    for(const [key,path]of Object.entries(paths)){if(!f.paths[key]||!fs.existsSync(f.paths[key]))continue;fs.mkdirSync(dirname(path),{recursive:true});fs.copyFileSync(f.paths[key],path);}
    f.paths=paths;f.writer=new NewExecutionEra({...f.options,paths});const view=await f.writer.dryRun();assert.equal(view.eligible,true,view.reason);
    f.authorization=await f.writer.plan({principal:'TEMP-CLI-review',approvedHead:f.authorization.approvedHead,approvedBranch:f.authorization.approvedBranch,
        expectedInventoryHash:view.inventoryHash,authorizeNewEra:true,retireWholeLegacyDomain:true});
    f.workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization,verifyCapabilityStorage:()=>({testDouble:true,volume:manifest.volume})});
    await f.writer.transition(f.authorization);const runtime=componentLaunch(f);
    try{
        await controlledStart({workflow:f.workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
        const before=await f.workflow.startReview(),input=join(f.root,'cli-fixture-input.json'),auth=join(f.root,'cli-authorization-input.json');
        fs.writeFileSync(input,JSON.stringify({root:f.root,proof:source}));fs.writeFileSync(auth,JSON.stringify(f.authorization));
        const {spawnSync}=await import('node:child_process'),{hash}=await import('../server/scheduler/ScheduledEntryLedgerV2Protocol.js');
        const child=spawnSync(process.execPath,['--import','./test-support/new-era-read-only-cli-preload.mjs','tools/new-execution-era.mjs','start-review',
            '--root',f.root,'--runtime-capability-proof',source,'--authorization-file',auth,'--authorization-hash',hash(f.authorization)],
            {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024,env:{...process.env,LIVEZONE_READ_ONLY_CLI_FIXTURE:input}});
        assert.equal(child.status,0,child.error?.message??child.stderr);const after=JSON.parse(child.stdout);
        // JSON serialization converts the evidence Buffers to their wire format.
        const wire=JSON.parse(JSON.stringify(before));for(const key of ['journal','review','completed','proof'])assert.deepEqual(after[key],wire[key]);
        assert.equal(after.readOnly,true);assert.deepEqual(after.testObservation,zeros());
    }finally{await runtime.close();}
});
test('restart inspection of an anchor-only predecessor propagates read-only verification recursively',async t=>{
    const f=await fixture(t);await f.writer.transition(f.authorization);const runtime=componentLaunch(f);
    try{
        await controlledStart({workflow:f.workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
        const chain=await f.workflow.journal(),ready=chain.records.at(-1),owned=chain.records.at(-2),start=chain.records.find(r=>r.body.state==='START_RESERVED');
        fs.unlinkSync(ready.path); // Fixture models an anchor durable before its READY journal record.
        const path=join(f.writer.directory,'start-'+start.body.authorityProcessSession+'.json.ready');
        const {randomUUID}=await import('node:crypto'),{seal}=await import('../server/scheduler/ScheduledEntryLedgerV2Protocol.js'),{eraRecordBytes}=await import('../server/recovery/ExecutionEraContract.js');
        const startAuthorization={...structuredClone(f.authorization),operationId:randomUUID(),predecessorReadyKind:'ANCHOR',
            predecessorReadyPath:path,predecessorReadyHash:sha(fs.readFileSync(path)),predecessorRuntimeOwnedHash:owned.sha256};
        const next=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization,startAuthorization,verifyCapabilityStorage:()=>({testDouble:true,volume:manifest.volume})});
        fs.mkdirSync(next.directory);fs.writeFileSync(join(next.directory,'restart-authorization.json'),eraRecordBytes(seal(startAuthorization)));
        const review=await observe(()=>next.startReview());assert.equal(review.completed,null);assert.equal(review.proof.proofHash,approvedPermanentProofHash);assert.deepEqual(observer.counts,zeros());
    }finally{observer.disable();await runtime.close();}
});
test('post-activation current approved P2 inspection does not rebind historical P1 transition authorization',async t=>{
    const f=await fixture(t);await f.writer.transition(f.authorization);const root=copy(t);fs.appendFileSync(join(root,'manifest.json'),'\n');
    const p2=sha(fs.readFileSync(join(root,'manifest.json')));f.writer.runtimeCapabilityProof=root;
    f.writer.verifyRuntimeCapability=(directory,options)=>verifyPermanentCapability(directory,{...options,approvalHash:p2,compatibility});
    const review=await observe(()=>f.workflow.startReview());assert.equal(review.proof.proofHash,p2);assert.notEqual(p2,f.authorization.authorizedProofHash);assert.deepEqual(observer.counts,zeros());
    await assert.rejects(observe(()=>f.writer.transitionStatus(f.authorization)),{code:'NEW_ERA_AUTHORIZATION_PROOF_CHANGED'});assert.deepEqual(observer.counts,zeros());
});
test('legacy maintenance DryRun shares the fixed separation while active migration checks retain capability',async t=>{
    const root=fs.mkdtempSync(join(tmpdir(),'lz-era23-legacy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const {seedMigration}=await import('../test-support/CleanLedgerMigrationFixture.mjs');let exercises=0;
    const {migration}=await seedMigration(root,{native:{capability:()=>{exercises++;observer.event('directorySync');return {testDouble:true};}}});
    const inspect=migration.host.inspect;migration.host.inspect=async()=>{const host=await inspect();return {...host,service:{...host.service,
        PathName:join(root,'fixture-service.exe'),StartName:'LocalSystem',DelayedPresent:false,DelayedValue:0}};};
    const {RecoveryWorkflow}=await import('../server/recovery/RecoveryWorkflow.js');
    const inspection=await observe(()=>migration.inspect({readOnly:true}));assert.equal(inspection.ledgerMode,'V1');assert.equal(inspection.transactionId,null);
    assert.equal(inspection.nativeCapability,'NOT_EXERCISED_BY_READ_ONLY_INSPECTION');assert.equal(inspection.eligibleForMutation,false);assert.deepEqual(observer.counts,zeros());
    // Invoke the actual legacy workflow inspection with isolated path/host adapters.
    const workflow=new RecoveryWorkflow({root,host:migration.host,expectedHead:migration.expected.head});workflow.migration=migration;
    const dryrun=await observe(()=>workflow.inspect());assert.equal(dryrun.readOnly,true);assert.deepEqual(observer.counts,zeros());
    await migration.inspect();assert.ok(exercises>0,'mutating callers keep original active inspect default');
    fs.writeFileSync(migration.path+'.migration.intent.stage','');
    const partial=await observe(()=>workflow.inspect());assert.equal(partial.ledgerMode,'BLOCKED');assert.equal(partial.blockingReason,'LEDGER_MIGRATION_STAGING_CAPABILITY_VERIFICATION_REQUIRED');assert.deepEqual(observer.counts,zeros());
});
test('authorized legacy migration retains all five file flush and namespace installation sequences',async t=>{
    const root=fs.mkdtempSync(join(tmpdir(),'lz-era23-legacy-write-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const {seedMigration}=await import('../test-support/CleanLedgerMigrationFixture.mjs'),{testDurability}=await import('../test-support/NewExecutionEraFixture.js');
    const trace=[];let capability=0,namespace=0,installs=0,fileSync=0;
    const {migration}=await seedMigration(root,{native:{capability:()=>{capability++;return {testDouble:true};}},hook:point=>trace.push(point),
        durability:{...testDurability,sync:path=>{namespace++;return testDurability.sync(path);},replace:(...args)=>{installs++;return testDurability.replace(...args);},
            syncFile:async path=>{fileSync++;await testDurability.syncFile(path);}}});
    assert.equal((await migration.start()).migrationState,'COMPLETED');
    for(const phase of ['intent','base','snapshot','activation','completion']){
        const ordered=['opened','partial','written','flushed','staged','installing','installed','durable'].map(point=>phase+'-'+point);
        assert.deepEqual(trace.filter(point=>point.startsWith(phase+'-')),ordered);
    }
    assert.ok(capability>0);assert.equal(namespace,5);assert.equal(installs,5);assert.equal(fileSync,5);
});
test.after(()=>observer.restore());
