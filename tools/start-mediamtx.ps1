[CmdletBinding()]
param(
    [string]$BinaryPath = (Join-Path $PSScriptRoot "../var/runtime/mediamtx/mediamtx.exe"),
    [string]$TemplatePath = (Join-Path $PSScriptRoot "../ops/mediamtx/mediamtx.example.yml"),
    [string]$RuntimeConfigPath = (Join-Path $PSScriptRoot "../var/runtime/mediamtx/mediamtx.yml"),
    [string]$EnvironmentPath = (Join-Path $PSScriptRoot "../.env"),
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$pinnedVersion = "1.20.1"
$requiredVariables = @(
    "LIVEZONE_RTMP_PUBLISH_USER",
    "LIVEZONE_RTMP_PUBLISH_PASSWORD"
)

function Get-LocalEnvironment([string]$Path) {
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $values }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
            $value = $Matches[2].Trim()
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            $values[$Matches[1]] = $value
        }
    }
    return $values
}

function Test-PortAvailable([int]$Port) {
    return -not [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function ConvertTo-YamlScalar([string]$Value) {
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

$binary = [System.IO.Path]::GetFullPath($BinaryPath)
$template = [System.IO.Path]::GetFullPath($TemplatePath)
$runtimeConfig = [System.IO.Path]::GetFullPath($RuntimeConfigPath)
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw "MediaMTX binary missing. Place v$pinnedVersion at the documented ignored runtime path."
}
if (-not (Test-Path -LiteralPath $template -PathType Leaf)) {
    throw "MediaMTX configuration template is missing."
}
$versionOutput = (& $binary --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch '(?<!\d)1\.20\.1(?!\d)') {
    throw "MediaMTX version mismatch. Required version: $pinnedVersion."
}

$localEnvironment = Get-LocalEnvironment $EnvironmentPath
foreach ($name in $requiredVariables) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) { $value = $localEnvironment[$name] }
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Required local MediaMTX credential variable is missing or empty: $name"
    }
    Set-Variable -Name $name -Value $value
}
foreach ($port in 1935, 8888, 9997) {
    if (-not (Test-PortAvailable $port)) { throw "Required MediaMTX port is occupied: $port" }
}

$configuration = (Get-Content -Raw -LiteralPath $template)
$configuration = $configuration.Replace(
    '"__LIVEZONE_RTMP_PUBLISH_USER__"',
    (ConvertTo-YamlScalar $LIVEZONE_RTMP_PUBLISH_USER)
).Replace(
    '"__LIVEZONE_RTMP_PUBLISH_PASSWORD__"',
    (ConvertTo-YamlScalar $LIVEZONE_RTMP_PUBLISH_PASSWORD)
)
if ($configuration -notmatch '(?m)^apiAddress:\s+127\.0\.0\.1:9997\s*$' -or
    $configuration -notmatch '(?m)^\s*path:\s+livezone-test\s*$' -or
    $configuration -match '__LIVEZONE_RTMP_') {
    throw "Generated MediaMTX configuration failed closed validation."
}

$runtimeDirectory = Split-Path -Parent $runtimeConfig
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$configuration | Set-Content -LiteralPath $runtimeConfig -Encoding utf8NoBOM

[pscustomobject]@{
    Status = "VALID"
    Version = $pinnedVersion
    Binary = $binary
    RuntimeConfig = $runtimeConfig
    MediaPath = "livezone-test"
    RtmpPort = 1935
    HlsPort = 8888
    ApiAddress = "127.0.0.1:9997"
    PublishAuthentication = "REQUIRED"
} | Format-List

if (-not $ValidateOnly) {
    & $binary $runtimeConfig
    exit $LASTEXITCODE
}
