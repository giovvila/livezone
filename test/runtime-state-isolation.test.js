import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('preload rejects unsafe mutations before touching simulated runtime sentinel',()=>{
    const root=mkdtempSync(join(tmpdir(),'lz-isolation-sentinel-'));
    const protectedRoot=join(root,'var');mkdirSync(protectedRoot);
    const sentinel=join(protectedRoot,'sentinel');writeFileSync(sentinel,'ORIGINAL');
    const guard=new URL('../test-support/RuntimeStateGuard.mjs',import.meta.url).href;
    const script=`import fs from 'node:fs';import p from 'node:fs/promises';import assert from 'node:assert/strict';
const root=process.argv[1],file=root+'/sentinel';
const attempts=[()=>fs.writeFileSync(file,'BAD'),()=>fs.appendFileSync(file,'BAD'),()=>fs.unlinkSync(file),()=>fs.renameSync(file,file+'.moved'),()=>fs.rmSync(root,{recursive:true}),()=>fs.mkdirSync(root+'/new'),()=>fs.openSync(file,'r+'),()=>fs.copyFileSync(process.argv[2],file),()=>fs.createWriteStream(file),()=>fs.writeFileSync(new URL('file:///'+file.replaceAll('\\\\','/')),'BAD')];
for(const attempt of attempts)assert.throws(attempt,{code:'TEST_RUNTIME_STATE_PROTECTED'});
for(const attempt of [()=>p.writeFile(file,'BAD'),()=>p.unlink(file),()=>p.open(file,'w'),()=>p.rm(root,{recursive:true})])await assert.rejects(async()=>attempt(),{code:'TEST_RUNTIME_STATE_PROTECTED'});
const handle=await p.open(file,'r');try{for(const method of ['truncate','chmod','utimes','writeFile'])await assert.rejects(async()=>handle[method](0),{code:'TEST_RUNTIME_STATE_PROTECTED'});}finally{await handle.close();}
const fd=fs.openSync(file,'r');try{assert.throws(()=>fs.fchmodSync(fd,0o600),{code:'TEST_RUNTIME_STATE_PROTECTED'});}finally{fs.closeSync(fd);}
const safe=root+'/../allowed';const safeFd=fs.openSync(safe,'w');fs.writeSync(safeFd,'ALLOWED');fs.closeSync(safeFd);assert.equal(fs.readFileSync(safe,'utf8'),'ALLOWED');
assert.throws(()=>fs.rmSync(root+'/..',{recursive:true}),{code:'TEST_RUNTIME_STATE_PROTECTED'});
assert.throws(()=>fs.writeFileSync(root+'/../var/sentinel','BAD'),{code:'TEST_RUNTIME_STATE_PROTECTED'});
const phaseFixture=await import(${JSON.stringify(new URL('../test-support/Phase2ActionFixture.js',import.meta.url).href)});
await assert.rejects(phaseFixture.fixture(null,root),{code:'TEST_RUNTIME_STATE_PROTECTED'});
const serverFixture=await import(${JSON.stringify(new URL('../test-support/ReferenceAuthorityTestServer.js',import.meta.url).href)});
assert.throws(()=>serverFixture.createProgramOutputServer({studioStatePath:file}),{code:'TEST_RUNTIME_STATE_PROTECTED'});
assert.equal(fs.readFileSync(file,'utf8'),'ORIGINAL');`;
    try {
        const result=spawnSync(process.execPath,['--import',guard,'--input-type=module','-e',script,protectedRoot,sentinel],{
            windowsHide:true,encoding:'utf8',env:{...process.env,LIVEZONE_TEST_PROTECTED_ROOTS:JSON.stringify([protectedRoot])}});
        assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(sentinel,'utf8'),'ORIGINAL');
        // Exercise node:test worker inheritance, the same mechanism used by the
        // repository runner, without explicitly passing --import to the worker.
        const entry=join(root,'unsafe.test.mjs');
        writeFileSync(entry,`import test from 'node:test';import {writeFileSync} from 'node:fs';test('unsafe fixture',()=>writeFileSync(${JSON.stringify(sentinel)},'BAD'));`);
        const workerEnv={...process.env,NODE_OPTIONS:`${process.env.NODE_OPTIONS||''} --import="${guard}"`,
            LIVEZONE_TEST_PROTECTED_ROOTS:JSON.stringify([protectedRoot])};
        delete workerEnv.NODE_TEST_CONTEXT;
        const worker=spawnSync(process.execPath,['--test',entry],{windowsHide:true,encoding:'utf8',env:workerEnv});
        assert.equal(worker.status,1,worker.stdout+worker.stderr);assert.match(worker.stdout+worker.stderr,/TEST_RUNTIME_STATE_PROTECTED/);
        assert.equal(readFileSync(sentinel,'utf8'),'ORIGINAL');assert.deepEqual(readdirSync(protectedRoot),['sentinel']);
    } finally {const rel=relative(resolve(tmpdir()),resolve(root));assert.ok(rel.startsWith('lz-isolation-sentinel-')&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(root,{recursive:true,force:true});}
});
