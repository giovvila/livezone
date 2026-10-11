import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {eraFixture,HEAD,BRANCH} from './NewExecutionEraFixture.js';
import {assertNativeTestTarget} from './NativeTempGuard.mjs';
import {executionEraStartup,eraAdmits} from '../server/recovery/ExecutionEraContract.js';
import {hash,inspectV2} from '../server/scheduler/ScheduledEntryLedgerV2Protocol.js';
import {identityForScheduledEvent} from '../server/scheduler/ScheduledEventIdentity.js';

const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const execute=async(input,env)=>new Promise((ok,no)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./new-era-abrupt-child.mjs',import.meta.url)),input],
        {env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const timer=setTimeout(()=>{child.kill();no(Error('MATRIX_CHILD_TIMEOUT'));},600000);
    child.once('error',no);child.once('close',(status,signal)=>{clearTimeout(timer);ok({status,signal,stdout,stderr});});
});
async function files(root,path=root){
    const result=[];
    for(const name of await readdir(path)){
        const full=join(path,name),stat=await lstat(full);assert.equal(stat.isSymbolicLink(),false);
        if(stat.isDirectory())result.push(...await files(root,full));
        else result.push({path:relative(root,full),size:stat.size,sha256:hash(await readFile(full))});
    }
    return result.sort((a,b)=>a.path.localeCompare(b.path));
}
for(const item of config.rows){
    const callbacks=[],t={after:callback=>callbacks.push(callback)};
    const result={boundary:item.boundary,native:true,status:'FAIL',worker:config.worker};
    const started=Date.now();
    try{
        const f=await eraFixture(t,{native:true});
        result.tempRoot=f.root;
        for(const path of Object.values(f.paths))assertNativeTestTarget(path);
        result.nativeTargetsVerifiedTemp=true;
        if(item.boundary.startsWith('archive/scheduledJournal/')||item.boundary.startsWith('forensic/scheduledJournal/')){
            await writeFile(f.paths.scheduledJournal,JSON.stringify({version:1,active:null})+'\n');
            const view=await f.writer.dryRun();
            f.authorization=await f.writer.plan({principal:'TEMP-matrix-operator',approvedHead:HEAD,approvedBranch:BRANCH,
                expectedInventoryHash:view.inventoryHash,authorizeNewEra:true,retireWholeLegacyDomain:true});
            result.fixtureVariant='PRESENT_LEGACY_SCHEDULED_JOURNAL';
        }
        const original=Object.fromEntries(await Promise.all(['program','autoLive','authority'].map(async key=>[key,await readFile(f.paths[key])])));
        const input=join(f.root,'crash-input.json');
        const scheduledJournalHash=item.boundary.startsWith('forensic/scheduledJournal/')?hash(await readFile(f.paths.scheduledJournal)):undefined;
        await writeFile(input,JSON.stringify({root:f.root,paths:f.paths,authorization:f.authorization,native:true,operation:'offline',boundary:item.boundary,scheduledJournalHash}));
        const env={...process.env,LIVEZONE_NATIVE_TEST_ROOTS:JSON.stringify([f.root])};delete env.NODE_TEST_CONTEXT;
        const child=await execute(input,env);result.child=child;
        assert.equal(child.status,73,child.stderr);assert.ok(child.stdout.includes('"abrupt":true'));
        result.filesDurableBeforeRecovery=await files(f.root);
        result.classificationAfterRestart=(await f.writer.inspectRecovery({authorization:f.authorization})).state;
        result.ownerState='OFFLINE_NO_RUNTIME_OWNER';
        result.recoveryAction='PRODUCTION_SAME_AUTHORIZATION_OFFLINE_RETRY';
        await f.writer.transition(f.authorization);
        const era=executionEraStartup(f.paths.ledger),ledger=await inspectV2(f.paths.ledger);
        for(const key of ['transitionId','executionEraId','ledgerId','retirementHash'])assert.equal(era[key],f.authorization[key]);
        assert.equal(ledger.current.ledgerId,era.ledgerId);assert.equal(ledger.records.filter(r=>r.type==='BASE').length,1);
        assert.equal(ledger.owner,null);assert.equal(ledger.current.generation,0);assert.equal(ledger.current.entries.length,0);
        for(const key of ['program','autoLive','authority'])assert.deepEqual(await readFile(f.paths[key]),original[key]);
        const program=JSON.parse(original.program),auto=JSON.parse(original.autoLive);
        assert.equal(program.generation,47);assert.equal(program.programState,'PRESENT');assert.equal(program.acceptedAuthorityEpoch,20);
        assert.equal(auto.enabled,true);assert.equal(auto.armed,false);
        const schedule=JSON.parse(await readFile(f.paths.schedule));
        for(const event of schedule.events.filter(e=>e.type==='source.live'))assert.equal(eraAdmits(era,identityForScheduledEvent(event)),false);
        assert.equal(eraAdmits(era,{identitySchema:1,eventId:'unknown-legacy-domain-identity'}),false);
        result.finalExecutionEraId=era.executionEraId;result.finalTransitionId=era.transitionId;
        result.finalLedgerId=era.ledgerId;result.finalAuthority=JSON.parse(original.authority).epoch;
        result.authoritySuccessor='NOT_ALLOCATED_BY_OFFLINE_OPERATION';
        result.forensicManifestHash=hash(await readFile(join(f.writer.forensic,'manifest.json')));
        result.retirementHash=era.retirementHash;result.status='PASS';
    }catch(error){result.error={code:error.code,message:error.message,stack:error.stack};}
    finally{
        result.elapsedMs=Date.now()-started;
        await writeFile(join(config.evidenceDirectory,'matrix-'+String(item.index).padStart(4,'0')+'.json'),JSON.stringify(result,null,2)+'\n');
        for(const callback of callbacks)await callback();
    }
    process.stdout.write(JSON.stringify({boundary:result.boundary,status:result.status,elapsedMs:result.elapsedMs})+'\n');
    if(result.status!=='PASS'){process.exitCode=1;break;}
}
