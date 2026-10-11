import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile,writeFile,readdir,lstat,unlink} from 'node:fs/promises';
import {join,relative,dirname} from 'node:path';
import {eraFixture} from '../test-support/NewExecutionEraFixture.js';
import {ERA_PHASES,executionEraStartup,eraRecordBytes} from '../server/recovery/ExecutionEraContract.js';
import {hash,seal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {spawnSync} from 'node:child_process';
import {cp,appendFile,mkdir} from 'node:fs/promises';
import {verifyPermanentCapability} from '../server/recovery/PermanentCapabilityContract.js';
import {paths as recoveryPaths} from '../server/recovery/RecoveryContract.js';

async function bytes(root){const result={};async function walk(dir){for(const name of (await readdir(dir)).sort()){const path=join(dir,name);if((await lstat(path)).isDirectory())await walk(path);else result[path]=hash(await readFile(path));}}await walk(root);return result;}
async function next(f,phase){const current=await f.writer.transitionStatus(f.authorization);return f.writer.transition(f.authorization,{phase,expectedCheckpointHash:current.checkpointHash});}
async function through(f,phase){for(const p of ERA_PHASES){await next(f,p);if(p===phase)return;}}
async function unchangedReject(f,operation,expected){const before=await bytes(f.root);await assert.rejects(operation,expected);assert.deepEqual(await bytes(f.root),before);}

test('original monolithic transition must honor explicit authorized-phase scope',async t=>{
    const f=await eraFixture(t);
    const status=await f.writer.transitionStatus(f.authorization);
    await f.writer.transition(f.authorization,{phase:'authorized',expectedCheckpointHash:status.checkpointHash});
    await assert.rejects(access(join(f.writer.directory,'forensic.json')));
});

test('all eight returns, exact identities, retirement and Ledger checkpoint, and idempotent retries',async t=>{
    const f=await eraFixture(t),program=await readFile(f.paths.program),auto=await readFile(f.paths.autoLive);
    assert.deepEqual(ERA_PHASES,['authorized','forensic','retired','intent','archived','ledger','schedule','activated']);
    for(const [index,phase] of ERA_PHASES.entries()){
        const state=await next(f,phase);assert.equal(state.completedPhase,phase);assert.equal(state.nextPhase,ERA_PHASES[index+1]??null);
        assert.equal(state.executionEraId,f.authorization.executionEraId);assert.equal(state.ledgerId,f.authorization.ledgerId);
        const before=await bytes(f.root);const retry=await f.writer.transition(f.authorization,{phase,expectedCheckpointHash:state.checkpointHash});
        assert.equal(retry.status,'ALREADY_COMPLETED_PHASE');assert.deepEqual(await bytes(f.root),before);
        if(index<7)await assert.rejects(access(join(f.writer.directory,ERA_PHASES[index+1]+'.json')));
        if(phase==='retired'){assert.equal(JSON.parse(await readFile(f.paths.ledger)).schemaVersion,1);assert.equal((await f.writer.dryRun()).classification,'PARTIAL_RESUMABLE');}
        if(phase==='archived'){await assert.rejects(access(f.paths.ledger));await access(f.paths.ledger+'.retired-era-'+f.authorization.transitionId);}
        if(phase==='ledger'){const ledger=JSON.parse(await readFile(f.paths.ledger));assert.equal(ledger.snapshot.generation,0);assert.equal(ledger.snapshot.ledgerId,f.authorization.ledgerId);assert.equal(ledger.snapshot.executionEraId,f.authorization.executionEraId);await access(f.paths.ledger+'.wal');assert.deepEqual(JSON.parse(await readFile(f.paths.bootstrap)),f.authorization.marker);assert.equal(JSON.parse(await readFile(f.paths.schedule)).executionEra,undefined);}
    }
    assert.equal(executionEraStartup(f.paths.ledger).executionEraId,f.authorization.executionEraId);
    assert.deepEqual(await readFile(f.paths.program),program);assert.deepEqual(await readFile(f.paths.autoLive),auto);
    const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});assert.equal((await workflow.reserveStart({authorizeStart:true})).state,'START_RESERVED');
});

