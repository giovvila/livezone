import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,win32} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const shell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
// A runner hosted by pwsh may export its Core module path; use Desktop's own modules.
const shellEnv={...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'};
const driver=String.raw`
param([string]$Root, [string]$SnapshotSource, [string]$Runbook, [string]$Result)
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'PS51_REQUIRED' }
foreach ($name in @('Get-FileHash','Get-CimInstance','Get-NetTCPConnection','ConvertFrom-Json','ConvertTo-Json','Get-ItemProperty','Select-Object','Where-Object')) { Get-Command $name -ErrorAction Stop | Out-Null }
$errors=$null; $tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($SnapshotSource,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'SNAPSHOT_PARSE_FAILED' }
$source=[IO.File]::ReadAllText($SnapshotSource)
if ($source -match 'GetRelativePath|\?\?|ForEach-Object\s+-Parallel|ConvertFrom-Json[^\r\n]*-AsHashtable|Join-String|Get-Content[^\r\n]*-AsByteStream') { throw 'UNSUPPORTED_SNAPSHOT_CONSTRUCT' }
$helper=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-SnapshotRelativePath'},$true)
if (-not $helper) { throw 'CONTAINMENT_HELPER_REQUIRED' }
. ([scriptblock]::Create($helper.Extent.Text))
$var=Join-Path $Root 'var'
$edgeCases=@(
    @{root=$var; file=(Join-Path $var 'direct.txt'); expected='direct.txt'},
    @{root=($var+'\'); file=(Join-Path $var 'nested\two.txt'); expected='nested\two.txt'},
    @{root=$var.ToUpperInvariant(); file=(Join-Path $var 'space name.txt'); expected='space name.txt'},
    @{root=$var.Replace('\','/'); file=(Join-Path $var 'nested\two.txt').Replace('\','/'); expected='nested\two.txt'}
)
foreach ($case in $edgeCases) { if ((Get-SnapshotRelativePath $case.root $case.file) -cne $case.expected) { throw 'RELATIVE_EDGE_FAILED' } }
$outsideRejected=0
foreach ($file in @((Join-Path $Root 'outside.txt'),($var+'-other\file.txt'),(Join-Path $var '..\outside.txt'),$var)) {
    $rejected=$false
    try { Get-SnapshotRelativePath $var $file | Out-Null } catch { $rejected=$true }
    if (-not $rejected) { throw 'OUTSIDE_ROOT_ACCEPTED' }; $outsideRejected++
}
# Parse each actual executable runbook line without running any operator command.
$commands=@([IO.File]::ReadAllLines($Runbook) | Where-Object { $_ -match '^(\$|if \(|Set-Location |git |Get-CimInstance |Get-NetTCPConnection |& tools/|node |\[IO\.File\])' })
foreach ($command in $commands) {
    $errors=$null; $tokens=$null
    [Management.Automation.Language.Parser]::ParseInput($command,[ref]$tokens,[ref]$errors) | Out-Null
    if ($errors.Count) { throw ('RUNBOOK_PARSE_FAILED: '+$command) }
    if ($command -match 'GetRelativePath|\?\?|ForEach-Object\s+-Parallel|ConvertFrom-Json[^\r\n]*-AsHashtable|Join-String|Get-Content[^\r\n]*-AsByteStream') { throw 'UNSUPPORTED_RUNBOOK_CONSTRUCT' }
}
$snippetCount=0
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $Root 'snippets') -Filter '*.ps1') {
    $text=[IO.File]::ReadAllText($file.FullName)
    $errors=$null; $tokens=$null
    [Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors) | Out-Null
    if ($errors.Count -or $text -match 'GetRelativePath|\?\?|ForEach-Object\s+-Parallel|ConvertFrom-Json[^\r\n]*-AsHashtable|Join-String|Get-Content[^\r\n]*-AsByteStream') { throw ('REQUIRED_SNIPPET_INCOMPATIBLE: '+$file.Name) }
    $snippetCount++
}
if ($snippetCount -ne 4) { throw 'REQUIRED_SNIPPET_COVERAGE_CHANGED' }
[IO.Path]::GetFullPath($Root) | Out-Null
[IO.Path]::GetDirectoryName($Root) | Out-Null
[Text.UTF8Encoding]::new($false).GetBytes('compatibility') | Out-Null
[Convert]::FromBase64String([Convert]::ToBase64String([byte[]]@(1,2))) | Out-Null
[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()) | Out-Null
$runbookText=[IO.File]::ReadAllText($Runbook)
foreach ($required in @('Windows PowerShell 5.1','PSEdition','STOP preliminary snapshot failed','STOP preliminary snapshot incomplete or unreadable')) {
    if (-not $runbookText.Contains($required)) { throw 'RUNBOOK_COMPATIBILITY_GATE_MISSING' }
}
$snapshotCommands=@([IO.File]::ReadAllLines($Runbook) | Where-Object { $_ -match '^(\$snapshotText =|if \(-not \$\?\).*STOP preliminary|\$snapshotRows|if \(\$snapshotRows)' })
if ($snapshotCommands.Count -ne 4) { throw 'SNAPSHOT_COMMAND_COVERAGE_CHANGED' }
$preflight=[scriptblock]::Create(($snapshotCommands -join [Environment]::NewLine))
$out=$Root
Push-Location -LiteralPath $Root
try { & $preflight } finally { Pop-Location }
$snapshot=Join-Path $Root 'tools\capture-runtime-snapshot-evidence.ps1'
$output=Join-Path $Root 'snapshot.json'
& $snapshot -OutputPath $output
if (-not $?) { throw 'SNAPSHOT_FAILED' }
$records=Get-Content -LiteralPath $output -Raw -Encoding UTF8 | ConvertFrom-Json
if ($records.Count -ne 5 -or @($records | Where-Object { $_.error -or $_.sha256 -notmatch '^[a-fA-F0-9]{64}$' }).Count) { throw ('INCOMPLETE_SNAPSHOT: '+($records | ConvertTo-Json -Depth 5)) }
$order=@($records | ForEach-Object { $_.path }); $sorted=[string[]]$order.Clone(); [Array]::Sort($sorted,[StringComparer]::Ordinal)
if (($order -join '|') -cne ($sorted -join '|')) { throw 'NONDETERMINISTIC_ORDER' }
$priorCulture=[Threading.Thread]::CurrentThread.CurrentCulture
try {
    [Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo('tr-TR')
    $cultureOutput=Join-Path $Root 'culture-snapshot.json'
    & $snapshot -OutputPath $cultureOutput
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($output)) -cne [Convert]::ToBase64String([IO.File]::ReadAllBytes($cultureOutput))) { throw 'LOCALE_CHANGED_SNAPSHOT' }
} finally { [Threading.Thread]::CurrentThread.CurrentCulture=$priorCulture }
$outputRejected=0
foreach ($target in @((Join-Path $var 'cannot-write.json'),$var,'relative.json',(Join-Path $Root 'missing-parent\snapshot.json'))) {
    $rejected=$false
    try { & $snapshot -OutputPath $target } catch { $rejected=$true }
    if (-not $rejected) { throw 'INVALID_OUTPUT_ACCEPTED' }; $outputRejected++
}
$alias=Join-Path $Root 'output-alias'
New-Item -ItemType Junction -Path $alias -Target $var | Out-Null
$aliasRejected=$false
try { & $snapshot -OutputPath (Join-Path $alias 'cannot-write.json') } catch { $aliasRejected=$true }
if (-not $aliasRejected -or (Test-Path -LiteralPath (Join-Path $var 'cannot-write.json'))) { throw 'OUTPUT_ALIAS_ACCEPTED' }
# Hash failures remain evidence but cannot pass the runbook's completeness gate.
$locked=Join-Path $var 'direct.txt'
$handle=[IO.File]::Open($locked,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
    & $snapshot -OutputPath (Join-Path $Root 'locked-snapshot.json')
    $failedRows=Get-Content -LiteralPath (Join-Path $Root 'locked-snapshot.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($failedRows | Where-Object { $_.error -or -not $_.path -or $_.sha256 -notmatch '^[a-fA-F0-9]{64}$' }).Count -ne 1) { throw 'HASH_FAILURE_GATE_FAILED' }
    $gateRejected=$false
    Push-Location -LiteralPath $Root
    try { & $preflight } catch { $gateRejected=$_.Exception.Message -eq 'STOP preliminary snapshot incomplete or unreadable' } finally { Pop-Location }
    if (-not $gateRejected) { throw 'ACTUAL_RUNBOOK_HASH_FAILURE_ACCEPTED' }
} finally { $handle.Dispose() }
$summary=[pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;records=$records.Count;runbookCommands=$commands.Count;requiredSnippets=$snippetCount;edgeCases=$edgeCases.Count;outsideRejected=$outsideRejected;outputRejected=$outputRejected;outputAliasRejected=$aliasRejected;localeIndependent=$true;hashFailureGate=$true}
[IO.File]::WriteAllText($Result,($summary | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
`;

test('authoritative snapshot and runbook retain Windows PowerShell 5.1 compatibility',{skip:process.platform!=='win32'},async t=>{
    const root=await mkdtemp(join(tmpdir(),'lz-era18-test-'));
    t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(rel.startsWith('lz-era18-test-')&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});});
    await mkdir(join(root,'tools'));await mkdir(join(root,'snippets'));await mkdir(join(root,'var','nested'),{recursive:true});
    const names=['direct.txt','nested/two.txt','space name.txt','nested/caffè-日本.txt','empty.txt'];
    for(const [i,name] of names.entries())await writeFile(join(root,'var',name),i===4?Buffer.alloc(0):Buffer.from([0,i,255,13,10]));
    const source=resolve('tools/test-runtime-snapshot.ps1'),runbook=resolve('docs/NEW-ERA-07-FUTURE-REAL-RUNBOOK.txt');
    const snippets=[];
    for(const path of ['server/recovery/WindowsRecoveryHost.js','server/autolive/ReconcileAuthorityLock.js']){
        const text=await readFile(path,'utf8');
        for(const match of text.matchAll(/(?:const script=|return ps\()`([\s\S]*?)`/g))snippets.push(match[1]);
    }
    const native=await readFile('server/scheduler/WindowsLedgerDurability.js','utf8');
    snippets.push(JSON.parse(native.match(/const hostScript=("(?:\\.|[^"\\])*");/)[1]));
    assert.equal(snippets.length,4,'Update the PS5.1 inventory if required shell snippets change');
    for(const [i,text] of snippets.entries())await writeFile(join(root,'snippets',i+'.ps1'),text);
    await copyFile(source,join(root,'tools','test-runtime-snapshot.ps1'));
    await copyFile(resolve('tools/capture-runtime-snapshot-evidence.ps1'),join(root,'tools','capture-runtime-snapshot-evidence.ps1'));
    const script=join(root,'driver.ps1'),resultPath=join(root,'result.json');await writeFile(script,driver);
    const result=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-Root',root,'-SnapshotSource',source,'-Runbook',runbook,'-Result',resultPath],{env:shellEnv,windowsHide:true,encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stdout+result.stderr);assert.ifError(result.error);
    const summary=JSON.parse(await readFile(resultPath,'utf8'));assert.equal(summary.edition,'Desktop');assert.match(summary.version,/^5\.1\./);
    const records=JSON.parse(await readFile(join(root,'snapshot.json'),'utf8'));assert.equal(records.length,names.length);
    for(const name of names){
        const file=join(root,'var',name),bytes=await readFile(file),info=await stat(file);
        const row=records.find(r=>r.path===win32.relative(join(root,'var'),file));assert.ok(row,name);
        assert.equal(row.size,bytes.length);assert.equal(row.sha256.toLowerCase(),createHash('sha256').update(bytes).digest('hex'));assert.equal(row.error,null);
        assert.equal(Date.parse(row.lastWriteTime),info.mtimeMs-info.mtimeMs%1);
    }
    const again=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-File',join(root,'tools','capture-runtime-snapshot-evidence.ps1'),'-OutputPath',join(root,'snapshot-again.json')],{env:shellEnv,windowsHide:true,encoding:'utf8',timeout:30000});
    assert.equal(again.status,0,again.stderr);assert.deepEqual(await readFile(join(root,'snapshot-again.json')),await readFile(join(root,'snapshot.json')));
    t.diagnostic(JSON.stringify(summary));
});
