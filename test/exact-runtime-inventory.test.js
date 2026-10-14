import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const scenarios=['exact','491','493','replacement','duplicate','case','separator','dot','absolute','null-hash','bad-hash','error','missing-log','both-491','bad-size','bad-metadata','changed-second','baseline-hash','baseline-duplicate','baseline-count'];
for(const scenario of scenarios)test('exact runtime inventory '+scenario,{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'lz-era55d-inventory-'));t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(rel.startsWith('lz-era55d-inventory-')&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});});
 // Independently declared expected fixture, not inferred from observed rows.
 const names=['log\\livezone\\LivezoneMediaMtx.err.log','log\\livezone\\LivezoneMediaMtx.out.log',...Array.from({length:490},(_,i)=>'fixture\\file-'+i)];
 const expected={var:names.map(path=>({path:'var\\'+path}))};
 let rows=names.map(path=>({path,size:1,lastWriteTime:'2026-10-13T00:00:00.0000000Z',sha256:'a'.repeat(64),error:null}));let previous=structuredClone(rows);
 if(['491','both-491','missing-log'].includes(scenario))rows.splice(scenario==='missing-log'?0:491,1);
 if(scenario==='both-491')previous=structuredClone(rows);
 if(scenario==='493')rows.push({...rows[2],path:'unexpected'});
 if(scenario==='replacement')rows[2].path='unexpected';
 if(scenario==='duplicate')rows[3]=structuredClone(rows[2]);
 if(scenario==='case')rows[3].path=rows[2].path.toUpperCase();
 if(scenario==='separator')rows[3].path=rows[2].path.replaceAll('\\','/');
 if(scenario==='dot')rows[2].path='fixture\\.\\file-0';
 if(scenario==='absolute')rows[2].path='C:\\fixture\\file-0';
 if(scenario==='null-hash')rows[0].sha256=null;
 if(scenario==='bad-hash')rows[0].sha256='not-a-hash';
 if(scenario==='error')rows[0].error='sharing violation';
 if(scenario==='bad-size')rows[0].size=-1;
 if(scenario==='bad-metadata')rows[0].lastWriteTime='not-a-date';
 if(scenario==='changed-second')rows[0].size=2;
 if(scenario==='baseline-duplicate')expected.var[3]=expected.var[2];
 if(scenario==='baseline-count')expected.var.pop();
 const bytes=Buffer.from(JSON.stringify(expected)),baseline=join(root,'baseline.json');await writeFile(baseline,bytes);
 const hash=scenario==='baseline-hash'?'f'.repeat(64):createHash('sha256').update(bytes).digest('hex');
 const helper=resolve('tools/Assert-RuntimeSnapshotInventory.ps1');
 const code=`$ErrorActionPreference='Stop';$o=[Console]::In.ReadToEnd()|ConvertFrom-Json;. '${helper.replaceAll("'","''")}';Assert-RuntimeSnapshotInventory -Rows @($o.rows) -PreviousRows @($o.previous) -ExpectedInventoryPath $o.baseline -ExpectedInventoryHash $o.hash -ExpectedCount 492 | ConvertTo-Json -Compress`;
 const r=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{input:JSON.stringify({rows,previous,baseline,hash}),encoding:'utf8',windowsHide:true,timeout:30000});
 if(scenario==='exact'){assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.status,'PASS');assert.equal(result.capturedCount,492);assert.equal(result.stabilityChecked,true);}
 else {assert.notEqual(r.status,0,scenario+' unexpectedly accepted');assert.match(r.stderr,/INVENTORY_/);}
 assert.deepEqual(await readFile(baseline),bytes);
});
test('runbook binds both observations to one independently pinned certified baseline',async()=>{
 const doc=await readFile('docs/NEW-ERA-07-FUTURE-REAL-RUNBOOK.txt','utf8');assert.match(doc,/\$expectedInventory = Join-Path \$root 'tmp\/era46-push\/after.json'/);assert.match(doc,/\$expectedInventoryHash = '0f472d6d1c7c6def7bdf7ee2d19ebab6a72045d801e182f2f0988a08f83c2623'/);
 const calls=doc.split(/\r?\n/).filter(l=>l.startsWith('Assert-RuntimeSnapshotInventory '));assert.equal(calls.length,2);assert.ok(calls.every(l=>l.includes('-ExpectedCount 492')&&l.includes('-ExpectedInventoryHash $expectedInventoryHash')&&l.includes('-ExpectedInventoryPath $expectedInventory')));assert.ok(calls[1].includes('-PreviousRows @($snapshotRows)'));assert.match(doc,/-OutputPath \$completeCapture -CreateOnly/);
});
