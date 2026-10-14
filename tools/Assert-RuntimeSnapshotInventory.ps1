# Pure validation only. Dot-sourcing defines the function; no observation or write.
function Assert-RuntimeSnapshotInventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$Rows,
        [Parameter(Mandatory=$true)][string]$ExpectedInventoryPath,
        [Parameter(Mandatory=$true)][string]$ExpectedInventoryHash,
        [int]$ExpectedCount = 492,
        [object[]]$PreviousRows
    )
    $ErrorActionPreference = 'Stop'
    if (-not [IO.Path]::IsPathRooted($ExpectedInventoryPath) -or $ExpectedInventoryHash -cnotmatch '^[a-fA-F0-9]{64}$') { throw 'INVENTORY_EXPLICIT_IDENTITY_REQUIRED' }
    $ancestor = [IO.Path]::GetFullPath($ExpectedInventoryPath)
    while ($ancestor) {
        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'INVENTORY_REPARSE_SOURCE' }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    # Hash and parse the SAME byte capture; never trust an observed/new digest.
    $bytes = [IO.File]::ReadAllBytes($ExpectedInventoryPath)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $actualHash = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '') }
    finally { $algorithm.Dispose() }
    if ($actualHash -ine $ExpectedInventoryHash) { throw 'INVENTORY_SOURCE_HASH_MISMATCH' }
    $baseline = [Text.UTF8Encoding]::new($false,$true).GetString($bytes) | ConvertFrom-Json
    $expected = @($baseline.var)
    if ($expected.Count -ne $ExpectedCount) { throw 'INVENTORY_EXPECTED_COUNT_MISMATCH' }

    function Assert-CanonicalInventoryPath([object]$Value) {
        if ($Value -isnot [string] -or -not $Value -or [IO.Path]::IsPathRooted($Value) -or $Value -match '[/:*?"<>|\x00-\x1f]') { throw 'INVENTORY_NONCANONICAL_PATH' }
        foreach ($part in $Value.Split([char]'\')) {
            if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or $part.EndsWith(' ')) { throw 'INVENTORY_NONCANONICAL_PATH' }
        }
    }
    $expectedOrdinal = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $expectedWindows = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $expected) {
        if ($entry.path -isnot [string] -or -not $entry.path.StartsWith('var\',[StringComparison]::Ordinal)) { throw 'INVENTORY_BASELINE_PREFIX' }
        $relativePath = $entry.path.Substring(4)
        Assert-CanonicalInventoryPath $relativePath
        if (-not $expectedOrdinal.Add($relativePath) -or -not $expectedWindows.Add($relativePath)) { throw 'INVENTORY_EXPECTED_DUPLICATE' }
    }
    foreach ($log in @('log\livezone\LivezoneMediaMtx.err.log','log\livezone\LivezoneMediaMtx.out.log')) {
        if (-not $expectedOrdinal.Contains($log)) { throw 'INVENTORY_EXPECTED_LOG_MISSING' }
    }
    function Assert-InventoryRows([object[]]$Values) {
        if ($Values.Count -ne $ExpectedCount) { throw 'INVENTORY_CAPTURE_COUNT_MISMATCH' }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $exact = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($row in $Values) {
            $fields = @($row.PSObject.Properties.Name)
            if ($fields.Count -ne 5 -or @('path','size','lastWriteTime','sha256','error' | Where-Object { $fields -cnotcontains $_ }).Count) { throw 'INVENTORY_ROW_FIELDS' }
            Assert-CanonicalInventoryPath $row.path
            if (-not $seen.Add($row.path) -or -not $exact.Add($row.path)) { throw 'INVENTORY_CAPTURE_DUPLICATE' }
            if (-not $expectedOrdinal.Contains($row.path)) { throw 'INVENTORY_UNEXPECTED_PATH_OR_ALIAS' }
            if ($null -ne $row.error -or $row.sha256 -isnot [string] -or $row.sha256 -cnotmatch '^[a-fA-F0-9]{64}$') { throw 'INVENTORY_UNREADABLE_OR_INVALID_HASH' }
            if (($row.size -isnot [int] -and $row.size -isnot [long]) -or $row.size -lt 0) { throw 'INVENTORY_INVALID_SIZE' }
            if ($row.lastWriteTime -isnot [string]) { throw 'INVENTORY_INVALID_METADATA' }
            try { [void][DateTime]::ParseExact($row.lastWriteTime,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind) }
            catch { throw 'INVENTORY_INVALID_METADATA' }
        }
        if (-not $exact.SetEquals($expectedOrdinal)) { throw 'INVENTORY_MISSING_PATH' }
    }
    Assert-InventoryRows $Rows
    if ($PSBoundParameters.ContainsKey('PreviousRows')) {
        Assert-InventoryRows $PreviousRows
        # Preserve the existing exact serialized observation/order/value fence.
        if ((ConvertTo-Json -InputObject $Rows -Depth 5) -cne (ConvertTo-Json -InputObject $PreviousRows -Depth 5)) { throw 'INVENTORY_OBSERVATIONS_CHANGED' }
    }
    [pscustomobject]@{status='PASS';expectedCount=$ExpectedCount;capturedCount=$Rows.Count;missing=0;unexpected=0;duplicates=0;errors=0;invalidHashes=0;inventoryHash=$actualHash;stabilityChecked=$PSBoundParameters.ContainsKey('PreviousRows')}
}