test('read-only status is stable and does not create namespace or continue a checkpoint',async t=>{
    const f=await eraFixture(t);let before=await bytes(f.root);const initial=await f.writer.transitionStatus(f.authorization);
    assert.equal(initial.completedPhase,null);assert.equal(initial.nextPhase,'authorized');assert.equal(initial.continuationAuthorizationCurrent,true);assert.deepEqual(await bytes(f.root),before);
    await through(f,'forensic');before=await bytes(f.root);const a=await f.writer.transitionStatus(f.authorization),b=await f.writer.transitionStatus(f.authorization);
    assert.equal(a.checkpointHash,b.checkpointHash);assert.deepEqual(await bytes(f.root),before);assert.equal(b.nextPhase,'retired');
});

for(const phase of ['forensic','archived','ledger'])test('P1 authorization rejects valid P2 between phases after '+phase,async t=>{
    const f=await eraFixture(t);await through(f,phase);const current=await f.writer.transitionStatus(f.authorization);
    // Existing production proof provider seam; different already-verified identity.
    f.writer.verifyRuntimeCapability=()=>({proofHash:'e'.repeat(64)});
    await unchangedReject(f,()=>f.writer.transition(f.authorization,{phase:current.nextPhase,expectedCheckpointHash:current.checkpointHash}),{code:'NEW_ERA_AUTHORIZATION_PROOF_CHANGED'});
});

for(const kind of ['HEAD','service','forensic','missing forensic','retirement','Ledger','transition','later artifact','ambiguous stage'])test('between-phase '+kind+' rejects before writes',async t=>{
    const f=await eraFixture(t),completed=kind==='retirement'?'archived':kind==='Ledger'?'ledger':'forensic';await through(f,completed);
    const state=await f.writer.transitionStatus(f.authorization);
    if(kind==='HEAD'||kind==='service'){const inspect=f.writer.host.inspect;f.writer.host={...f.writer.host,inspect:async()=>{const h=await inspect();return kind==='HEAD'?{...h,head:'e'.repeat(40)}:{...h,service:{...h.service,State:'Running'}};}};}
    if(kind==='forensic')await writeFile(join(f.writer.forensic,'manifest.json'),'{}');
    if(kind==='missing forensic')await unlink(join(f.writer.forensic,'blob-'+f.authorization.inventory.find(i=>i.present).sha256));
    if(kind==='retirement')await writeFile(f.paths.ledger+'.retired-era-'+f.authorization.transitionId,'foreign');
    if(kind==='Ledger')await writeFile(f.paths.ledger,'{}');
    if(kind==='transition'){const path=join(f.writer.directory,'forensic.json'),record=JSON.parse(await readFile(path));await writeFile(path,eraRecordBytes(seal({...record,authorization:{...record.authorization,executionEraId:'00000000-0000-0000-0000-000000000000'}})));}
    if(kind==='later artifact')await writeFile(join(f.writer.directory,'activated.json'),'{}');
    if(kind==='ambiguous stage')await writeFile(join(f.writer.directory,'retired.json.stage'),'foreign');
    await unchangedReject(f,()=>f.writer.transition(f.authorization,{phase:state.nextPhase,expectedCheckpointHash:state.checkpointHash}));
});

test('skip, old checkpoint digest, earlier phase, and conflicting authorization all fail closed',async t=>{
    const f=await eraFixture(t),initial=await f.writer.transitionStatus(f.authorization);
    await unchangedReject(f,()=>f.writer.transition(f.authorization,{phase:'ledger',expectedCheckpointHash:initial.checkpointHash}),{code:'NEW_ERA_PHASE_OUT_OF_ORDER'});
    await next(f,'authorized');const current=await f.writer.transitionStatus(f.authorization);
    await unchangedReject(f,()=>f.writer.transition(f.authorization,{phase:'forensic',expectedCheckpointHash:initial.checkpointHash}),{code:'NEW_ERA_CHECKPOINT_CHANGED'});
    const foreign={...f.authorization,transitionId:'00000000-0000-0000-0000-000000000000'};
    await unchangedReject(f,()=>f.writer.transition(foreign,{phase:'forensic',expectedCheckpointHash:current.checkpointHash}));
    await next(f,'forensic');const state=await f.writer.transitionStatus(f.authorization);
    await unchangedReject(f,()=>f.writer.transition(f.authorization,{phase:'authorized',expectedCheckpointHash:state.checkpointHash}),{code:'NEW_ERA_PHASE_OUT_OF_ORDER'});
});

