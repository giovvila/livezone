# Visible elevated standalone PowerShell only. No Codex PID/path exemptions.
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$RestoreService,
    [ValidateSet('Prepare','Disarm','Start')][string]$Mode='Prepare',
    [string]$RunId,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedHead,
    [switch]$AuthorizeLegacyQuarantine,
    [switch]$AuthorizeDisarm,
    [switch]$AuthorizeStart,
    [switch]$AuthorizeBootstrap,
    [long]$ExpectedAutoLiveRevision=-1,
    [string]$ExpectedAutoLiveHash
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
if((Get-Location).Path.TrimEnd('\') -ine $repo.TrimEnd('\')){throw 'RUN_FROM_REPOSITORY_ROOT'}
$node=(Get-Command node.exe -CommandType Application).Source
$cli=Join-Path $PSScriptRoot 'recovery-maintenance.mjs'
function Invoke-Recovery([string]$Action,[string[]]$Options=@()) {
    $id=if($RunId){$RunId}else{'-'}
    $raw=& $node $cli $Action $id --expected-head $ExpectedHead @Options
    if($LASTEXITCODE -ne 0){throw "RECOVERY_PHASE_FAILED: $Action"}
    if($raw){($raw -join "`n") | ConvertFrom-Json}
}
if($DryRun){Invoke-Recovery 'DryRun' | ConvertTo-Json -Depth 40; exit 0}
if(!$RunId){throw 'RECOVERY_RUN_ID_REQUIRED'}
if($RestoreService){Invoke-Recovery 'RestoreService' | ConvertTo-Json -Depth 15; exit 0}
switch($Mode){
    'Prepare' {
        $options=@();if($AuthorizeLegacyQuarantine){$options+='--authorize-legacy'}
        $plan=Invoke-Recovery 'Prepare' $options
        $plan | ConvertTo-Json -Depth 10 | Write-Host
        if($plan.scheduled -eq 'VERIFIABLE'){Invoke-Recovery 'Scheduled' | ConvertTo-Json -Depth 10 | Write-Host}
        $auto=Invoke-Recovery 'AutoPlan'
        if(@($auto.args).Count){
            # No orchestrator Node remains alive: only the canonical CLI runs.
            $autoArgs=@($auto.args)
            & $node (Join-Path $PSScriptRoot 'reconcile-autolive-authority.mjs') @autoArgs
            if($LASTEXITCODE -ne 0){throw 'CANONICAL_AUTOLIVE_RECONCILIATION_REFUSED; PRESERVE AUDITS'}
        }
        if($plan.scheduled -ne 'VERIFIABLE'){Invoke-Recovery 'Scheduled' | ConvertTo-Json -Depth 10 | Write-Host}
        Invoke-Recovery 'Prepared' | ConvertTo-Json -Depth 10
    }
    'Disarm' {
        if(!$AuthorizeDisarm){throw 'EXPLICIT_DISARM_AUTHORIZATION_REQUIRED'}
        Write-Host 'AUTOLIVE will be explicitly disarmed; enabled and configured source are preserved.'
        Invoke-Recovery 'Disarm' @('--authorize-disarm','--expected-revision',"$ExpectedAutoLiveRevision",'--expected-hash',$ExpectedAutoLiveHash) | ConvertTo-Json -Depth 10
    }
    'Start' {
        if(!$AuthorizeStart){throw 'EXPLICIT_START_AUTHORIZATION_REQUIRED'}
        $options=@('--authorize-start');if($AuthorizeBootstrap){$options+='--authorize-bootstrap'}
        # One foreground server, visible logs and Ctrl+C. No service startup.
        & $node $cli 'Start' $RunId --expected-head $ExpectedHead @options
        if($LASTEXITCODE -ne 0){throw 'CONTROLLED_START_OR_READINESS_FAILED; PRESERVE EVIDENCE'}
    }
}
