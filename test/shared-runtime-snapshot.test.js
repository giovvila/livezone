import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const shell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
for(const scenario of ['ordinary','shared','shared-capture','exclusive','changing','reparse'])test('snapshot '+scenario+' isolated contract',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'lz-era54-snapshot-'));
 t.after(async()=>{const r=relative(resolve(tmpdir()),root);assert.ok(r.startsWith('lz-era54-snapshot-')&&!r.startsWith('..')&&!isAbsolute(r));await rm(root,{recursive:true,force:true});});
 await mkdir(join(root,'tools'));await mkdir(join(root,'var','log','livezone'),{recursive:true});
 await copyFile('tools/test-runtime-snapshot.ps1',join(root,'tools','test-runtime-snapshot.ps1'));
 await copyFile('tools/capture-runtime-snapshot-evidence.ps1',join(root,'tools','capture-runtime-snapshot-evidence.ps1'));
 const file=join(root,'var','log','livezone','LivezoneMediaMtx.out.log');await writeFile(file,'stable log\n');await writeFile(join(root,'var','ordinary'),'ordinary bytes');
 const before=await readFile(file);const script=String.raw`
$ErrorActionPreference='Stop'
$root=[Console]::In.ReadToEnd()
$file=Join-Path $root 'var\log\livezone\LivezoneMediaMtx.out.log'
$before=Get-Item -LiteralPath $file
$time=$before.LastWriteTimeUtc.Ticks;$size=$before.Length
$handle=$null
try {
 if('SCENARIO' -in 'shared','shared-capture'){$handle=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)}
 if('SCENARIO' -eq 'exclusive'){$handle=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
 if('SCENARIO' -eq 'reparse'){New-Item -ItemType Junction -Path (Join-Path $root 'var\alias') -Target (Join-Path $root 'var\log')|Out-Null}
 if('SCENARIO' -eq 'changing'){
  $global:metadataReads=0
  function Get-Item {
   param([string]$LiteralPath,[switch]$Force)
   $real=Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force
   if($LiteralPath -eq $file){
    $global:metadataReads++
    # Deterministic concurrent-change fixture: change observed metadata only.
    # Do not assign FileInfo.LastWriteTime (which would write the real fixture).
    if($global:metadataReads -ge 3){return [pscustomobject]@{FullName=$real.FullName;Length=$real.Length;Attributes=$real.Attributes;LastWriteTimeUtc=$real.LastWriteTimeUtc.AddTicks(1)}}
   }
   return $real
  }
 }
 $text=& (Join-Path $root 'tools\test-runtime-snapshot.ps1')
 if('SCENARIO' -eq 'shared-capture'){
  $output=Join-Path $root 'capture.json'
  & (Join-Path $root 'tools\capture-runtime-snapshot-evidence.ps1') -OutputPath $output
  $written=[IO.File]::ReadAllText($output)
  if(($text -join [char]10) -cne $written){throw 'CAPTURE_NOT_EQUIVALENT'}
 }
 $after=Microsoft.PowerShell.Management\Get-Item -LiteralPath $file
 if($after.Length -ne $size -or $after.LastWriteTimeUtc.Ticks -ne $time){throw 'FILE_MUTATED'}
 $text
} finally {if($handle){$handle.Dispose()}}
`.replaceAll('SCENARIO',scenario);
 const r=spawnSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:root,encoding:'utf8',windowsHide:true,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
 if(scenario==='reparse'){assert.notEqual(r.status,0);assert.match(r.stderr,/reparse/);}
 else {assert.equal(r.status,0,r.stderr);const rows=JSON.parse(r.stdout),log=rows.find(x=>x.path.endsWith('LivezoneMediaMtx.out.log'));assert.equal(rows.length,2);
  if(['exclusive','changing'].includes(scenario)){assert.equal(log.sha256,null);assert.ok(log.error);if(scenario==='changing')assert.match(log.error,/changed during observation/);}
  else {assert.equal(log.error,null);assert.equal(log.sha256.toLowerCase(),createHash('sha256').update(before).digest('hex'));assert.equal(log.size,before.length);}
  const ordinary=rows.find(x=>x.path==='ordinary');assert.equal(ordinary.sha256.toLowerCase(),createHash('sha256').update('ordinary bytes').digest('hex'));
 }
 assert.deepEqual(await readFile(file),before);
});
