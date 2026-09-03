[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepositoryRoot = (Join-Path $PSScriptRoot ".."),
    [string]$RuntimeRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath($RepositoryRoot)
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $root "var/runtime/winsw" }
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$servicesRuntime = Join-Path $runtime "services"
$targets = @(
    @{ Id = "LivezoneNode"; Wrapper = (Join-Path $servicesRuntime "LivezoneNode/LivezoneNode.exe");
        Config = (Join-Path $servicesRuntime "LivezoneNode/LivezoneNode.xml") },
    @{ Id = "LivezoneMediaMtx"; Wrapper = (Join-Path $servicesRuntime "LivezoneMediaMtx/LivezoneMediaMtx.exe");
        Config = (Join-Path $servicesRuntime "LivezoneMediaMtx/LivezoneMediaMtx.xml") }
)

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Service uninstall requires an elevated Administrator PowerShell session."
}
foreach ($target in $targets) {
    $service = Get-CimInstance Win32_Service -Filter "Name='$($target.Id)'" -ErrorAction SilentlyContinue
    if (-not $service) { continue }
    try {
        $serviceExecutable = [IO.Path]::GetFullPath($service.PathName.Trim().Trim('"'))
    }
    catch { $serviceExecutable = $null }
    if (-not (Test-Path -LiteralPath $target.Wrapper -PathType Leaf) -or
        -not (Test-Path -LiteralPath $target.Config -PathType Leaf) -or
        [IO.Path]::GetFileNameWithoutExtension($target.Wrapper) -cne
            [IO.Path]::GetFileNameWithoutExtension($target.Config) -or
        $serviceExecutable -ne [IO.Path]::GetFullPath($target.Wrapper)) {
        throw "Service identity conflict for $($target.Id); refusing to remove it."
    }
    if ($PSCmdlet.ShouldProcess($target.Id, "Stop and uninstall LIVEZONE service")) {
        & $target.Wrapper stop 2>&1 | Out-Null
        & $target.Wrapper uninstall
        if ($LASTEXITCODE -ne 0) { throw "Failed to uninstall $($target.Id)." }
    }
}

[pscustomobject]@{ Status = "UNINSTALLED"; DataDeleted = $false;
    LogsDeleted = $false; RuntimeDeleted = $false }
