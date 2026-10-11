import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const shell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const env={...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'};
for(const [scenario,name]of [['red-green','exact R6 snapshot RED to GREEN with unchanged complete snapshot semantics'],['existing','pure snapshot leaves existing output bytes and timestamp unchanged and rejects OutputPath'],['equivalence','pure and explicit persisted snapshot are equivalent with deliberate write observed'],['step0','actual runbook STEP0 snapshot preflight has zero forbidden effects']])test(name,async t=>{
    const root=await mkdtemp(join(tmpdir(),'lz-era24-snapshot-'));
    t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(rel.startsWith('lz-era24-snapshot-')&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});});
    await mkdir(join(root,'tools'));await mkdir(join(root,'var','nested'),{recursive:true});
    const names=['binary.dat','nested/caffè-日本.txt','empty.txt','space name.txt'];
    for(const [i,name]of names.entries())await writeFile(join(root,'var',name),i===2?Buffer.alloc(0):Buffer.from([0,i,255,13,10]));
    for(const name of ['test-runtime-snapshot.ps1','capture-runtime-snapshot-evidence.ps1'])await copyFile(resolve('tools',name),join(root,'tools',name));
    // Retained exact pre-fix implementation reproduces R6, only in TEMP.
    await copyFile(resolve('test-support/fixtures/runtime-snapshot-era18.ps1'),join(root,'tools','legacy-snapshot.ps1'));
    const resultPath=join(root,'result.json');
    const child=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-File',resolve('test-support/RuntimeSnapshotObservationFixture.ps1'),
        '-Root',root,'-Scenario',scenario,'-Runbook',resolve('docs/NEW-ERA-07-FUTURE-REAL-RUNBOOK.txt'),'-Result',resultPath],{env,windowsHide:true,encoding:'utf8',timeout:30000});
    assert.equal(child.status,0,child.stdout+child.stderr);assert.ifError(child.error);
    const result=JSON.parse(await readFile(resultPath));assert.equal(result.edition,'Desktop');assert.match(result.version,/^5\.1\./);
    result.snapshot=JSON.parse(result.snapshotJson);
    assert.equal(result.snapshot.length,names.length,JSON.stringify(result.snapshot));
    for(const name of names){const bytes=await readFile(join(root,'var',name)),row=result.snapshot.find(r=>r.path===name.replaceAll('/','\\'));
        assert.ok(row,name);assert.equal(row.size,bytes.length);assert.equal(row.sha256.toLowerCase(),createHash('sha256').update(bytes).digest('hex'));assert.equal(row.error,null);}
    if(scenario!=='equivalence'){assert.ok(Object.values(result.effects).every(v=>v===0));assert.equal(result.existingPreserved,true);}
    else{assert.ok(result.effects.write>0);assert.ok(result.effects.truncate>0);}
    t.diagnostic(JSON.stringify({scenario,red:result.red,effects:result.effects,edition:result.edition}));
});
test('runbook separates explicit capture before authorization and forensic archival ordering',async()=>{
    const doc=await readFile('docs/NEW-ERA-07-FUTURE-REAL-RUNBOOK.txt','utf8');
    const pure=doc.indexOf('$snapshotText = & tools/test-runtime-snapshot.ps1'),capture=doc.indexOf('& tools/capture-runtime-snapshot-evidence.ps1'),authorization=doc.indexOf('$authText = node');
    assert.ok(pure>=0&&pure<capture&&capture<authorization);
    assert.ok(doc.indexOf('--phase forensic')<doc.indexOf('--phase archived'));
    assert.match(doc,/Authorization binds the\s+canonical dryrun inventory and embedded exact bytes/);
    assert.match(doc,/STOP runtime changed between observation and capture/);
    assert.doesNotMatch(doc.slice(doc.indexOf('0. READ_ONLY'),doc.indexOf('0a. EVIDENCE_CAPTURE')),/WriteAllText|-OutputPath|Out-File|Set-Content/);
});
