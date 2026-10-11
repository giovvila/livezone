[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ProbeRoot)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=[IO.Path]::GetFullPath($ProbeRoot)
$temp=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
if(-not $root.StartsWith($temp+'\',[StringComparison]::OrdinalIgnoreCase) -or
   -not ([IO.Path]::GetFileName($root)).StartsWith('lz-era05-probe-') -or
   -not (Test-Path -LiteralPath $root -PathType Container) -or
   ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'PROBE_TEMP_ROOT_REQUIRED'}
if(-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'ADMINISTRATOR_REQUIRED'}
$sc=Join-Path $env:SystemRoot 'System32/sc.exe'
$node=(Get-Command node.exe -CommandType Application).Source
$script=Join-Path $PSScriptRoot 'localsystem-durability-probe.mjs'
$hash=(Get-FileHash -LiteralPath $script).Hash.ToLowerInvariant()
$template=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'native/localsystem-probe/ProbeService.cs') -Raw
$framework=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319'
$compiler='C:\Program Files\dotnet\sdk\8.0.319\Roslyn\bincore\csc.dll'
function Encode([string]$Value){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))}
function Invoke-Sc([string[]]$Arguments){$output=& $sc @Arguments 2>&1;if($LASTEXITCODE -ne 0){throw "SC operation failed: $($Arguments[0]): $output"};$output | Out-File -LiteralPath (Join-Path $root 'sc-transcript.txt') -Append}
$outcomes=@()
foreach($mode in @('success','fail','timeout','interrupted')){
    $name='LzDurabilityProbe_'+[guid]::NewGuid().ToString('N')
    $source=$template.Replace('__ROOT__',(Encode $root)).Replace('__NODE__',(Encode $node)).Replace('__SCRIPT__',(Encode $script)).Replace('__SCRIPT_HASH__',$hash).Replace('__MODE__',$mode).Replace('__SERVICE__',$name)
    $sourcePath=Join-Path $root ($mode+'.cs');$binary=Join-Path $root ($mode+'.exe')
    Set-Content -LiteralPath $sourcePath -Value $source
    & 'C:\Program Files\dotnet\dotnet.exe' exec $compiler /nologo /target:exe /platform:x64 /optimize+ /debug- /noconfig /nostdlib+ "/reference:$framework/mscorlib.dll" "/reference:$framework/System.dll" "/reference:$framework/System.ServiceProcess.dll" "/out:$binary" $sourcePath
    if($LASTEXITCODE -ne 0){throw 'PROBE_SERVICE_BUILD_FAILED'}
    $created=$false;$failure=$null
    try{
        if(Get-Service -Name $name -ErrorAction SilentlyContinue){throw 'PROBE_SERVICE_NAME_COLLISION'}
        Invoke-Sc -Arguments @('create',$name,'binPath=',('"'+$binary+'"'),'start=','demand','obj=','LocalSystem');$created=$true
        Invoke-Sc -Arguments @('start',$name)
        if($mode -eq 'interrupted'){
            $deadline=(Get-Date).AddSeconds(20)
            while(-not (Test-Path -LiteralPath (Join-Path $root 'waiting-interrupted.json')) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 100}
            if(-not (Test-Path -LiteralPath (Join-Path $root 'waiting-interrupted.json'))){throw 'INTERRUPTION_MARKER_TIMEOUT'}
            Stop-Service -Name $name -ErrorAction Stop
        }
        $deadline=(Get-Date).AddSeconds(65)
        while((Get-Service -Name $name).Status -ne 'Stopped' -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 100}
        if((Get-Service -Name $name).Status -ne 'Stopped'){throw 'PROBE_SUPERVISOR_TIMEOUT'}
        if(Test-Path -LiteralPath (Join-Path $root ('host-error-'+$mode+'.txt'))){throw (Get-Content -LiteralPath (Join-Path $root ('host-error-'+$mode+'.txt')) -Raw)}
        $identity=Get-Content -LiteralPath (Join-Path $root ('identity-'+$mode+'.json')) -Raw | ConvertFrom-Json
        if($identity.sid -ne 'S-1-5-18'){throw 'LOCALSYSTEM_IDENTITY_FAILED'}
        if($mode -eq 'success'){$result=Get-Content -LiteralPath (Join-Path $root 'result-success.json') -Raw | ConvertFrom-Json;if($result.status -ne 'PASS'){throw ('CAPABILITY_FAILED: '+$result.error)}}
        if($mode -eq 'fail'){$result=Get-Content -LiteralPath (Join-Path $root 'result-fail.json') -Raw | ConvertFrom-Json;if($result.error -ne 'DELIBERATE_PROBE_FAILURE'){throw 'FAILURE_CONTRACT_FAILED'}}
        if($mode -eq 'timeout' -and (Get-Content -LiteralPath (Join-Path $root 'host-result-timeout.txt') -Raw).Trim() -ne 'TIMEOUT'){throw 'TIMEOUT_CONTRACT_FAILED'}
        if($mode -in @('timeout','interrupted')){
            $waiting=Get-Content -LiteralPath (Join-Path $root ('waiting-'+$mode+'.json')) -Raw | ConvertFrom-Json
            foreach($probePid in @($waiting.pid,$waiting.childPid)){if(Get-Process -Id $probePid -ErrorAction SilentlyContinue){throw "PROBE_CHILD_SURVIVED: $probePid"}}
        }
    }catch{$failure=$_.Exception.Message}
    finally{
        if($created){$service=Get-Service -Name $name -ErrorAction SilentlyContinue;if($service -and $service.Status -ne 'Stopped'){Stop-Service -Name $name -ErrorAction Stop};Invoke-Sc -Arguments @('delete',$name)
            $deadline=(Get-Date).AddSeconds(10);while((Get-Service -Name $name -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 100}
            if(Get-Service -Name $name -ErrorAction SilentlyContinue){throw 'PROBE_SERVICE_CLEANUP_FAILED'}
        }
        $outcomes += [pscustomobject]@{mode=$mode;service=$name;binary=$binary;binarySha256=(Get-FileHash -LiteralPath $binary).Hash;removed=$created -and -not [bool](Get-Service -Name $name -ErrorAction SilentlyContinue);failure=$failure}
        $outcomes | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'service-outcomes.json')
    }
    if($failure){throw $failure}
}
$outcomes | ConvertTo-Json -Depth 5

