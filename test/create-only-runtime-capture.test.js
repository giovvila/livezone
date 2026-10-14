import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const shell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
for(const scenario of ['absent','existing','race','legacy','partial','flush-failure','serialization-failure'])test('capture publication '+scenario,{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'lz-era55c-capture-'));
 t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(rel.startsWith('lz-era55c-capture-')&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});});
 await mkdir(join(root,'tools'));await mkdir(join(root,'var','log','livezone'),{recursive:true});
 for(const file of ['test-runtime-snapshot.ps1','capture-runtime-snapshot-evidence.ps1'])await copyFile(join('tools',file),join(root,'tools',file));
 await writeFile(join(root,'var','ordinary.bin'),Buffer.from([0,255,13,10]));
 await writeFile(join(root,'var','log','livezone','LivezoneMediaMtx.out.log'),'stable open log');
 const driver=String.raw`
$ErrorActionPreference='Stop'
$root=[Console]::In.ReadToEnd()
$capture=Join-Path $root 'tools\capture-runtime-snapshot-evidence.ps1'
$target=Join-Path $root 'before-var-complete-NEW-ERA-54.json'
$historical=Join-Path $root 'before-var.json'
[IO.File]::WriteAllText($historical,'IMMUTABLE-HISTORY')
$ordinary=Join-Path $root 'var\ordinary.bin'
$prior=[IO.File]::ReadAllBytes($ordinary);$priorTime=[IO.File]::GetLastWriteTimeUtc($ordinary)
$handle=[IO.File]::Open((Join-Path $root 'var\log\livezone\LivezoneMediaMtx.out.log'),[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
$bp=$null;$rejected=$false;$message=$null
try {
 if('SCENARIO' -in 'existing','legacy'){[IO.File]::WriteAllText($target,'EXISTING-COMPETITOR')}
 if('SCENARIO' -in 'race','partial','flush-failure','serialization-failure'){
  # Inject at actual production lines, without replacing production operations.
  $source=[IO.File]::ReadAllLines($capture)
  if('SCENARIO' -eq 'race'){$match='*FileMode]::CreateNew*'}
  elseif('SCENARIO' -eq 'partial'){$match='*$stream.Write($bytes*'}
  elseif('SCENARIO' -eq 'flush-failure'){$match='*$stream.Flush($true)*'}
  else{$match='*$bytes =*GetBytes*'}
  $line=0;for($i=0;$i -lt $source.Length;$i++){if($source[$i] -like $match){$line=$i+1;break}}
  if(-not $line){throw 'INJECTION_LINE_MISSING'}
  $global:fixtureTarget=$target
  $bp=Set-PSBreakpoint -Script $capture -Line $line -Action {
   if('SCENARIO' -eq 'race'){[IO.File]::WriteAllText($global:fixtureTarget,'EXISTING-COMPETITOR')}
   elseif('SCENARIO' -eq 'partial'){
    # Induce a real partial publication only inside this TEMP fixture.
    $stream.Write([byte[]]@(123),0,1);$stream.Dispose()
   }
   elseif('SCENARIO' -eq 'flush-failure'){$stream.Dispose()}
   else{Set-Variable -Name json -Scope 1 -Value $null}
  }
 }
 if('SCENARIO' -eq 'legacy'){& $capture -OutputPath $target}
 else{try{& $capture -OutputPath $target -CreateOnly}catch{$rejected=$true;$message=$_.Exception.Message}}
 if([IO.File]::ReadAllText($historical) -cne 'IMMUTABLE-HISTORY'){throw 'HISTORY_CHANGED'}
 if([Convert]::ToBase64String([IO.File]::ReadAllBytes($ordinary)) -cne [Convert]::ToBase64String($prior) -or [IO.File]::GetLastWriteTimeUtc($ordinary) -ne $priorTime){throw 'RUNTIME_CHANGED'}
 [ordered]@{rejected=$rejected;message=$message;targetExists=(Test-Path -LiteralPath $target);target=$(if(Test-Path -LiteralPath $target){[IO.File]::ReadAllText($target)}else{$null});names=@(Get-ChildItem -LiteralPath $root -File|ForEach-Object{$_.Name})}|ConvertTo-Json -Depth 4 -Compress
}finally{if($bp){Remove-PSBreakpoint -Breakpoint $bp};$handle.Dispose()}
`.replaceAll('SCENARIO',scenario);
 const r=spawnSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(driver,'utf16le').toString('base64')],{input:root,encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
 assert.equal(r.status,0,r.stdout+r.stderr);const result=JSON.parse(r.stdout);
 if(['existing','race'].includes(scenario)){assert.equal(result.rejected,true);assert.equal(result.target,'EXISTING-COMPETITOR');assert.match(result.message,/CAPTURE_CREATE_ONLY_OPEN_REJECTED/);}
 else if(scenario==='serialization-failure'){assert.equal(result.rejected,true);assert.equal(result.targetExists,false);}
 else if(scenario==='flush-failure'){assert.equal(result.rejected,true);assert.equal(result.targetExists,true);assert.match(result.message,/CAPTURE_PUBLICATION_UNCERTAIN_REVIEW_REQUIRED/);}
 else if(scenario==='partial'){assert.equal(result.rejected,true);assert.equal(result.target,'{');assert.match(result.message,/CAPTURE_PUBLICATION_UNCERTAIN_REVIEW_REQUIRED/);}
 else {
  assert.equal(result.rejected,false);const rows=JSON.parse(result.target);assert.equal(rows.length,2);assert.ok(rows.every(x=>!x.error&&/^[A-F0-9]{64}$/.test(x.sha256)));
  const ordinary=rows.find(x=>x.path==='ordinary.bin');assert.equal(ordinary.sha256.toLowerCase(),createHash('sha256').update(Buffer.from([0,255,13,10])).digest('hex'));
 }
 assert.deepEqual(result.names.sort(),scenario==='serialization-failure'?['before-var.json']:['before-var-complete-NEW-ERA-54.json','before-var.json']);
});
test('runbook chooses deterministic new capture, precheck and explicit CreateOnly',async()=>{
 const doc=await readFile('docs/NEW-ERA-07-FUTURE-REAL-RUNBOOK.txt','utf8');const section=doc.slice(doc.indexOf('0a. EVIDENCE_CAPTURE'),doc.indexOf('1. LocalSystem proof'));
 assert.match(section,/\$completeCapture = Join-Path \$out 'before-var-complete-NEW-ERA-54.json'/);
 assert.match(section,/if \(Test-Path -LiteralPath \$completeCapture\).*throw/);
 assert.match(section,/& tools\/capture-runtime-snapshot-evidence\.ps1 -OutputPath \$completeCapture -CreateOnly/);
 assert.match(section,/\$capturedRows = Get-Content -LiteralPath \$completeCapture/);
 assert.doesNotMatch(section,/Join-Path \$out 'before-var\.json'/);
});
