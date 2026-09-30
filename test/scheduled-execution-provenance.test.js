import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import Repository from '../server/scheduler/ScheduledLiveExecutionRepository.js';
import {digest,repositoryIdentity,journalEnvelope,validateLock,validateJournal}
    from '../server/scheduler/ScheduledExecutionProvenance.js';
import {reconcileScheduledExecutionLock as reconcile,classifyScheduledLock}
    from '../server/scheduler/ReconcileScheduledExecutionLock.js';
import {createScheduledLiveTransaction,scheduledLiveTransactionEnvelope,transitionScheduledLiveTransaction}
    from '../server/scheduler/ScheduledLiveExecutionTransaction.js';
import {createProgramOutputEnvelope} from '../public/js/program-output/ProgramOutputEnvelope.js';

function transaction() {
    const at='2026-09-25T06:00:00.000Z';
    const program=createProgramOutputEnvelope({version:1,publisherSessionId:'publisher',revision:7,
        publishedAt:at,committedAt:at,scene:{id:'scene',name:'PROGRAM',type:'MEDIA'},
        source:{id:'media',kind:'media',url:'https://example.test/source.mp4'},
        playback:{initialTime:27,duration:120,playing:true,ended:false,state:'playing',startedAt:at},
        graphics:{items:[]},transition:{type:'cut',durationMs:0}});
    assert.ok(program);
    return createScheduledLiveTransaction({eventId:'event',sourceId:'source',program,
        manualIntentRevision:11,capturedAt:590000});
}
async function fixture(t) {
    const dir=await mkdtemp(join(tmpdir(),'lz-provenance-'));
    const repositories=[];
    t.after(async()=>{for(const r of repositories)await r.close();await rm(dir,{recursive:true,force:true});});
    const path=join(dir,'scheduled.json'),authorityPath=join(dir,'autolive.execution');
    const authority={available:true,path:authorityPath,authorityEpoch:20,authorityProcessSession:'authority-session'};
    const make=(options={})=>{const r=new Repository({path,authority,...options});repositories.push(r);return r;};
    return {dir,path,authorityPath,authority,make};
}
async function abandoned(t,{legacy=false,journal=false}={}) {
    const h=await fixture(t);
    let lock;
    if(legacy) lock={version:1,processSession:'legacy-session'};
    else {const r=h.make();await r.initialize();assert.equal(r.status,'READY');
        if(journal)await r.write(transaction());
        lock=JSON.parse(await readFile(h.path+'.lock','utf8'));await r.close();}
    if(legacy && journal) await writeFile(h.path,JSON.stringify(scheduledLiveTransactionEnvelope(transaction())));
    await writeFile(h.path+'.lock',JSON.stringify(lock));
    await writeFile(h.authorityPath,JSON.stringify({epoch:20}));
    if(!legacy)await writeFile(h.authorityPath+'.lock',JSON.stringify({pid:lock.processId,authorityProcessSession:lock.authorityProcessSession}));
    h.lock=lock;
    h.expected=async()=>{
        const hash=async path=>{try{return digest(await readFile(path));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
        return {lockHash:await hash(h.path+'.lock'),repositoryId:repositoryIdentity(h.path),processSession:lock.processSession,
            journalHash:await hash(h.path),authorityHash:await hash(h.authorityPath),authorityLockHash:await hash(h.authorityPath+'.lock')};
    };
    h.options={path:h.path,authorityPath:h.authorityPath,operationId:'fixture-operation',expected:await h.expected(),
        proveOffline:async()=>({absent:true,fixture:true}),reserve:async()=>()=>{},isAlive:()=>false};
    return h;
}

test('new lock binds canonical authority and process with path-specific stable identity',async t=>{
    const h=await fixture(t),r=h.make();await r.initialize();
    const lock=JSON.parse(await readFile(h.path+'.lock','utf8'));
    assert.equal(validateLock(lock,repositoryIdentity(h.path)),'VERIFIABLE');
    assert.equal(lock.processId,process.pid);assert.equal(lock.authorityEpoch,20);
    assert.equal(lock.authorityProcessSession,h.authority.authorityProcessSession);
    assert.equal(lock.authorityId,repositoryIdentity(h.authorityPath));assert.equal(lock.initialJournalHash,null);
    assert.notEqual(repositoryIdentity(join(h.dir,'other.json')),lock.repositoryId);
    await r.close();const next=h.make();await next.initialize();
    assert.equal(next.owner.repositoryId,lock.repositoryId);assert.notEqual(next.owner.processSession,lock.processSession);
});
test('missing canonical authority refuses before creating files',async t=>{
    const h=await fixture(t),r=h.make({authority:undefined});await r.initialize();
    assert.equal(r.error,'SCHEDULED_AUTHORITY_UNAVAILABLE');assert.deepEqual(await readdir(h.dir),[]);
});
test('journal carries provenance and stable transaction identity across phases',async t=>{
    const h=await fixture(t),r=h.make();await r.initialize();const tx=transaction();await r.write(tx);
    const first=JSON.parse(await readFile(h.path,'utf8'));validateJournal(first,r.owner.repositoryId);
    assert.equal(first.provenance.processSession,r.owner.processSession);
    assert.equal(first.provenance.authorityEpoch,20);assert.equal('processId' in first.provenance,false);
    await r.write(transitionScheduledLiveTransaction(tx,'begin-preroll',{manualIntentRevision:11}));
    const second=JSON.parse(await readFile(h.path,'utf8'));
    assert.equal(second.provenance.transactionId,first.provenance.transactionId);
    assert.notEqual(second.checksum,first.checksum);
});
test('clean next-epoch restart preserves diagnostic journal bytes and captured PROGRAM',async t=>{
    const h=await fixture(t),r=h.make();await r.initialize();const tx=transaction();await r.write(tx);await r.close();
    const bytes=await readFile(h.path,'utf8');h.authority.authorityEpoch++;h.authority.authorityProcessSession='next-authority';
    const next=h.make();await next.initialize();assert.equal(next.status,'READY');assert.deepEqual(next.record,tx);
    assert.equal(next.record.executionAllowed,false);assert.equal(next.record.serverTake,false);
    assert.equal(next.owner.initialJournalHash,digest(bytes));assert.equal(await readFile(h.path,'utf8'),bytes);
});
for(const change of ['epoch','session','unavailable','closed'])test('pending write refuses changed authority: '+change,async t=>{
    const h=await fixture(t),r=h.make({hook(stage){if(stage==='before-replace') {
        if(change==='epoch')h.authority.authorityEpoch++;
        if(change==='session')h.authority.authorityProcessSession='changed';
        if(change==='unavailable')h.authority.available=false;
        if(change==='closed')h.authority.closed=true;
    }}});await r.initialize();await assert.rejects(r.write(transaction()),/SCHEDULED_AUTHORITY/);
    await assert.rejects(readFile(h.path),{code:'ENOENT'});
});
for(const change of ['authorityId','authorityEpoch','authorityProcessSession','repositoryId','checksum','legacy'])
test('startup refuses incompatible journal: '+change,async t=>{
    const h=await fixture(t),r=h.make();await r.initialize();await r.write(transaction());const owner={...r.owner};await r.close();
    if(change==='authorityEpoch')owner.authorityEpoch++;
    if(change==='authorityId'||change==='repositoryId')owner[change]=digest('different');
    if(change==='authorityProcessSession')owner.authorityProcessSession='different';
    let journal=journalEnvelope(transaction(),owner);
    if(change==='checksum')journal.checksum=digest('bad');
    if(change==='legacy')journal=scheduledLiveTransactionEnvelope(transaction());
    const bytes=JSON.stringify(journal);await writeFile(h.path,bytes);
    const next=h.make();await next.initialize();assert.equal(next.status,'CORRUPT');assert.equal(next.record,null);
    if(change==='legacy')assert.equal(next.error,'LEGACY_JOURNAL_REVIEW_REQUIRED');
    assert.equal(await readFile(h.path,'utf8'),bytes);
});
for(const bytes of ['{"version":1,"processSession":"legacy"}','invalid','{"schemaVersion":999}'])
test('existing legacy/corrupt/unsupported lock remains blocking: '+bytes,async t=>{
    const h=await fixture(t);await writeFile(h.path+'.lock',bytes);const r=h.make();await r.initialize();
    assert.equal(r.status,'LOCKED');await r.close();assert.equal(await readFile(h.path+'.lock','utf8'),bytes);
});
test('replacement lock is neither written through nor removed on close',async t=>{
    const h=await fixture(t),r=h.make();await r.initialize();await writeFile(h.path+'.lock','replacement');
    await assert.rejects(r.write(transaction()),/SCHEDULED_LOCK_CHANGED/);await r.close();
    assert.equal(await readFile(h.path+'.lock','utf8'),'replacement');
});
for(const journal of [false,true])test('new lock archives with absent PID and consistent journal='+journal,async t=>{
    const h=await abandoned(t,{journal}),bytes=await readFile(h.path+'.lock','utf8');
    const result=await reconcile(h.options);assert.equal(await readFile(result.archive,'utf8'),bytes);
    assert.equal(JSON.parse(await readFile(result.audit,'utf8')).contract.state,'PREPARED');
    assert.equal(JSON.parse(await readFile(result.completion,'utf8')).state,'COMPLETED');
    assert.deepEqual(await reconcile(h.options),result);
});
for(const change of ['alive','census','hash','session','pid','authority','journal','unsupported','corrupt','port'])
test('offline proof fails closed: '+change,async t=>{
    const h=await abandoned(t,{journal:true});const options={...h.options};
    if(change==='alive')options.isAlive=()=>true;
    if(change==='census'){let calls=0;options.proveOffline=async()=>({absent:++calls===1});}
    if(change==='hash')options.expected={...options.expected,lockHash:digest('wrong')};
    if(change==='session')options.expected={...options.expected,processSession:'wrong'};
    if(change==='port')options.reserve=async()=>{throw Error('EADDRINUSE');};
    if(['pid','authority','unsupported','corrupt'].includes(change)) {
        const lock={...h.lock};if(change==='pid')lock.processId++;
        if(change==='authority')lock.authorityEpoch++;
        if(change==='unsupported')lock.schemaVersion=99;
        await writeFile(h.path+'.lock',change==='corrupt'?'broken':JSON.stringify(lock));options.expected=await h.expected();
    }
    if(change==='journal'){await writeFile(h.path,JSON.stringify(journalEnvelope(transaction(),{...h.lock,processSession:'other'})));options.expected=await h.expected();}
    const before=await readFile(h.path+'.lock','utf8');await assert.rejects(reconcile(options));
    assert.equal(await readFile(h.path+'.lock','utf8'),before);
    assert.ok(!(await readdir(h.dir)).some(name=>name.includes('quarantine-')));
});
test('second state recheck detects journal creation after PREPARED',async t=>{
    const h=await abandoned(t);await assert.rejects(reconcile({...h.options,hook:async stage=>{
        if(stage==='prepared')await writeFile(h.path,JSON.stringify(journalEnvelope(transaction(),h.lock)));
    }}),/RECOVERY_EVIDENCE_CHANGED/);assert.ok(await readFile(h.path+'.lock'));
});
for(const stage of ['prepared','archived'])for(const legacy of [false,true])
test('crash/retry at '+stage+' legacy='+legacy,async t=>{
    const h=await abandoned(t,{legacy}),options={...h.options,authorizeLegacyQuarantine:legacy};
    await assert.rejects(reconcile({...options,hook:point=>{if(point===stage)throw Error('fixture-crash');}}),/fixture-crash/);
    const result=await reconcile(options);assert.equal(JSON.parse(await readFile(result.completion,'utf8')).state,'COMPLETED');
    assert.equal(digest(await readFile(result.archive)),options.expected.lockHash);
});
test('legacy no-journal requires explicit consent and never invents provenance',async t=>{
    const h=await abandoned(t,{legacy:true});assert.equal(classifyScheduledLock(h.lock,false,repositoryIdentity(h.path)),'LEGACY_UNVERIFIABLE');
    await assert.rejects(reconcile(h.options),/EXPLICIT_LEGACY_AUTHORIZATION_REQUIRED/);
    const result=await reconcile({...h.options,authorizeLegacyQuarantine:true});
    assert.equal(result.reason,'LEGACY_UNVERIFIABLE');
    const saved=JSON.parse(await readFile(result.archive,'utf8'));assert.deepEqual(saved,h.lock);
    for(const key of ['processId','authorityEpoch','authorityProcessSession','createdAt'])assert.equal(key in saved,false);
});
test('legacy journal always requires review even with consent',async t=>{
    const h=await abandoned(t,{legacy:true,journal:true});
    await assert.rejects(reconcile({...h.options,authorizeLegacyQuarantine:true}),/LEGACY_JOURNAL_REVIEW_REQUIRED/);
});
test('legacy quarantine cannot reconcile AutoLive authority as a side effect',async t=>{
    const h=await abandoned(t,{legacy:true});await writeFile(h.authorityPath+'.lock','{"pid":123}');
    await assert.rejects(reconcile({...h.options,expected:await h.expected(),authorizeLegacyQuarantine:true}),/HANDLE_AUTOLIVE_AUTHORITY_SEPARATELY/);
});
test('orphan archive without prepared evidence refuses retry',async t=>{
    const h=await abandoned(t);const result=await reconcile(h.options);await unlink(result.audit);
    await assert.rejects(reconcile(h.options),/ARCHIVE_WITHOUT_PREPARED_AUDIT/);
});
for(const stage of ['prepared','archived'])test('actual process exit at '+stage+' preserves gate and requires separate gate review',async t=>{
    const h=await abandoned(t,{legacy:true});
    const code=`import {reconcileScheduledExecutionLock} from ${JSON.stringify(new URL('../server/scheduler/ReconcileScheduledExecutionLock.js',import.meta.url).href)};
        const options=JSON.parse(process.argv[1]);
        await reconcileScheduledExecutionLock({...options,proveOffline:async()=>({absent:true}),
            reserve:async()=>()=>{},isAlive:()=>false,hook:stage=>{if(stage===process.argv[2])process.exit(73);}});`;
    const options={...h.options,authorizeLegacyQuarantine:true};
    const child=spawnSync(process.execPath,['--input-type=module','--eval',code,JSON.stringify(options),stage],{windowsHide:true,timeout:10000});
    assert.equal(child.status,73,child.stderr?.toString());
    assert.ok(await readFile(h.authorityPath+'.maintenance'));
    await assert.rejects(reconcile(options),{code:'EEXIST'});
    // Fixture-only stand-in for separately audited maintenance-gate resolution.
    await unlink(h.authorityPath+'.maintenance');
    const result=await reconcile(options);assert.equal(JSON.parse(await readFile(result.completion,'utf8')).state,'COMPLETED');
});
test('historical journal remains bound to new lock by initial hash during offline recovery',async t=>{
    const h=await abandoned(t,{journal:true});await unlink(h.path+'.lock');
    h.authority.authorityEpoch=21;h.authority.authorityProcessSession='restarted';
    const r=h.make();await r.initialize();assert.equal(r.status,'READY');const bytes=await readFile(h.path+'.lock','utf8');
    const lock=JSON.parse(bytes);await r.close();await writeFile(h.path+'.lock',bytes);
    await writeFile(h.authorityPath,'{"epoch":21}');
    await writeFile(h.authorityPath+'.lock',JSON.stringify({pid:lock.processId,authorityProcessSession:lock.authorityProcessSession}));
    const expected={...await h.expected(),processSession:lock.processSession};
    const result=await reconcile({...h.options,expected});assert.equal(result.reason,'VERIFIABLE');
});
for(const target of ['lock','authority','journal'])test('mutation after PREPARED refuses archive: '+target,async t=>{
    const h=await abandoned(t,{journal:true});
    await assert.rejects(reconcile({...h.options,hook:async stage=>{
        if(stage==='prepared')await writeFile(target==='lock'?h.path+'.lock':target==='authority'?h.authorityPath:h.path,'changed');
    }}),/RECOVERY_EVIDENCE_CHANGED/);
    assert.ok(!(await readdir(h.dir)).some(name=>name.includes('quarantine-')));
});
test('competing maintenance authority blocks reconciliation',async t=>{
    const h=await abandoned(t);await writeFile(h.authorityPath+'.maintenance','competing');
    await assert.rejects(reconcile(h.options),{code:'EEXIST'});
    assert.equal(await readFile(h.authorityPath+'.maintenance','utf8'),'competing');
});
for(const target of ['audit','completion'])test('tampered recovery evidence refuses retry: '+target,async t=>{
    const h=await abandoned(t);const result=await reconcile(h.options);
    await writeFile(result[target],'{}');await assert.rejects(reconcile(h.options),/MISMATCH/);
});
