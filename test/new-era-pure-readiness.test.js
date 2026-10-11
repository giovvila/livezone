import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm,open,unlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {readinessReadFixture,observer} from '../test-support/ReadinessReadFixture.js';
import {pureScheduleFixture} from '../test-support/PureScheduleReadFixture.js';
import {referenceReadFixture} from '../test-support/ReferenceReadFixture.js';
const {probeStorageWriteability}=await import('../server/runtime/StorageWriteDiagnostic.js');

test('exact R9 readiness RED to GREEN using default production checks and same HTTP request',async t=>{
    const h=await readinessReadFixture(t),green=await h.observe(()=>h.request());
    assert.equal(green.status,200);assert.equal(green.payload.storage.writeability,'NOT_PROBED');
    const old=await readFile(new URL('../test-support/fixtures/runtime-readiness-era27.txt',import.meta.url),'utf8');
    const url='data:text/javascript;base64,'+Buffer.from(old).toString('base64');
    const {default:Prior}=await import(url);
    const prior=new Prior({mediaReady:Promise.resolve(),mediaAssetRepository:h.repository,mediaIngestStatusClient:{getStatus:async()=>({state:'offline'})}});
    const original=h.runtimeReadiness.evaluate;h.runtimeReadiness.evaluate=prior.evaluate.bind(prior);
    observer.enable();try{const red=await h.request();assert.equal(red.status,200);}
    finally{observer.disable();h.runtimeReadiness.evaluate=original;}
    assert.equal(observer.counts.create,1);assert.equal(observer.counts.delete,1);assert.equal(observer.counts.fileSync,0);
});

test('HEAD readiness uses pure checks, valid status and no response body',async t=>{
    const h=await readinessReadFixture(t);const r=await h.observe(()=>h.request('HEAD'));
    assert.equal(r.status,200);assert.equal(r.body,'');assert.equal(r.headers['Cache-Control'],'no-store');
});

test('readiness reports directory readability without claiming writable or durable storage',async t=>{
    const h=await readinessReadFixture(t),r=await h.observe(()=>h.request());
    assert.deepEqual(r.payload.storage,{readability:'DIRECTORY_READABLE',writeability:'NOT_PROBED',durability:'NOT_PROBED'});
    assert.ok(!r.body.includes(h.directory));assert.equal(r.payload.checks.mediaLibrary,'ok');
});

test('read-only directory remains an observation; UNKNOWN writeability does not become a capability PASS',async t=>{
    const h=await readinessReadFixture(t,{storageObserver:async()=>{}});
    // Pure metadata adapter models readable storage with no permission to create.
    const r=await h.observe(()=>h.request());assert.equal(r.status,200);assert.equal(r.payload.storage.writeability,'NOT_PROBED');
    await assert.rejects(probeStorageWriteability(h.directory,{authorizeStorageProbe:true,operations:{stat,open:async()=>{throw Object.assign(Error('fixture EACCES'),{code:'EACCES'});},unlink:()=>assert.fail('no created file to delete')}}),{code:'EACCES'});
});

for(const kind of ['missing','wrong-object','unreadable','initialization-failed'])test('readiness '+kind+' fails without repair or information leakage',async t=>{
    const h=await readinessReadFixture(t);
    if(kind==='missing')h.repository.tempRoot=join(h.root,'absent');
    if(kind==='wrong-object'){const file=join(h.root,'file');await writeFile(file,'fixture');h.repository.tempRoot=file;}
    if(kind==='initialization-failed'){h.runtimeReadiness.mediaReady=Promise.reject(Error('private initialization failure'));void h.runtimeReadiness.mediaReady.catch(()=>{});}
    const original=fs.promises.opendir;
    if(kind==='unreadable'){fs.promises.opendir=async()=>{throw Object.assign(Error('fixture EACCES'),{code:'EACCES'});};syncBuiltinESMExports();}
    try{await h.observe(async()=>{for(const method of ['GET','HEAD']){const r=await h.request(method);assert.equal(r.status,503);if(method==='GET'){assert.equal(r.payload.storage.readability,'UNAVAILABLE');assert.ok(!r.body.includes('private'));}}});}
    finally{if(kind==='unreadable'){fs.promises.opendir=original;syncBuiltinESMExports();}}
});

test('current storage deletion is detected after earlier readiness success without historical cache PASS',async t=>{
    const h=await readinessReadFixture(t);assert.equal((await h.observe(()=>h.request())).status,200);
    await rm(h.directory,{recursive:true});assert.equal((await h.observe(()=>h.request())).status,503);
});

test('optional ingest failure remains degraded; Studio status is descriptive rather than NEW ERA authority READY',async t=>{
    const h=await readinessReadFixture(t,{ingest:'error',studioStatus:'CORRUPT'}),r=await h.observe(()=>h.request());
    assert.equal(r.status,200);assert.equal(r.payload.status,'degraded');assert.equal(r.payload.checks.studioState,'corrupt');
    assert.equal(r.payload.storage.durability,'NOT_PROBED');
});

test('permanent capability evidence cannot substitute for current Media Library metadata and is never exercised',async t=>{
    const h=await readinessReadFixture(t);h.repository.tempRoot=join(h.root,'absent');
    const prior=process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY;
    process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY=join(h.root,'stale-or-invalid-proof');
    try{assert.equal((await h.observe(()=>h.request())).status,503);}finally{if(prior===undefined)delete process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY;else process.env.LIVEZONE_LOCALSYSTEM_PROOF_DIRECTORY=prior;}
    const source=await readFile(new URL('../server/runtime/RuntimeReadiness.js',import.meta.url),'utf8');
    assert.ok(!/verifyPermanent|LocalSystem|probeStorageWriteability|StorageWriteDiagnostic/.test(source));
});