for(const [phase,point] of [['forensic','partial-written'],['archived','archived'],['ledger','opened'],['schedule','before-schedule-replace']])test('interruption inside '+phase+' resumes only that phase and returns',async t=>{
    const f=await eraFixture(t);const prior=ERA_PHASES[ERA_PHASES.indexOf(phase)-1];await through(f,prior);const state=await f.writer.transitionStatus(f.authorization);let interrupted=false;
    f.writer.hook=p=>{if(!interrupted&&p===point){interrupted=true;throw Error('FIXTURE_INTERRUPTION');}};
    await assert.rejects(f.writer.transition(f.authorization,{phase,expectedCheckpointHash:state.checkpointHash}),/FIXTURE_INTERRUPTION/);assert.ok(interrupted);
    f.writer=new NewExecutionEra(f.options);const partial=await f.writer.transitionStatus(f.authorization);assert.equal(partial.nextPhase,phase);
    const result=await f.writer.transition(f.authorization,{phase,expectedCheckpointHash:partial.checkpointHash});assert.equal(result.completedPhase,phase);
    const after=ERA_PHASES[ERA_PHASES.indexOf(phase)+1];await assert.rejects(access(join(f.writer.directory,after+'.json')));
});

test('partial transition startup and ControlledStart cannot cross operator checkpoint',async t=>{
    const f=await eraFixture(t);await through(f,'forensic');const before=await bytes(f.root);
    assert.throws(()=>executionEraStartup(f.paths.ledger),{code:'EXECUTION_ERA_RESUME_REQUIRED'});
    const workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});await assert.rejects(workflow.reserveStart({authorizeStart:true}));assert.deepEqual(await bytes(f.root),before);
});

test('production CLI rejects unscoped transition before host/proof or durable operations',async t=>{
    const f=await eraFixture(t),file=join(f.root,'authorization-input.json');await writeFile(file,JSON.stringify(f.authorization));const before=await bytes(f.root);
    const result=spawnSync(process.execPath,['tools/new-execution-era.mjs','transition','--root',f.root,'--authorization-file',file,'--authorization-hash',hash(f.authorization)],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,1);assert.match(result.stderr,/NEW_ERA_EXPLICIT_PHASE_AND_CHECKPOINT_REQUIRED/);assert.deepEqual(await bytes(f.root),before);
});

test('actual permanent verifier: approved P2 rejects P1 continuation after forensic return',async t=>{
    const f=await eraFixture(t),source=process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY;
    assert.ok(source,'explicit reviewed ERA20 bundle required');
    // Genuine retained SYSTEM artifacts, separate approvals for fixture manifests;
    // compatibility is the fixture context, never an OS capability claim.
    const manifest=JSON.parse(await readFile(join(source,'manifest.json'))),p1=join(f.root,'proof1'),p2=join(f.root,'proof2');
    await cp(source,p1,{recursive:true});await cp(source,p2,{recursive:true});await appendFile(join(p2,'manifest.json'),'\n');
    const policy=new Map([[p1,hash(await readFile(join(p1,'manifest.json')))],[p2,hash(await readFile(join(p2,'manifest.json')))]]);
    const compatibility={machine:manifest.machine,volume:{volume:manifest.volume,volumeSerial:manifest.volumeSerial,filesystem:'NTFS',local:true}};
    f.writer.verifyRuntimeCapability=(path,options)=>verifyPermanentCapability(path,{...options,approvalHash:policy.get(path),compatibility});
    f.writer.runtimeCapabilityProof=p1;f.writer.native={capability:()=>({volume:manifest.volume})};
    f.authorization=await f.writer.plan({principal:'TEMP-phase-review',approvedHead:f.authorization.approvedHead,approvedBranch:f.authorization.approvedBranch,expectedInventoryHash:f.view.inventoryHash,authorizeNewEra:true,retireWholeLegacyDomain:true});
    await through(f,'forensic');const state=await f.writer.transitionStatus(f.authorization);
    assert.notEqual(f.writer.verifyRuntimeCapability(p1,{serviceIdentity:'LocalSystem'}).proofHash,f.writer.verifyRuntimeCapability(p2,{serviceIdentity:'LocalSystem'}).proofHash);
    f.writer.runtimeCapabilityProof=p2;
    await unchangedReject(f,()=>f.writer.transition(f.authorization,{phase:'retired',expectedCheckpointHash:state.checkpointHash}),{code:'NEW_ERA_AUTHORIZATION_PROOF_CHANGED'});
});

