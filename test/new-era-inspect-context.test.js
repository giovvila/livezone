import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {join,dirname,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {eraFixture,HEAD,BRANCH} from '../test-support/NewExecutionEraFixture.js';
import {paths as recoveryPaths} from '../server/recovery/RecoveryContract.js';
import {NewExecutionEra} from '../server/recovery/NewExecutionEra.js';
import {NewEraRecoveryWorkflow} from '../server/recovery/NewEraRecoveryWorkflow.js';
import {componentLaunch} from '../test-support/NewEraControlledRuntime.js';
import {controlledStart} from '../server/recovery/ControlledStart.js';
import {hash,seal} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {ERA_PHASES,eraRecordBytes} from '../server/recovery/ExecutionEraContract.js';
const states=['AUTHORIZED','FORENSIC_DURABLE','RETIREMENT_DURABLE','ERA_INTENT_DURABLE','LEGACY_ARCHIVED','LEDGER_INITIALIZED','SCHEDULE_BOUND','ERA_ACTIVATED'];
async function fixture(t){
    const f=await eraFixture(t),p=recoveryPaths(f.root);
    const paths={ledger:p.ledger,ledgerLock:p.ledgerLock,bootstrap:p.marker,authority:p.authority,authorityLock:p.authorityLock,
        scheduledLock:p.scheduledLock,scheduledJournal:p.scheduled,schedule:p.schedule,program:p.program,autoLive:p.auto,
        studio:p.studio,mediaManifest:p.mediaManifest,configuration:join(f.root,'public/config/config.json')};
    for(const [key,path]of Object.entries(paths)){
        await mkdir(dirname(path),{recursive:true});
        if(f.paths[key])try{await writeFile(path,await readFile(f.paths[key]));}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    f.paths=paths;f.options={...f.options,paths};f.writer=new NewExecutionEra(f.options);
    f.view=await f.writer.dryRun();assert.equal(f.view.eligible,true,f.view.reason);
    f.authorization=await f.writer.plan({principal:'TEMP inspect reviewer',approvedHead:HEAD,approvedBranch:BRANCH,
        expectedInventoryHash:f.view.inventoryHash,authorizeNewEra:true,retireWholeLegacyDomain:true});
    f.authFile=join(f.root,'operator-authorization.json');await writeFile(f.authFile,JSON.stringify(f.authorization));
    f.input=join(f.root,'operator-fixture.json');return f;
}
async function through(f,last){for(const phase of ERA_PHASES){const status=await f.writer.transitionStatus(f.authorization);
    await f.writer.transition(f.authorization,{phase,expectedCheckpointHash:status.checkpointHash});if(phase===last)return;}}
async function census(f){const files={};async function walk(dir){for(const name of await readdir(dir)){const path=join(dir,name);
    if((await lstat(path)).isDirectory())await walk(path);else files[relative(f.root,path)]=hash(await readFile(path));}}await walk(f.root);return files;}
async function cli(f,{auth=f.authorization,expectedHead=HEAD,hostHead=HEAD,hostRoot,proofHash='f'.repeat(64),missingProof=false,noAuth=false,legacy=false,args=[]}={}){
    await writeFile(f.authFile,JSON.stringify(auth));
    await writeFile(f.input,JSON.stringify({root:f.root,hostHead,hostRoot,hostBranch:BRANCH,proofHash,missingProof}));
    let entry='tools/new-execution-era.mjs';
    if(legacy){
        const raw=await readFile(new URL('../test-support/fixtures/new-era-inspect-r7-cli.txt',import.meta.url),'utf8');
        const source=raw.replace(/(['"])\.\.\/server\/([^'"]+)\1/g,(_,q,path)=>q+new URL('../server/'+path,import.meta.url).href+q);
        entry=join(f.root,'legacy-r7-cli.mjs');await writeFile(entry,source);
    }
    const before=await census(f);
    const result=spawnSync(process.execPath,['--import','./test-support/new-era-inspect-cli-preload.mjs',entry,'inspect','--root',f.root,
        ...(expectedHead===null?[]:['--expected-head',expectedHead]),...(noAuth?[]:['--authorization-file',f.authFile,'--authorization-hash',hash(auth)]),...args],
        {encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,LIVEZONE_INSPECT_CLI_FIXTURE:f.input}});
    assert.equal(result.error,undefined);assert.deepEqual(await census(f),before);
    const observed=result.stderr.match(/INSPECT_OBSERVATION=(\{[^\n]+\})/);assert.ok(observed,result.stderr);
    const counts=JSON.parse(observed[1]);assert.ok(Object.values(counts).every(n=>n===0),JSON.stringify(counts));
    return {...result,value:result.status===0?JSON.parse(result.stdout):null,counts};
}
test('exact R7 actual CLI AUTHORIZED RED to GREEN with zero forbidden effects',async t=>{
    const f=await fixture(t);await through(f,'authorized');
    const red=await cli(f,{legacy:true});assert.equal(red.status,1);assert.match(red.stderr,/NEW_ERA_RECOVERY_CONTEXT/);
    const green=await cli(f);assert.equal(green.status,0,green.stderr);assert.equal(green.value.state,'AUTHORIZED');
    assert.equal(green.value.nextPhase,'forensic');assert.equal(green.value.proofHash,f.authorization.authorizedProofHash);
});
test('pre-transition inspection without authorization remains observational and grants no continuation',async t=>{
    const f=await fixture(t),r=await cli(f,{noAuth:true});assert.equal(r.status,0,r.stderr);
    assert.equal(r.value.state,'NO_TRANSITION');assert.equal(r.value.nextAction,'DRYRUN_AND_EXPLICIT_AUTHORIZATION');
    assert.equal(r.value.continuationAuthorizationCurrent,undefined);assert.equal(f.view.classification,'EXACT_ELIGIBLE_LEGACY_STATE');
});
for(const [i,phase]of ERA_PHASES.entries())test('actual CLI observes '+phase+' checkpoint after fresh process restart',async t=>{
    const f=await fixture(t);await through(f,phase);
    const first=await cli(f),second=await cli(f);assert.equal(first.status,0,first.stderr);assert.deepEqual(second.value,first.value);
    assert.equal(first.value.state,states[i]);assert.equal(first.value.completedPhase,phase);assert.equal(first.value.nextPhase,ERA_PHASES[i+1]??null);
    for(const key of ['transitionId','executionEraId','ledgerId','retirementHash'])assert.equal(first.value[key],f.authorization[key]);
});
for(const key of ['repository','approvedHead','transitionId','executionEraId','authorizedProofHash','ledgerId','retirementHash'])
test('actual CLI rejects foreign expected authorization '+key+' without effects',async t=>{
    const f=await fixture(t);await through(f,'authorized');
    const auth={...f.authorization,[key]:key==='approvedHead'?'e'.repeat(40):key==='authorizedProofHash'?'e'.repeat(64):key==='repository'?f.root+'-foreign':'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'};
    const r=await cli(f,{auth});assert.equal(r.status,1);assert.match(r.stderr,/NEW_ERA_RECOVERY_CONTEXT|NEW_ERA_AUTHORIZATION_INVALID/);
});
for(const kind of ['expected HEAD','current HEAD','current root','P2 proof','missing proof','missing authorization'])
test('actual CLI rejects stale '+kind+' without effects',async t=>{
    const f=await fixture(t);await through(f,'authorized');
    const options=kind==='expected HEAD'?{expectedHead:'e'.repeat(40)}:kind==='current HEAD'?{hostHead:'e'.repeat(40)}:
        kind==='current root'?{hostRoot:f.root+'-foreign'}:kind==='P2 proof'?{proofHash:'e'.repeat(64)}:kind==='missing proof'?{missingProof:true}:{noAuth:true};
    const r=await cli(f,options);assert.equal(r.status,1);
    assert.match(r.stderr,/REPOSITORY_BRANCH_HEAD_MISMATCH|NEW_ERA_RECOVERY_CONTEXT|NEW_ERA_AUTHORIZATION_PROOF_CHANGED|LOCALSYSTEM_CAPABILITY_PROOF_REQUIRED|NEW_ERA_AUTHORIZATION_FILE_AND_HASH_REQUIRED/);
});
for(const kind of ['forensic','retirement','Ledger','lineage','missing forensic'])test('actual CLI rejects changed '+kind+' evidence without effects',async t=>{
    const f=await fixture(t);await through(f,kind==='Ledger'?'ledger':'forensic');
    const path=kind==='forensic'||kind==='missing forensic'?join(f.writer.forensic,'manifest.json'):kind==='retirement'?join(f.writer.directory,'retired.json'):
        kind==='Ledger'?f.paths.ledger:join(f.writer.directory,'forensic.json');
    if(kind==='missing forensic')await (await import('node:fs/promises')).unlink(path);
    else if(kind==='lineage'){const record=JSON.parse(await readFile(path));record.previous='foreign';delete record.checksum;await writeFile(path,eraRecordBytes(seal(record)));}
    else await writeFile(path,'{}');
    const r=await cli(f);assert.equal(r.status,1);assert.match(r.stderr,/NEW_ERA_FORENSIC_CHANGED|NEW_ERA_RECOVERY_LINEAGE|NEW_ERA_EVIDENCE_CHANGED|NEW_ERA_UNEXPECTED_LATER_ARTIFACT|EXECUTION_ERA_CHECKSUM/);
});
test('actual CLI READY anchor inspection is observational and does not assert live ownership',async t=>{
    const f=await fixture(t);await through(f,'activated');
    f.workflow=new NewEraRecoveryWorkflow({writer:f.writer,authorization:f.authorization});const runtime=componentLaunch(f);
    try{await controlledStart({workflow:f.workflow,authorizeStart:true,authorizeReconciliation:true,launch:runtime.launch});
        const r=await cli(f);assert.equal(r.status,0,r.stderr);assert.equal(r.value.state,'READY_ANCHOR_DURABLE');
        assert.equal(r.value.nextAction,'START_REVIEW');assert.equal(r.value.liveOwnerStatus,'NOT_PROVEN_BY_READ_ONLY_INSPECTION');
    }finally{await runtime.close();}
});
test('post-activation current P2 does not rebind historical P1 authorization',async t=>{
    const f=await fixture(t);await through(f,'activated');const r=await cli(f,{proofHash:'e'.repeat(64)});
    assert.equal(r.status,0,r.stderr);assert.equal(r.value.authorizedProofHash,'f'.repeat(64));assert.equal(r.value.proofHash,'e'.repeat(64));
});
test('missing expected HEAD remains fail closed at the CLI entry point',async t=>{
    const f=await fixture(t);const r=await cli(f,{expectedHead:null});assert.equal(r.status,1);assert.match(r.stderr,/EXPLICIT_RECOVERY_HEAD_REQUIRED/);
});
test('initial staging remains REVIEW_REQUIRED without protocol advancement',async t=>{
    const f=await fixture(t);await mkdir(f.writer.directory);await writeFile(join(f.writer.directory,'authorized.json.stage'),'');
    const r=await cli(f);assert.equal(r.status,0,r.stderr);assert.equal(r.value.state,'STAGING_REVIEW_REQUIRED');
    assert.equal(r.value.reviewRequired,true);assert.equal(r.value.nextAction,'CANONICAL_REVIEW');
});
test('owner anchor missing after activation remains descriptive REVIEW_REQUIRED',async t=>{
    const f=await fixture(t);await through(f,'activated');
    await writeFile(f.paths.authorityLock,JSON.stringify({authorityProcessSession:f.authorization.transitionId}));
    const r=await cli(f);assert.equal(r.status,0,r.stderr);assert.equal(r.value.state,'AUTHORITY_TRANSITIONING_REVIEW_REQUIRED');
    assert.equal(r.value.reviewRequired,true);assert.equal(r.value.nextAction,'CANONICAL_REVIEW');
});
test('runbook inspect commands carry explicit expected context and retain phase STOP checkpoints',async()=>{
    const runbook=await readFile(new URL('../docs/NEW-ERA-07-FUTURE-REAL-RUNBOOK.txt',import.meta.url),'utf8');
    const commands=runbook.split(/\r?\n/).filter(line=>/^node tools\/new-execution-era\.mjs inspect /.test(line));
    assert.equal(commands.length,2);for(const command of commands)assert.match(command,/--expected-head \$head/);
    assert.match(commands[1],/--authorization-file \$authFile --authorization-hash \$authHash/);
    assert.match(runbook,/does not replace the transition-status command/);
    for(const state of states)assert.ok(runbook.includes(state));
    assert.ok(runbook.includes('READY_ANCHOR_DURABLE'));assert.match(runbook,/canonicalResumeRequired/);
});