test('repeated and concurrent GET/HEAD polling remains byte-identical with zero forbidden effects',async t=>{
    const h=await readinessReadFixture(t);await writeFile(join(h.root,'retained-wal'),'retained fixture WAL');
    await h.observe(async()=>{for(let i=0;i<12;i++)assert.equal((await h.request()).status,200);
        const results=await Promise.all(Array.from({length:40},(_,i)=>h.request(i%2?'GET':'HEAD')));assert.ok(results.every(r=>r.status===200));});
});

test('canonical middleware and shared liveness path cannot invoke identity or storage mutation',async t=>{
    const h=await readinessReadFixture(t);await h.observe(async()=>{
        assert.equal((await h.request('GET','/%2e/readyz')).status,400);
        assert.equal((await h.request('GET','/config/UPPER')).status,404);
        const health=await h.request('GET','/healthz');assert.deepEqual(health.payload,{ok:true,service:'livezone',status:'alive'});
    });
});

test('readiness plus canonical Schedule and known/unknown Reference GET/HEAD preserve actual Ledger and ownership',async t=>{
    const s=await pureScheduleFixture(t),ref=await referenceReadFixture(t,{scheduleRoutes:s.routes}),h=await readinessReadFixture(t),c=await ref.register();
    await s.observe(()=>ref.observe(()=>h.observe(async()=>{
        await Promise.all([h.request(),h.request('HEAD'),ref.request(),ref.request('HEAD'),ref.request('GET','/api/studio/schedule',{headers:ref.headers(c)})]);
    })));assert.equal((await s.owner.ledger.inspect(s.identity)).status,'UNCONSUMED');
});

test('explicit storage diagnostic requires authorization and proves only create/delete with cleanup',async t=>{
    const h=await readinessReadFixture(t);await h.observe(()=>assert.rejects(probeStorageWriteability(h.directory),/AUTHORIZATION_REQUIRED/));
    const before=await h.bytes();observer.enable();let result;try{result=await probeStorageWriteability(h.directory,{authorizeStorageProbe:true});}finally{observer.disable();}
    assert.equal(result.operation,'MUTATING_STORAGE_DIAGNOSTIC');assert.equal(result.capability,'CREATE_DELETE');assert.equal(result.durability,'NOT_PROVEN');
    assert.equal(observer.counts.create,1);assert.equal(observer.counts.delete,1);assert.deepEqual(await h.bytes(),before);
});

test('explicit probe cleanup handles close failure and surfaces unlink failure without false success',async t=>{
    const h=await readinessReadFixture(t);let opened;
    await assert.rejects(probeStorageWriteability(h.directory,{authorizeStorageProbe:true,operations:{stat,unlink,open:async(...args)=>{opened=await open(...args);let first=true;return {close:async()=>{if(first){first=false;throw Error('close fixture failure');}await opened.close();}};}}}),/close fixture failure/);
    assert.deepEqual(await h.bytes(),{});
    let path;await assert.rejects(probeStorageWriteability(h.directory,{authorizeStorageProbe:true,operations:{stat,open:async(p,...args)=>{path=p;return open(p,...args);},unlink:async()=>{throw Error('unlink fixture failure');}}}),/unlink fixture failure/);
    await unlink(path);
});

test('explicit diagnostic rejects relative, missing and non-directory targets before mutation',async t=>{
    const h=await readinessReadFixture(t),file=join(h.root,'file');await writeFile(file,'fixture');
    await h.observe(async()=>{
        await assert.rejects(probeStorageWriteability('relative',{authorizeStorageProbe:true}),/ABSOLUTE_DIRECTORY_REQUIRED/);
        await assert.rejects(probeStorageWriteability(join(h.root,'absent'),{authorizeStorageProbe:true}),{code:'ENOENT'});
        await assert.rejects(probeStorageWriteability(file,{authorizeStorageProbe:true}),/STORAGE_DIRECTORY_REQUIRED/);
    });
});

test('explicit diagnostic CLI is gated and executes only the requested TEMP path',async t=>{
    const h=await readinessReadFixture(t),tool=new URL('../tools/probe-readiness-storage.mjs',import.meta.url);
    const run=args=>spawnSync(process.execPath,[fileURLToPath(tool),...args],{encoding:'utf8',windowsHide:true,env:process.env});
    const denied=run(['--directory',h.directory]);assert.equal(denied.status,1);
    const accepted=run(['--directory',h.directory,'--authorize-storage-probe']);assert.equal(accepted.status,0,accepted.stderr);assert.equal(JSON.parse(accepted.stdout).durability,'NOT_PROVEN');
    assert.deepEqual(await h.bytes(),{});
});

test('readiness consumers and runbook distinguish pure polling, explicit diagnostic and LocalSystem proof',async()=>{
    for(const file of ['tools/status-livezone-services.ps1','tools/install-livezone-services.ps1']){
        const source=await readFile(new URL('../'+file,import.meta.url),'utf8');assert.match(source,/\/readyz/);assert.ok(!source.includes('probe-readiness-storage'));
    }
    const runbook=await readFile(new URL('../docs/NEW-ERA-07-FUTURE-REAL-RUNBOOK.txt',import.meta.url),'utf8');
    assert.match(runbook,/NEW-ERA-28/);assert.match(runbook,/MUTATING_STORAGE_DIAGNOSTIC/);assert.match(runbook,/NOT_PROBED/);
});

test.after(()=>observer.restore());