test('phased orchestration preserves original production write-hook sequence without new durable records',async t=>{
    const legacy=await eraFixture(t),phased=await eraFixture(t),traces=[];
    for(const f of [legacy,phased]){
        const trace=[];f.writer.hook=(point,path)=>trace.push(point+'/'+(path?relative(f.root,path).replaceAll(f.authorization.transitionId,'TRANSITION').replace(/blob-[a-f0-9]{64}/g,'blob-HASH'):''));
        if(f===legacy)await f.writer.transition(f.authorization);else await through(f,'activated');
        traces.push(trace);assert.deepEqual((await readdir(f.writer.directory)).sort(),ERA_PHASES.map(p=>p+'.json').sort());
    }
    assert.deepEqual(traces[1],traces[0]);
});

test('fresh process abrupt loss inside forensic resumes to forensic return, never retirement',async t=>{
    const f=await eraFixture(t);await through(f,'authorized');const state=await f.writer.transitionStatus(f.authorization);
    const input=join(f.root,'phase-child-input.json');await writeFile(input,JSON.stringify({root:f.root,paths:f.paths,authorization:f.authorization,phase:'forensic',checkpointHash:state.checkpointHash}));
    const result=spawnSync(process.execPath,['test-support/new-era-phased-abrupt-child.mjs',input],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(result.status,73,result.stderr);assert.match(result.stdout,/FIXTURE_ABRUPT_PHASE/);
    f.writer=new NewExecutionEra(f.options);const partial=await f.writer.transitionStatus(f.authorization);
    assert.equal(partial.nextPhase,'forensic');assert.equal(partial.canonicalResumeRequired,true);
    const completed=await f.writer.transition(f.authorization,{phase:'forensic',expectedCheckpointHash:partial.checkpointHash});
    assert.equal(completed.completedPhase,'forensic');await assert.rejects(access(join(f.writer.directory,'retired.json')));
});

test('actual CLI with TEMP-only host/native adapters returns forensic checkpoint and structured status',async t=>{
    const f=await eraFixture(t),p=recoveryPaths(f.root);
    const paths={ledger:p.ledger,ledgerLock:p.ledgerLock,bootstrap:p.marker,authority:p.authority,authorityLock:p.authorityLock,
        scheduledLock:p.scheduledLock,scheduledJournal:p.scheduled,schedule:p.schedule,program:p.program,autoLive:p.auto,
        studio:p.studio,mediaManifest:p.mediaManifest,configuration:join(f.root,'public/config/config.json')};
    for(const [key,path] of Object.entries(paths)){if(!f.paths[key])continue;const content=await readFile(f.paths[key]).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(content===null)continue;await mkdir(dirname(path),{recursive:true});await writeFile(path,content);}
    f.paths=paths;f.writer=new NewExecutionEra({...f.options,paths});const view=await f.writer.dryRun();assert.equal(view.eligible,true,view.reason);
    f.authorization=await f.writer.plan({principal:'TEMP-CLI-review',approvedHead:f.authorization.approvedHead,approvedBranch:f.authorization.approvedBranch,expectedInventoryHash:view.inventoryHash,authorizeNewEra:true,retireWholeLegacyDomain:true});
    const input=join(f.root,'phase-cli-input.json'),auth=join(f.root,'phase-cli-authorization.json');await writeFile(input,JSON.stringify({root:f.root}));await writeFile(auth,JSON.stringify(f.authorization));
    const env={...process.env,LIVEZONE_PHASE_CLI_FIXTURE:input};
    const invoke=(action,extra=[])=>spawnSync(process.execPath,['--import','./test-support/new-era-phased-cli-preload.mjs','tools/new-execution-era.mjs',action,'--root',f.root,'--authorization-file',auth,'--authorization-hash',hash(f.authorization),...extra],{env,encoding:'utf8',windowsHide:true,timeout:30000});
    let child=invoke('transition-status');assert.equal(child.status,0,child.stderr);let status=JSON.parse(child.stdout);assert.equal(status.readOnly,true);
    for(const phase of ['authorized','forensic']){child=invoke('transition',['--phase',phase,'--expected-checkpoint-hash',status.checkpointHash]);assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).completedPhase,phase);child=invoke('transition-status');assert.equal(child.status,0,child.stderr);status=JSON.parse(child.stdout);}
    assert.equal(status.completedPhase,'forensic');assert.equal(status.nextPhase,'retired');await assert.rejects(access(join(f.writer.directory,'retired.json')));
    await writeFile(join(f.writer.forensic,'manifest.json'),'foreign');const before=await bytes(f.root);child=invoke('transition-status');assert.equal(child.status,1);status=JSON.parse(child.stdout);assert.equal(status.status,'REVIEW_REQUIRED');assert.equal(status.continuationAuthorizationCurrent,false);assert.equal(status.checkpointHash,undefined);assert.deepEqual(await bytes(f.root),before);
});

