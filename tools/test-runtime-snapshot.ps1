[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
# PURE SNAPSHOT OBSERVATION: JSON only, no output path or persistence operation.
function Get-SnapshotRelativePath {
    param([string]$RootPath, [string]$FilePath)
    if (-not [IO.Path]::IsPathRooted($RootPath) -or -not [IO.Path]::IsPathRooted($FilePath)) { throw 'Snapshot paths must be absolute' }
    $base = [IO.Path]::GetFullPath($RootPath).TrimEnd([char[]]@('\', '/'))
    $full = [IO.Path]::GetFullPath($FilePath)
    $prefix = $base + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Snapshot file is outside expected root' }
    return $full.Substring($prefix.Length)
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$varRoot = Join-Path $root 'var'
$files = New-Object 'System.Collections.Generic.List[string]'
function Add-SnapshotFiles {
    param([string]$Directory)
    $item = Get-Item -LiteralPath $Directory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Snapshot directory must be ordinary and non-reparse' }
    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Snapshot entry cannot be a reparse path' }
        if ($entry.PSIsContainer) { Add-SnapshotFiles $entry.FullName }
        elseif ($entry -is [IO.FileInfo]) { $files.Add($entry.FullName) }
        else { throw 'Snapshot entry must be ordinary' }
    }
}
function Get-SharedLogHash {
    param([string]$Path)
    $stream = $null; $algorithm = $null
    try {
        $before = Get-Item -LiteralPath $Path -Force
        if ($before.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Shared log cannot be reparse' }
        $length = $before.Length; $written = $before.LastWriteTimeUtc.Ticks
        # Read-only handle; grant sharing to the existing writer, never acquire it.
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite,Delete')
        $algorithm = [Security.Cryptography.SHA256]::Create()
        $first = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
        $stream.Dispose(); $stream = $null
        # Reopen the path for the second hash so rotation is not hidden behind
        # the first handle. Sharing Delete does not obstruct the log writer.
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite,Delete')
        $second = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
        $after = Get-Item -LiteralPath $Path -Force
        if ($first -cne $second -or $stream.Length -ne $length -or $after.Length -ne $length -or $after.LastWriteTimeUtc.Ticks -ne $written -or ($after.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Shared log changed during observation' }
        return $first
    } finally { if ($algorithm) { $algorithm.Dispose() }; if ($stream) { $stream.Dispose() } }
}
Add-SnapshotFiles $varRoot
$files.Sort([StringComparer]::Ordinal)
$rows = @(foreach ($path in $files) {
    $file = Get-Item -LiteralPath $path -Force
    $digest = $null; $failure = $null
    try {
        $relativeLog = Get-SnapshotRelativePath $varRoot $file.FullName
        if ($relativeLog -ceq 'log\livezone\LivezoneMediaMtx.err.log' -or $relativeLog -ceq 'log\livezone\LivezoneMediaMtx.out.log') {
            $digest = Get-SharedLogHash $file.FullName
            $afterHash = Get-Item -LiteralPath $file.FullName -Force
            if ($file.Length -ne $afterHash.Length -or $file.LastWriteTimeUtc.Ticks -ne $afterHash.LastWriteTimeUtc.Ticks) { throw 'Shared log changed since enumeration' }
        } else { $digest = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash }
    }
    catch { $digest = $null; $failure = $_.Exception.Message }
    [pscustomobject]@{path=(Get-SnapshotRelativePath $varRoot $file.FullName);size=$file.Length;lastWriteTime=$file.LastWriteTimeUtc.ToString('o');sha256=$digest;error=$failure}
})
# Preserve Unicode names with an explicit encoding on both Windows PowerShell and PowerShell 7.
$json = ConvertTo-Json -InputObject $rows -Depth 5
$json
