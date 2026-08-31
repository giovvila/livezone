[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupRoot,

    [switch]$ApplyRetention,

    [switch]$Json
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$timestampPattern = '^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$'

function Get-NormalizedPath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
}

function Get-BackupRecord([System.IO.DirectoryInfo]$Directory) {
    if ($Directory.Name -notmatch $script:timestampPattern) { return $null }

    $timestamp = [datetime]::MinValue
    if (-not [datetime]::TryParseExact(
        $Directory.Name,
        'yyyy-MM-dd_HH-mm-ss',
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::None,
        [ref]$timestamp
    )) { return $null }

    $manifestPath = Join-Path $Directory.FullName 'manifest/backup-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }

    try {
        $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
        if ($manifest.status -ne 'success' -or
            $manifest.timestamp -ne $Directory.Name -or
            $manifest.hashAlgorithm -ne 'SHA256' -or
            [int]$manifest.fileCount -le 0 -or
            [int64]$manifest.totalSize -lt 0 -or
            @($manifest.files).Count -ne [int]$manifest.fileCount) {
            return $null
        }
        foreach ($file in @($manifest.files)) {
            if ([string]::IsNullOrWhiteSpace([string]$file.backupPath) -or
                [int64]$file.size -lt 0 -or
                [string]$file.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
                return $null
            }
        }
    }
    catch { return $null }

    return [pscustomobject]@{
        Name = $Directory.Name
        Path = $Directory.FullName
        Timestamp = $timestamp
        IsoYear = [System.Globalization.ISOWeek]::GetYear($timestamp)
        IsoWeek = [System.Globalization.ISOWeek]::GetWeekOfYear($timestamp)
        Month = $timestamp.ToString('yyyy-MM', [System.Globalization.CultureInfo]::InvariantCulture)
    }
}

function Select-NewestPerGroup([object[]]$Records, [scriptblock]$GroupBy, [int]$Limit) {
    return @($Records |
        Group-Object -Property $GroupBy |
        ForEach-Object { $_.Group | Sort-Object Timestamp -Descending | Select-Object -First 1 } |
        Sort-Object Timestamp -Descending |
        Select-Object -First $Limit)
}

function Get-RetentionPlan([string]$Root) {
    $normalizedRoot = Get-NormalizedPath $Root
    if (-not (Test-Path -LiteralPath $normalizedRoot -PathType Container)) {
        throw "Backup root does not exist: $normalizedRoot"
    }

    $directories = @(Get-ChildItem -LiteralPath $normalizedRoot -Directory)
    $verified = [System.Collections.Generic.List[object]]::new()
    $unknown = [System.Collections.Generic.List[string]]::new()
    foreach ($directory in $directories) {
        $record = Get-BackupRecord $directory
        if ($null -eq $record) { $unknown.Add($directory.Name) } else { $verified.Add($record) }
    }
    if ($verified.Count -eq 0) {
        throw 'LAST_KNOWN_GOOD cannot be determined; retention failed closed.'
    }

    $ordered = @($verified | Sort-Object Timestamp -Descending)
    $lastKnownGood = $ordered[0]
    $daily = @($ordered | Select-Object -First 7)
    $weekly = Select-NewestPerGroup $ordered { "$($_.IsoYear)-W$($_.IsoWeek.ToString('00'))" } 4
    $monthly = Select-NewestPerGroup $ordered { $_.Month } 6

    $keepNames = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    @($daily) + @($weekly) + @($monthly) + @($lastKnownGood) | ForEach-Object {
        [void]$keepNames.Add($_.Name)
    }
    $delete = @($ordered | Where-Object { -not $keepNames.Contains($_.Name) })

    return [pscustomobject]@{
        Root = $normalizedRoot
        TotalDiscovered = $directories.Count
        VerifiedSuccessfulCount = $verified.Count
        LastKnownGood = $lastKnownGood.Name
        DailyKeep = @($daily | ForEach-Object Name)
        WeeklyKeep = @($weekly | ForEach-Object Name)
        MonthlyKeep = @($monthly | ForEach-Object Name)
        FinalKeep = @($ordered | Where-Object { $keepNames.Contains($_.Name) } | ForEach-Object Name)
        DeleteCandidates = @($delete | ForEach-Object Name)
        UnknownOrProtected = @($unknown)
    }
}

