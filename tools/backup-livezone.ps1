[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Destination,

    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),

    [switch]$DestinationSecurityConfirmed,

    [switch]$ApplyRetention
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-NormalizedPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
}

function Test-IsWithin([string]$Candidate, [string]$Parent) {
    $candidatePath = "$(Get-NormalizedPath $Candidate)$([System.IO.Path]::DirectorySeparatorChar)"
    $parentPath = "$(Get-NormalizedPath $Parent)$([System.IO.Path]::DirectorySeparatorChar)"
    return $candidatePath.StartsWith($parentPath, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RelativePath([string]$Base, [string]$Path) {
    return [System.IO.Path]::GetRelativePath($Base, $Path).Replace('\', '/')
}

function Get-GitValue([string[]]$Arguments) {
    $value = & git -C $script:sourcePath @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($value | Select-Object -First 1)
}

$sourcePath = Get-NormalizedPath $SourceRoot
$destinationRoot = Get-NormalizedPath $Destination

if (-not $DestinationSecurityConfirmed) {
    throw "Backup contains plaintext secrets. Confirm that the destination is operator-owned and encrypted, then rerun with -DestinationSecurityConfirmed."
}

if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
    throw "LIVEZONE source root does not exist: $sourcePath"
}
if ((Test-IsWithin $destinationRoot $sourcePath) -or
    $destinationRoot.Equals($sourcePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Backup destination must be outside the LIVEZONE repository."
}

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$backupName = $timestamp
$stagingName = ".in-progress-$timestamp-$([guid]::NewGuid().ToString('N'))"
$stagingPath = Join-Path $destinationRoot $stagingName
$finalPath = Join-Path $destinationRoot $backupName

if (Test-Path -LiteralPath $finalPath) {
    throw "A backup already exists for timestamp $timestamp. Run the command again."
}

$knownOperatorAssets = @(
    "public/media/demo2.mp4",
    "public/assets/logo/logo-test.svg",
    "public/media/demo3.mp4",
    "public/media/imm.jpg",
    "public/media/test-audio.mp3"
)

$inventory = [System.Collections.Generic.List[object]]::new()

function Add-BackupFile([string]$Category, [string]$SourceFile, [string]$BackupRelativePath) {
    if (-not (Test-Path -LiteralPath $SourceFile -PathType Leaf)) { return }
    $item = Get-Item -LiteralPath $SourceFile
    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $inventory.Add([pscustomobject]@{
        category = $Category
        sourcePath = Get-RelativePath $sourcePath $item.FullName
        backupPath = $BackupRelativePath.Replace('\', '/')
        size = [int64]$item.Length
        lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString("o")
        sha256 = $hash
    })
}

$envPath = Join-Path $sourcePath ".env"
Add-BackupFile "environment" $envPath "env/.env"

$mediaRoot = Join-Path $sourcePath "var/media-library"
if (Test-Path -LiteralPath $mediaRoot -PathType Container) {
    Get-ChildItem -LiteralPath $mediaRoot -File -Recurse | Where-Object {
        $relative = Get-RelativePath $mediaRoot $_.FullName
        -not ($relative -eq ".tmp" -or $relative.StartsWith(".tmp/"))
    } | ForEach-Object {
        $relative = Get-RelativePath $mediaRoot $_.FullName
        Add-BackupFile "media-library" $_.FullName "media-library/$relative"
    }
}

foreach ($relative in $knownOperatorAssets) {
    Add-BackupFile "operator-assets" (Join-Path $sourcePath $relative) "operator-assets/$relative"
}

if ($inventory.Count -eq 0) {
    throw "No LIVEZONE non-Git data was found to back up."
}

$branch = Get-GitValue @("branch", "--show-current")
$head = Get-GitValue @("rev-parse", "HEAD")
$startedAt = (Get-Date).ToUniversalTime().ToString("o")

New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stagingPath | Out-Null

try {
    foreach ($entry in $inventory) {
        $sourceFile = Join-Path $sourcePath $entry.sourcePath
        $destinationFile = Join-Path $stagingPath $entry.backupPath
        $destinationDirectory = Split-Path -Parent $destinationFile
        New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
        [System.IO.File]::Copy($sourceFile, $destinationFile, $false)
        [System.IO.File]::SetLastWriteTimeUtc(
            $destinationFile,
            [datetime]::Parse($entry.lastWriteTimeUtc).ToUniversalTime()
        )
    }

    foreach ($entry in $inventory) {
        $sourceFile = Join-Path $sourcePath $entry.sourcePath
        $destinationFile = Join-Path $stagingPath $entry.backupPath
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf) -or
            -not (Test-Path -LiteralPath $destinationFile -PathType Leaf)) {
            throw "Backup verification failed for $($entry.sourcePath)."
        }
        $sourceInfo = Get-Item -LiteralPath $sourceFile
        $destinationInfo = Get-Item -LiteralPath $destinationFile
        $sourceHash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash.ToLowerInvariant()
        $destinationHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($sourceInfo.Length -ne $entry.size -or
            $destinationInfo.Length -ne $entry.size -or
            $sourceHash -ne $entry.sha256 -or
            $destinationHash -ne $entry.sha256) {
            throw "Backup integrity mismatch for $($entry.sourcePath)."
        }
    }

    $manifestDirectory = Join-Path $stagingPath "manifest"
    New-Item -ItemType Directory -Path $manifestDirectory | Out-Null
    $manifest = [ordered]@{
        version = 1
        status = "success"
        timestamp = $timestamp
        startedAtUtc = $startedAt
        completedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        repositoryHead = $head
        repositoryBranch = $branch
        sourceRoot = $sourcePath
        destinationRoot = $destinationRoot
        fileCount = $inventory.Count
        totalSize = [int64](($inventory | Measure-Object -Property size -Sum).Sum)
        hashAlgorithm = "SHA256"
        excluded = @("var/media-library/.tmp/")
        files = @($inventory)
    }
    $manifestPath = Join-Path $manifestDirectory "backup-manifest.json"
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
    Move-Item -LiteralPath $stagingPath -Destination $finalPath

    $retentionScript = Join-Path $PSScriptRoot "backup-retention.ps1"
    try {
        $retentionArguments = @("-BackupRoot", $destinationRoot)
        if ($ApplyRetention) { $retentionArguments += "-ApplyRetention" }
        & (Get-Process -Id $PID).Path -NoProfile -File $retentionScript @retentionArguments
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Backup succeeded, but retention analysis failed closed. No retention deletions were performed."
        }
    }
    catch {
        Write-Warning "Backup succeeded, but retention analysis failed closed. No retention deletions were performed."
    }

    $backupDirectories = @(Get-ChildItem -LiteralPath $destinationRoot -Directory |
        Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$' })
    $backupBytes = [int64](($backupDirectories | ForEach-Object {
        (Get-ChildItem -LiteralPath $_.FullName -File -Recurse |
            Measure-Object -Property Length -Sum).Sum
    } | Measure-Object -Sum).Sum)

    [pscustomobject]@{
        Status = "SUCCESS"
        BackupPath = $finalPath
        Timestamp = $timestamp
        Files = $inventory.Count
        Bytes = $manifest.totalSize
        HashVerification = "PASS"
        BackupCount = $backupDirectories.Count
        BackupStorageBytes = $backupBytes
    } | Format-List
    exit 0
}
catch {
    $failurePath = Join-Path $stagingPath "manifest"
    New-Item -ItemType Directory -Path $failurePath -Force | Out-Null
    [ordered]@{
        version = 1
        status = "failed"
        timestamp = $timestamp
        repositoryHead = $head
        repositoryBranch = $branch
        errorType = $_.Exception.GetType().FullName
        errorMessage = $_.Exception.Message
    } | ConvertTo-Json | Set-Content -LiteralPath (
        Join-Path $failurePath "backup-failure.json"
    ) -Encoding utf8NoBOM
    Write-Error "LIVEZONE backup failed. Incomplete data remains at: $stagingPath"
    exit 1
}