test('foreign Ledger appearing after archival rejects before fresh Ledger initialization',async t=>{
    const f=await eraFixture(t);await through(f,'archived');const state=await f.writer.transitionStatus(f.authorization);
    await writeFile(f.paths.ledger,'{"foreignLedger":true}');
    await unchangedReject(f,()=>f.writer.transition(f.authorization,{phase:'ledger',expectedCheckpointHash:state.checkpointHash}));
    await assert.rejects(access(join(f.writer.directory,'ledger.json')));
});

test('zero-byte authorization stage resumes to authorized checkpoint without forensic writes',async t=>{
    const f=await eraFixture(t),state=await f.writer.transitionStatus(f.authorization);
    f.writer.hook=point=>{if(point==='opened')throw Error('FIXTURE_EMPTY_PHASE_STAGE');};
    await assert.rejects(f.writer.transition(f.authorization,{phase:'authorized',expectedCheckpointHash:state.checkpointHash}),/FIXTURE_EMPTY_PHASE_STAGE/);
    f.writer=new NewExecutionEra(f.options);const partial=await f.writer.transitionStatus(f.authorization);
    assert.equal(partial.partialPhase,'authorized');assert.equal(partial.canonicalResumeRequired,true);
    const completed=await f.writer.transition(f.authorization,{phase:'authorized',expectedCheckpointHash:partial.checkpointHash});
    assert.equal(completed.completedPhase,'authorized');await assert.rejects(access(join(f.writer.forensic,'manifest.json')));
});

test('C-R4 RED to GREEN: forensic invocation returns before retirement and Ledger',async t=>{
    const f=await eraFixture(t);
    const status=await f.writer.transitionStatus(f.authorization);
    const result=await f.writer.transition(f.authorization,{phase:'authorized',expectedCheckpointHash:status.checkpointHash});
    assert.equal(result.completedPhase,'authorized');
    const forensic=await f.writer.transition(f.authorization,{phase:'forensic',expectedCheckpointHash:result.checkpointHash});
    assert.equal(forensic.completedPhase,'forensic');assert.equal(forensic.nextPhase,'retired');
    await access(join(f.writer.forensic,'manifest.json'));
    await assert.rejects(access(join(f.writer.directory,'retired.json')));
    await assert.rejects(access(join(f.writer.directory,'ledger.json')));
    assert.equal((await f.writer.dryRun()).classification,'PARTIAL_RESUMABLE');
});
