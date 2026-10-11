import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
const root=resolve('.');
const protectedPaths=new Set(['server/autolive/AutoLiveSafeHttp.js','server/autolive/ManagedIngestTransport.js',
    'test/managed-ingest-transport-health.test.js','test/scheduled-live-managed-health-gap.test.js','test-support/MediaMtxCookieFixture.js'].map(p=>resolve(root,p)));
test('NEW ERA executes from isolated deployment with all five H1 files absent',async t=>{
    const files=new Set();
    const visit=async path=>{
        path=resolve(path);assert.ok(!protectedPaths.has(path),'H1 dependency: '+path);if(files.has(path))return;files.add(path);
        const source=await readFile(path,'utf8');
        // Copy static dependencies; the optional default application launcher is
        // not used by these fixtures. The child loader denies H1 dynamically too.
        const imports=[...source.matchAll(/from\s*(['"])(\.[^'"]+)\1/g)].map(m=>m[2]);
        for(const specifier of imports)await visit(resolve(dirname(path),specifier));
    };
    await visit(join(root,'test/new-execution-era-production.test.js'));
    // The runtime component graph must also work without protected transport files.
    await visit(join(root,'test/new-execution-era-runtime.test.js'));
    await visit(join(root,'test/new-era-grant-schedule-drift.test.js'));
    await visit(join(root,'test-support/RejectProtectedH1Loader.mjs'));
    const directory=await mkdtemp(join(tmpdir(),'lz-era02-no-h1-'));
    t.after(async()=>{const rel=relative(resolve(tmpdir()),resolve(directory));assert.ok(rel.startsWith('lz-era02-no-h1-')&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(directory,{recursive:true,force:true});});
    for(const path of files){const rel=relative(root,path);assert.ok(!rel.startsWith('..')&&!isAbsolute(rel));const to=join(directory,rel);await mkdir(dirname(to),{recursive:true});await copyFile(path,to);}
    const fixture=join(root,'test-support/fixtures/new-execution-era-real');
    const inventory=JSON.parse(await readFile(join(fixture,'inventory.json')));
    const to=join(directory,'test-support/fixtures/new-execution-era-real');await mkdir(to,{recursive:true});
    for(const name of ['inventory.json',...inventory.artifacts.map(i=>i.key+'.bytes')])await copyFile(join(fixture,name),join(to,name));
    await writeFile(join(directory,'package.json'),JSON.stringify({type:'module'}));
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const child=spawn(process.execPath,['--loader','./test-support/RejectProtectedH1Loader.mjs','--test','--test-name-pattern=whole-domain retirement|legacy lock cannot|independent retry after unrelated Schedule change','test/new-execution-era-production.test.js','test/new-era-grant-schedule-drift.test.js'],{cwd:directory,windowsHide:true,env});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const code=await new Promise((ok,no)=>{child.once('error',no);child.once('exit',ok);});assert.equal(code,0,output);
    assert.match(output,/pass 3/);
});