function Remove-ValidatedCandidate([string]$Root, [string]$Name, [string]$LastKnownGood) {
    $normalizedRoot = Get-NormalizedPath $Root
    if ($Name -eq $LastKnownGood -or $Name -notmatch $script:timestampPattern) {
        throw "Refusing unsafe retention candidate: $Name"
    }
    $candidatePath = Get-NormalizedPath (Join-Path $normalizedRoot $Name)
    $parentPath = Get-NormalizedPath (Split-Path -Parent $candidatePath)
    if (-not $parentPath.Equals($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Retention candidate is not a direct child of the backup root: $Name"
    }
    $directory = Get-Item -LiteralPath $candidatePath -ErrorAction Stop
    if ($null -eq (Get-BackupRecord $directory)) {
        throw "Retention candidate is no longer a verified successful backup: $Name"
    }
    Remove-Item -LiteralPath $candidatePath -Recurse -Force
}

$mode = if ($ApplyRetention) { 'APPLY' } else { 'DRY_RUN' }
try {
    $plan = Get-RetentionPlan $BackupRoot
    $deleted = [System.Collections.Generic.List[string]]::new()
    if ($ApplyRetention) {
        # Recalculate from disk immediately before applying; never reuse a stale plan.
        $plan = Get-RetentionPlan $BackupRoot
        foreach ($candidate in @($plan.DeleteCandidates)) {
            Remove-ValidatedCandidate $plan.Root $candidate $plan.LastKnownGood
            $deleted.Add($candidate)
        }
    }
    $result = [ordered]@{
        retentionMode = $mode
        weekConvention = 'ISO-8601'
        lastKnownGood = $plan.LastKnownGood
        totalDiscovered = $plan.TotalDiscovered
        verifiedSuccessfulCount = $plan.VerifiedSuccessfulCount
        dailyKeep = @($plan.DailyKeep)
        weeklyKeep = @($plan.WeeklyKeep)
        monthlyKeep = @($plan.MonthlyKeep)
        finalKeep = @($plan.FinalKeep)
        deleteCandidates = @($plan.DeleteCandidates)
        unknownOrProtected = @($plan.UnknownOrProtected)
        deleted = @($deleted)
    }
    if ($Json) {
        $result | ConvertTo-Json -Depth 5 -Compress
    }
    else {
        [pscustomobject]@{
            RETENTION_MODE = $result.retentionMode
            LAST_KNOWN_GOOD = $result.lastKnownGood
            TOTAL_DISCOVERED = $result.totalDiscovered
            VERIFIED_SUCCESSFUL_COUNT = $result.verifiedSuccessfulCount
            DAILY_KEEP = $result.dailyKeep -join ', '
            WEEKLY_KEEP = $result.weeklyKeep -join ', '
            MONTHLY_KEEP = $result.monthlyKeep -join ', '
            FINAL_KEEP_COUNT = $result.finalKeep.Count
            DELETE_CANDIDATE_COUNT = $result.deleteCandidates.Count
            UNKNOWN_OR_PROTECTED_COUNT = $result.unknownOrProtected.Count
        } | Format-List
        foreach ($candidate in $result.deleteCandidates) {
            Write-Output "RETENTION_CANDIDATE timestamp=$candidate directory=$candidate reason=outside-retention-tiers"
        }
    }
    exit 0
}
catch {
    Write-Error "Retention failed closed; zero deletions performed: $($_.Exception.Message)"
    exit 1
}
