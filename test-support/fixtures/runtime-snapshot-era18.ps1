param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
# Read-only inventory. Output MUST be outside real var.
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
if (-not [IO.Path]::IsPathRooted($OutputPath)) { throw 'Snapshot output must be absolute' }
$output = [IO.Path]::GetFullPath($OutputPath)
if ($output.Equals($varRoot, [StringComparison]::OrdinalIgnoreCase) -or $output.StartsWith($varRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Snapshot output cannot be in real var' }
# A lexical outside-var path must not redirect the output into var through a junction.
$ancestor = $output
while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
        if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Snapshot output cannot use a reparse path' }
    }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}
$files = New-Object 'System.Collections.Generic.List[string]'
foreach ($file in Get-ChildItem -LiteralPath $varRoot -Recurse -File -Force) { $files.Add($file.FullName) }
$files.Sort([StringComparer]::Ordinal)
$rows = @(foreach ($path in $files) {
    $file = Get-Item -LiteralPath $path -Force
    $digest = $null; $failure = $null
    try { $digest = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash }
    catch { $failure = $_.Exception.Message }
    [pscustomobject]@{path=(Get-SnapshotRelativePath $varRoot $file.FullName);size=$file.Length;lastWriteTime=$file.LastWriteTimeUtc.ToString('o');sha256=$digest;error=$failure}
})
# Preserve Unicode names with an explicit encoding on both Windows PowerShell and PowerShell 7.
$json = ConvertTo-Json -InputObject $rows -Depth 5
[IO.File]::WriteAllText($output, $json, [Text.UTF8Encoding]::new($false))
