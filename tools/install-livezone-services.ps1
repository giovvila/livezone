[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Join-Path $PSScriptRoot ".."),
    [string]$WinSWPath,
    [string]$RuntimeRoot,
    [string]$LogDirectory,
    [string]$NodePath,
    [string]$MediaMtxBinaryPath,
    [string]$EnvironmentPath,
    [Parameter(Mandatory)]
    [ValidateSet("LocalSystem")]
    [string]$ServiceIdentity,
    [switch]$ValidateOnly,
    [switch]$GenerateOnly,
    [switch]$StartServices
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$winSwVersion = "2.12.0"
$mediaMtxVersion = "1.20.1"
$serviceIds = @("LivezoneMediaMtx", "LivezoneNode")
$root = [IO.Path]::GetFullPath($RepositoryRoot)
if (-not $WinSWPath) { $WinSWPath = Join-Path $root "var/runtime/winsw/WinSW-x64.exe" }
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $root "var/runtime/winsw" }
if (-not $LogDirectory) { $LogDirectory = Join-Path $root "var/log/livezone" }
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
if (-not $MediaMtxBinaryPath) { $MediaMtxBinaryPath = Join-Path $root "var/runtime/mediamtx/mediamtx.exe" }
if (-not $EnvironmentPath) { $EnvironmentPath = Join-Path $root ".env" }

