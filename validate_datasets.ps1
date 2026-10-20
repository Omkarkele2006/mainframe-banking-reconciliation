
$ErrorActionPreference = "Stop"
$script:ValidationFailures = 0

function Test-RecordFile($Path, $ExpectedCount) {
    $ResolvedPath = Join-Path $PSScriptRoot $Path
    if (!(Test-Path $ResolvedPath)) {
        Write-Host "FAIL: File missing - $Path"
        $script:ValidationFailures++
        return
    }

    $records = [System.IO.File]::ReadAllLines($ResolvedPath)
    $badLength = @($records | Where-Object { $_.Length -ne 38 }).Count

    $status = if ($records.Count -eq $ExpectedCount -and $badLength -eq 0) {
        "PASS"
    } else {
        "FAIL"
    }

    Write-Host "$status | $Path | Records: $($records.Count) | Invalid lengths: $badLength"
    if ($status -eq "FAIL") {
        $script:ValidationFailures++
    }
}

Write-Host "`n=== Main datasets ==="
Test-RecordFile "input\transaction\TRANSACTION.txt" 10000
Test-RecordFile "input\settlement\SETTLEMENT.txt" 10000

Write-Host "`n=== Test datasets ==="
Test-RecordFile "test-data\normal\TRANSACTION.txt" 5
Test-RecordFile "test-data\normal\SETTLEMENT.txt" 5
Test-RecordFile "test-data\duplicate\TRANSACTION.txt" 7
Test-RecordFile "test-data\duplicate\SETTLEMENT.txt" 5
Test-RecordFile "test-data\duplicate\EXPECTED_DEDUPED_TRANSACTION.txt" 5
Test-RecordFile "test-data\mismatch\TRANSACTION.txt" 2
Test-RecordFile "test-data\mismatch\SETTLEMENT.txt" 2
Test-RecordFile "test-data\missing\TRANSACTION.txt" 2
Test-RecordFile "test-data\missing\SETTLEMENT.txt" 2
Write-Host "`n=== A1 Evidence Files ==="
Write-Host "sort/SORTCNTL.txt exists: $(Test-Path (Join-Path $PSScriptRoot 'sort\SORTCNTL.txt'))"
Write-Host "A1_TEST_EVIDENCE.md exists: $(Test-Path (Join-Path $PSScriptRoot 'A1_TEST_EVIDENCE.md'))"

if (!(Test-Path (Join-Path $PSScriptRoot 'sort\SORTCNTL.txt'))) {
    $script:ValidationFailures++
}
if (!(Test-Path (Join-Path $PSScriptRoot 'A1_TEST_EVIDENCE.md'))) {
    $script:ValidationFailures++
}

if ($script:ValidationFailures -gt 0) {
    Write-Host "VALIDATION FAILED: $($script:ValidationFailures) check(s) failed."
    exit 1
}

Write-Host "VALIDATION PASSED"
exit 0