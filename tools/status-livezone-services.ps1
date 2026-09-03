[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Join-Path $PSScriptRoot "..")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath($RepositoryRoot)
$runtime = Join-Path $root "var/runtime/winsw"
$winSw = Join-Path $runtime "WinSW-x64.exe"
$servicesRuntime = Join-Path $runtime "services"
$definitions = @(
    @{ Id = "LivezoneMediaMtx";
        Wrapper = (Join-Path $servicesRuntime "LivezoneMediaMtx/LivezoneMediaMtx.exe");
        Config = (Join-Path $servicesRuntime "LivezoneMediaMtx/LivezoneMediaMtx.xml") },
    @{ Id = "LivezoneNode";
        Wrapper = (Join-Path $servicesRuntime "LivezoneNode/LivezoneNode.exe");
        Config = (Join-Path $servicesRuntime "LivezoneNode/LivezoneNode.xml") }
)

function Get-SafeHttpStatus([string]$Uri, [switch]$IncludeBody) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -SkipHttpErrorCheck -Uri $Uri -TimeoutSec 3
        $result = @{ Reachable = $true; HttpStatus = [int]$response.StatusCode }
        if ($IncludeBody) {
            $body = $response.Content | ConvertFrom-Json
            $result.Status = [string]$body.status
            $result.Ok = [bool]$body.ok
        }
        return [pscustomobject]$result
    }
    catch { return [pscustomobject]@{ Reachable = $false; HttpStatus = $null } }
}

$services = foreach ($definition in $definitions) {
    $service = Get-Service -Name $definition.Id -ErrorAction SilentlyContinue
    [pscustomobject]@{
        ServiceId = $definition.Id
        Installed = [bool]$service
        State = if ($service) { [string]$service.Status } else { "NotInstalled" }
        Startup = if ($service) { [string]$service.StartType } else { "Unavailable" }
        WrapperPresent = Test-Path -LiteralPath $definition.Wrapper -PathType Leaf
        ConfigPresent = Test-Path -LiteralPath $definition.Config -PathType Leaf
    }
}
$listeners = foreach ($port in 1935, 8080, 8888, 9997) {
    $active = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    [pscustomobject]@{ Port = $port; Listening = [bool]$active }
}
[pscustomobject]@{
    SourceWinSWPresent = Test-Path -LiteralPath $winSw -PathType Leaf
    Services = $services
    Listeners = $listeners
    Health = Get-SafeHttpStatus "http://127.0.0.1:8080/healthz" -IncludeBody
    Readiness = Get-SafeHttpStatus "http://127.0.0.1:8080/readyz" -IncludeBody
    MediaMtxControl = Get-SafeHttpStatus "http://127.0.0.1:9997/v3/paths/list"
}
