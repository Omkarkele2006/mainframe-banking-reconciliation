
$ErrorActionPreference = "Stop"

function Test-RecordFile($Path, $ExpectedCount) {
    if (!(Test-Path $Path)) {
        Write-Host "FAIL: File missing - $Path"
        return
    }

    $records = [System.IO.File]::ReadAllLines((Resolve-Path $Path))
    $badLength = @($records | Where-Object { $_.Length -ne 38 }).Count

    $status = if ($records.Count -eq $ExpectedCount -and $badLength -eq 0) {
        "PASS"
    } else {
        "FAIL"
    }

    Write-Host "$status | $Path | Records: $($records.Count) | Invalid lengths: $badLength"
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
Write-Host "SORTCNTL.txt exists: $(Test-Path 'SORTCNTL.txt')"
Write-Host "A1_TEST_EVIDENCE.md exists: $(Test-Path 'A1_TEST_EVIDENCE.md')"