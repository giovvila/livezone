param([string]$Root,[string]$Scenario,[string]$Runbook,[string]$Result)
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'PS51_REQUIRED' }
$fixtureRoot=[IO.Path]::GetFullPath($Root)
$tempPrefix=[IO.Path]::GetTempPath().TrimEnd([char[]]@('\','/'))+'\lz-era24-snapshot-'
if(-not $fixtureRoot.StartsWith($tempPrefix,[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $fixtureRoot -PathType Container)){throw 'TEMP_FIXTURE_REQUIRED'}
if(-not [IO.Path]::GetFullPath($Result).Equals((Join-Path $fixtureRoot 'result.json'),[StringComparison]::OrdinalIgnoreCase)){throw 'FIXTURE_RESULT_REQUIRED'}
$ancestor=$fixtureRoot
while($ancestor){if((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'ALIASED_FIXTURE_REJECTED'};$ancestor=[IO.Path]::GetDirectoryName($ancestor)}
$pure=Join-Path $Root 'tools\test-runtime-snapshot.ps1'
$capture=Join-Path $Root 'tools\capture-runtime-snapshot-evidence.ps1'
$legacy=Join-Path $Root 'tools\legacy-snapshot.ps1'
$output=Join-Path $Root 'existing-output.json'
[IO.File]::WriteAllText($output,'PREEXISTING: must not be truncated',[Text.UTF8Encoding]::new($false))
[IO.File]::SetLastWriteTimeUtc($output,[datetime]'2000-01-01T00:00:00Z')
$prior=[IO.File]::ReadAllBytes($output);$priorTime=[IO.File]::GetLastWriteTimeUtc($output)
$global:SnapshotEffects=[hashtable]::Synchronized(@{enabled=$false;target=$output;observed=(New-Object 'System.Collections.Generic.List[string]');create=0;write=0;truncate=0;rename=0;delete=0;fileSync=0;directorySync=0;native=0;service=0;runtime=0})
# Bind breakpoints to actual .NET mutation calls in the scripts under test.
# AST allowlisting below also excludes uninstrumented mutation call forms.
$breakpoints=@()
foreach($script in @($pure,$capture,$legacy)) {
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($script,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'PARSE_FAILED'}
    foreach($call in $ast.FindAll({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -eq 'WriteAllText'},$true)) {
        $breakpoints+=Set-PSBreakpoint -Script $script -Line $call.Extent.StartLineNumber -Action {
            if($global:SnapshotEffects.enabled){
                $global:SnapshotEffects.write++
                $global:SnapshotEffects.observed.Add('WriteAllText breakpoint: '+$PSDebugContext.InvocationInfo.ScriptName)
                if(Test-Path -LiteralPath $global:SnapshotEffects.target){$global:SnapshotEffects.truncate++}else{$global:SnapshotEffects.create++}
            }
        }
    }
}
$tokens=$null;$errors=$null
$pureAst=[Management.Automation.Language.Parser]::ParseFile($pure,[ref]$tokens,[ref]$errors)
$allowedCommands=@('Join-Path','New-Object','Get-ChildItem','Get-Item','Get-FileHash','ConvertTo-Json','Get-SnapshotRelativePath')
$allowedMembers=@('IsPathRooted','GetFullPath','TrimEnd','StartsWith','Substring','Add','Sort','ToString')
foreach($node in $pureAst.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true)) {
    if($allowedCommands -notcontains $node.GetCommandName()){throw ('FORBIDDEN_COMMAND: '+$node.Extent.Text)}
    if($node.GetCommandName() -eq 'New-Object' -and $node.CommandElements[1].Value -ne 'System.Collections.Generic.List[string]'){throw 'FORBIDDEN_CONSTRUCTOR'}
}
foreach($node in $pureAst.FindAll({param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst]},$true)) {
    if($allowedMembers -notcontains $node.Member.Value){throw ('FORBIDDEN_MEMBER: '+$node.Extent.Text)}
}
if($pureAst.FindAll({param($n) $n -is [Management.Automation.Language.RedirectionAst]},$true).Count){throw 'FORBIDDEN_REDIRECTION'}
# Observe transient filesystem namespace/byte effects across the entire TEMP root.
$watcher=New-Object IO.FileSystemWatcher $Root
$watcher.IncludeSubdirectories=$true
$watcher.NotifyFilter=[IO.NotifyFilters]'FileName,DirectoryName,LastWrite,Size'
$events=@()
foreach($kind in @('Created','Changed','Deleted','Renamed')){
    $events+=Register-ObjectEvent -InputObject $watcher -EventName $kind -MessageData $global:SnapshotEffects -Action {
        if($Event.MessageData.enabled){
            $Event.MessageData.observed.Add($Event.SourceEventArgs.ChangeType.ToString()+': '+$Event.SourceEventArgs.FullPath)
            switch($Event.SourceEventArgs.ChangeType.ToString()){
                'Created'{$Event.MessageData.create++}
                # NTFS may emit delayed directory metadata notifications for
                # fixture setup/read enumeration. Namespace events remain tracked;
                # a directory Changed notification is not a file write or flush.
                'Changed'{if(-not [IO.Directory]::Exists($Event.SourceEventArgs.FullPath)){$Event.MessageData.write++}}
                'Deleted'{$Event.MessageData.delete++} 'Renamed'{$Event.MessageData.rename++}
            }
        }
    }
}
$watcher.EnableRaisingEvents=$true
function Reset-Effects {foreach($key in @('create','write','truncate','rename','delete','fileSync','directorySync','native','service','runtime')){$global:SnapshotEffects[$key]=0}}
function Observe([scriptblock]$Action){
    Reset-Effects;$global:SnapshotEffects.enabled=$true
    try{$value=& $Action;Start-Sleep -Milliseconds 200;return $value}finally{$global:SnapshotEffects.enabled=$false}
}
function Assert-Zero {foreach($key in @('create','write','truncate','rename','delete','fileSync','directorySync','native','service','runtime')){if($global:SnapshotEffects[$key] -ne 0){throw ('FORBIDDEN_EFFECT: '+$key+' '+($global:SnapshotEffects.observed -join '; '))}}}
try {
    $snapshot=$null;$red=$null
    if($Scenario -eq 'red-green'){
        $redPath=Join-Path $Root 'red-output.json';$global:SnapshotEffects.target=$redPath
        Observe {& $legacy -OutputPath $redPath} | Out-Null
        if($global:SnapshotEffects.create -lt 1 -or $global:SnapshotEffects.write -lt 1){throw 'RED_NOT_OBSERVED'}
        $red=@{create=$global:SnapshotEffects.create;write=$global:SnapshotEffects.write}
        $old=[IO.File]::ReadAllText($redPath)
        Start-Sleep -Milliseconds 200
        $snapshot=Observe {& $pure};Assert-Zero
        if($snapshot -cne $old){throw 'LEGACY_SEMANTICS_CHANGED'}
    }elseif($Scenario -eq 'existing'){
        $snapshot=Observe {& $pure};Assert-Zero
        $rejected=$false
        Observe {try{& $pure -OutputPath $output}catch{$script:rejected=$true}}|Out-Null
        Assert-Zero;if(-not $rejected){throw 'PURE_ACCEPTED_OUTPUT_ARGUMENT'}
    }elseif($Scenario -eq 'equivalence'){
        $snapshot=Observe {& $pure};Assert-Zero
        $global:SnapshotEffects.target=$output
        Observe {& $capture -OutputPath $output}|Out-Null
        if($global:SnapshotEffects.write -lt 1 -or $global:SnapshotEffects.truncate -lt 1){throw 'PERSISTENCE_NOT_OBSERVED'}
        if(($snapshot|ConvertFrom-Json|ConvertTo-Json -Depth 5) -cne ([IO.File]::ReadAllText($output)|ConvertFrom-Json|ConvertTo-Json -Depth 5)){throw 'PURE_PERSIST_DIFFER'}
    }elseif($Scenario -eq 'step0'){
        $commands=@([IO.File]::ReadAllLines($Runbook)|Where-Object {$_ -match '^(\$snapshotText =|if \(-not \$\?\).*STOP preliminary|\$snapshotRows|if \(\$snapshotRows)'})
        if($commands.Count -ne 4){throw 'STEP0_COVERAGE_CHANGED'}
        $preflight=[scriptblock]::Create($commands -join [Environment]::NewLine)
        Push-Location -LiteralPath $Root
        try{Observe {& $preflight}|Out-Null;Assert-Zero}finally{Pop-Location}
        if(Test-Path -LiteralPath (Join-Path $Root 'before-var.json')){throw 'STEP0_PERSISTED'}
        $snapshot=Observe {& $pure};Assert-Zero
    }else{throw 'UNKNOWN_SCENARIO'}
    if($Scenario -ne 'equivalence'){
        if([Convert]::ToBase64String($prior) -cne [Convert]::ToBase64String([IO.File]::ReadAllBytes($output)) -or $priorTime -ne [IO.File]::GetLastWriteTimeUtc($output)){throw 'EXISTING_OUTPUT_CHANGED'}
    }
    $effects=@{};foreach($key in @('create','write','truncate','rename','delete','fileSync','directorySync','native','service','runtime')){$effects[$key]=$global:SnapshotEffects[$key]}
    $summary=@{scenario=$Scenario;version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;effects=$effects;red=$red;snapshotJson=$snapshot;existingPreserved=($Scenario -ne 'equivalence')}
}finally{
    $global:SnapshotEffects.enabled=$false;$watcher.EnableRaisingEvents=$false;$watcher.Dispose()
    foreach($job in $events){Unregister-Event -SourceIdentifier $job.Name -ErrorAction SilentlyContinue;Remove-Job -Job $job -Force}
    if($breakpoints.Count){Remove-PSBreakpoint -Breakpoint $breakpoints}
}
[IO.File]::WriteAllText($Result,($summary|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
