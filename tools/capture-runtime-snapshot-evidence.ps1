[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputPath)
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
# Identical logical fields and UTF-8/no-BOM export; no new namespace durability claim.
[IO.File]::WriteAllText($output, $json, [Text.UTF8Encoding]::new($false))
