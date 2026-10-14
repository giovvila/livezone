[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputPath, [switch]$CreateOnly)
$ErrorActionPreference = 'Stop'
# EVIDENCE_CAPTURE: explicitly creates/rewrites one file outside runtime var.
# Construction is delegated to the sole canonical pure snapshot implementation.
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$varRoot = Join-Path $root 'var'
if (-not [IO.Path]::IsPathRooted($OutputPath)) { throw 'Snapshot output must be absolute' }
$output = [IO.Path]::GetFullPath($OutputPath)
if ($output.Equals($varRoot, [StringComparison]::OrdinalIgnoreCase) -or $output.StartsWith($varRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Snapshot output cannot be in real var' }
# Preserve NEW-ERA-18 destination containment and reparse-path rejection.
$ancestor = $output
while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
        if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Snapshot output cannot use a reparse path' }
    }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}
$json = & (Join-Path $PSScriptRoot 'test-runtime-snapshot.ps1')
if (-not $?) { throw 'Snapshot observation failed' }
# Legacy callers retain intentional rewrite/truncation semantics. Deployment must
# select CreateOnly explicitly; filename never selects a mode implicitly.
if (-not $CreateOnly) {
    [IO.File]::WriteAllText($output, $json, [Text.UTF8Encoding]::new($false))
} else {
    # Construct the entire UTF-8/no-BOM payload before any destination mutation.
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    $stream = $null
    try {
        # Authoritative race fence: never open an existing target for writing.
        $stream = [IO.File]::Open($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
    } catch {
        if ($null -eq $stream) { throw ('CAPTURE_CREATE_ONLY_OPEN_REJECTED: no overwrite; inspect existing target or open failure. ' + $_.Exception.Message) }
        # A newly-created file may be partial after write/flush/close failure.
        # Retain it; retries must fail CreateNew and require independent review.
        throw ('CAPTURE_PUBLICATION_UNCERTAIN_REVIEW_REQUIRED: retain target; no cleanup or retry overwrite. ' + $_.Exception.Message)
    }
}