function Assert-File([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing." }
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-EnvironmentValues([string]$Path) {
    $values = @{}
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

function Assert-Version([string]$Executable, [string]$Argument,
    [string]$Expected, [string]$Label) {
    $output = (& $Executable $Argument 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $output -notmatch
        "(?<!\d)$([regex]::Escape($Expected))(?!\d)") {
        throw "$Label version mismatch. Required version: $Expected."
    }
}

function ConvertTo-WinSWReleaseVersion([string]$Version) {
    if ([string]::IsNullOrWhiteSpace($Version)) { return $null }
    $match = [regex]::Match($Version.Trim(),
        '^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:\.0)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')
    if (-not $match.Success) { return $null }
    return '{0}.{1}.{2}' -f $match.Groups['major'].Value,
        $match.Groups['minor'].Value, $match.Groups['patch'].Value
}

function Assert-WinSWVersion([string]$Executable, [string]$Expected) {
    try {
        $versionInfo = (Get-Item -LiteralPath $Executable -ErrorAction Stop).VersionInfo
        $metadataVersion = $versionInfo.ProductVersion
        if ([string]::IsNullOrWhiteSpace($metadataVersion)) {
            $metadataVersion = $versionInfo.FileVersion
        }
    }
    catch {
        throw "WinSW version metadata is unreadable. Required version: $Expected."
    }
    $releaseVersion = ConvertTo-WinSWReleaseVersion $metadataVersion
    if ($releaseVersion -ne $Expected) {
        throw "WinSW version mismatch. Required version: $Expected."
    }
}

function ConvertTo-XmlPath([string]$Path) {
    return [Security.SecurityElement]::Escape([IO.Path]::GetFullPath($Path))
}

function ConvertTo-XmlArgument([string]$Path) {
    return [Security.SecurityElement]::Escape(('"' + [IO.Path]::GetFullPath($Path) + '"'))
}

function Write-Configuration([string]$TemplatePath, [string]$Destination,
    [hashtable]$Values) {
    $content = Get-Content -Raw -LiteralPath $TemplatePath
    foreach ($entry in $Values.GetEnumerator()) {
        $content = $content.Replace("__$($entry.Key)__", $entry.Value)
    }
    if ($content -match '__[A-Z0-9_]+__' -or
        $content -match 'LIVEZONE_(?:PROGRAM_OUTPUT_TOKEN|RTMP_PUBLISH_USER|RTMP_PUBLISH_PASSWORD)\s*=') {
        throw "Generated service configuration failed closed validation."
    }
    Set-Content -LiteralPath $Destination -Value $content -Encoding utf8NoBOM
}

function Assert-BundledServiceFiles([string]$Wrapper, [string]$Config,
    [string]$ServiceId) {
    Assert-File $Wrapper "$ServiceId bundled WinSW wrapper"
    Assert-File $Config "$ServiceId bundled WinSW configuration"
    if ([IO.Path]::GetFileNameWithoutExtension($Wrapper) -cne
        [IO.Path]::GetFileNameWithoutExtension($Config)) {
        throw "$ServiceId bundled WinSW wrapper/config basename mismatch."
    }
}

function Wait-HttpReady([string]$Uri, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -SkipHttpErrorCheck -Uri $Uri -TimeoutSec 3
            if ([int]$response.StatusCode -eq 200) { return $true }
        }
        catch {}
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

if ($ValidateOnly -and $GenerateOnly) { throw "Choose ValidateOnly or GenerateOnly, not both." }
$winSw = [IO.Path]::GetFullPath($WinSWPath)
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$logs = [IO.Path]::GetFullPath($LogDirectory)
$node = [IO.Path]::GetFullPath($NodePath)
$mediaMtx = [IO.Path]::GetFullPath($MediaMtxBinaryPath)
$environment = [IO.Path]::GetFullPath($EnvironmentPath)
$powerShell = (Get-Command pwsh.exe -ErrorAction Stop).Source
$nodeTemplate = Join-Path $root "ops/windows-services/livezone-node.xml.template"
$mediaTemplate = Join-Path $root "ops/windows-services/livezone-mediamtx.xml.template"
$nodeServer = Join-Path $root "server/program-output-server.js"
$mediaLauncher = Join-Path $root "tools/start-mediamtx.ps1"
$mediaConfigTemplate = Join-Path $root "ops/mediamtx/mediamtx.example.yml"
$mediaRuntimeConfig = Join-Path $root "var/runtime/mediamtx/mediamtx.yml"

Assert-File $winSw "WinSW v$winSwVersion executable"
Assert-File $node "Node executable"
Assert-File $mediaMtx "MediaMTX v$mediaMtxVersion executable"
Assert-File $environment "LIVEZONE environment file"
foreach ($file in @($nodeTemplate, $mediaTemplate, $nodeServer, $mediaLauncher,
    $mediaConfigTemplate)) { Assert-File $file "Required repository prerequisite" }
Assert-WinSWVersion $winSw $winSwVersion
Assert-Version $mediaMtx "--version" $mediaMtxVersion "MediaMTX"
$nodeVersion = (& $node --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(?:2[0-9]|[3-9][0-9])\.') {
    throw "Node.js 20 or newer is required."
}
$environmentValues = Get-EnvironmentValues $environment
foreach ($name in @("LIVEZONE_PROGRAM_OUTPUT_TOKEN", "LIVEZONE_RTMP_PUBLISH_USER",
    "LIVEZONE_RTMP_PUBLISH_PASSWORD")) {
    if (-not $environmentValues.ContainsKey($name) -or
        [string]::IsNullOrWhiteSpace($environmentValues[$name])) {
        throw "Required environment variable is missing or empty: $name"
    }
}
if ($environmentValues["LIVEZONE_PROGRAM_OUTPUT_TOKEN"].Length -lt 16) {
    throw "LIVEZONE_PROGRAM_OUTPUT_TOKEN must contain at least 16 characters."
}

if ($ValidateOnly) {
    [pscustomobject]@{ Status = "VALID"; WinSWVersion = $winSwVersion;
        MediaMTXVersion = $mediaMtxVersion; ServiceIdentity = $ServiceIdentity;
        ServicesInstalled = $false }
    exit 0
}

if (-not $GenerateOnly -and -not (Test-Administrator)) {
    throw "Service installation requires an elevated Administrator PowerShell session."
}
if (-not $GenerateOnly) {
    foreach ($id in $serviceIds) {
        if (Get-Service -Name $id -ErrorAction SilentlyContinue) {
            throw "Service conflict detected: $id already exists. No service was changed."
        }
    }
    foreach ($port in 1935, 8080, 8888, 9997) {
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
            throw "Runtime port $port is already occupied. Stop the manual runtime before installation."
        }
    }
}

$servicesRuntime = Join-Path $runtime "services"
$nodeRuntime = Join-Path $servicesRuntime "LivezoneNode"
$mediaRuntime = Join-Path $servicesRuntime "LivezoneMediaMtx"
New-Item -ItemType Directory -Path $nodeRuntime, $mediaRuntime, $logs -Force | Out-Null
$nodeWrapper = Join-Path $nodeRuntime "LivezoneNode.exe"
$nodeConfig = Join-Path $nodeRuntime "LivezoneNode.xml"
$mediaWrapper = Join-Path $mediaRuntime "LivezoneMediaMtx.exe"
$mediaConfig = Join-Path $mediaRuntime "LivezoneMediaMtx.xml"
Copy-Item -LiteralPath $winSw -Destination $nodeWrapper -Force
Copy-Item -LiteralPath $winSw -Destination $mediaWrapper -Force
$common = @{
    REPOSITORY_ROOT = ConvertTo-XmlPath $root
    ENV_PATH = ConvertTo-XmlArgument $environment
    LOG_DIRECTORY = ConvertTo-XmlPath $logs
}
Write-Configuration $nodeTemplate $nodeConfig (@{} + $common + @{
    NODE_EXECUTABLE = ConvertTo-XmlPath $node
    NODE_SERVER = ConvertTo-XmlArgument $nodeServer
})
Write-Configuration $mediaTemplate $mediaConfig (@{} + $common + @{
    POWERSHELL_EXECUTABLE = ConvertTo-XmlPath $powerShell
    MEDIAMTX_LAUNCHER = ConvertTo-XmlArgument $mediaLauncher
    MEDIAMTX_BINARY = ConvertTo-XmlArgument $mediaMtx
    MEDIAMTX_TEMPLATE = ConvertTo-XmlArgument $mediaConfigTemplate
    MEDIAMTX_CONFIG = ConvertTo-XmlArgument $mediaRuntimeConfig
})
Assert-BundledServiceFiles $nodeWrapper $nodeConfig "LivezoneNode"
Assert-BundledServiceFiles $mediaWrapper $mediaConfig "LivezoneMediaMtx"

if ($GenerateOnly) {
    [pscustomobject]@{ Status = "GENERATED"; ServiceIdentity = $ServiceIdentity;
        ServicesInstalled = $false }
    exit 0
}

$bundles = @(
    @{ Id = "LivezoneMediaMtx"; Wrapper = $mediaWrapper; Config = $mediaConfig },
    @{ Id = "LivezoneNode"; Wrapper = $nodeWrapper; Config = $nodeConfig }
)
$installed = @()
try {
    foreach ($bundle in $bundles) {
        Assert-BundledServiceFiles $bundle.Wrapper $bundle.Config $bundle.Id
        & $bundle.Wrapper install
        if ($LASTEXITCODE -ne 0) { throw "WinSW service installation failed." }
        $installed += $bundle
    }
}
catch {
    [array]::Reverse($installed)
    foreach ($bundle in $installed) { & $bundle.Wrapper uninstall 2>&1 | Out-Null }
    throw
}

if ($StartServices) {
    & $mediaWrapper start
    if ($LASTEXITCODE -ne 0) { throw "MediaMTX service failed to start." }
    & $nodeWrapper start
    if ($LASTEXITCODE -ne 0) { throw "Node service failed to start." }
    if (-not (Wait-HttpReady "http://127.0.0.1:8080/healthz" 30)) {
        throw "Node service did not become live within the startup deadline."
    }
    if (-not (Wait-HttpReady "http://127.0.0.1:8080/readyz" 10)) {
        throw "Node service did not become ready within the startup deadline."
    }
}
[pscustomobject]@{ Status = "INSTALLED"; ServiceIdentity = $ServiceIdentity;
    ServicesInstalled = $true; ServicesStarted = [bool]$StartServices }
