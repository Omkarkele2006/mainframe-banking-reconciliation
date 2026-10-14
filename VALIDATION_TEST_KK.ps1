
# Local Validation for Banking Reconciliation
# Author: Krushna Kodgirwar

$ErrorActionPreference = "Stop"
$expectedLength = 38
$failed = $false

Write-Host "========================================"
Write-Host " BANKING RECONCILIATION VALIDATION"
Write-Host "========================================"

# TEST 1 and 2: Validate transaction and settlement inputs
$files = @(
    "input/transaction/TRANSACTION.txt",
    "input/settlement/SETTLEMENT.txt"
)

foreach ($file in $files) {
    Write-Host "`nChecking: $file"

    if (-not (Test-Path $file -PathType Leaf)) {
        Write-Host "FAIL: File does not exist."
        $failed = $true
        continue
    }

    $recordCount = 0
    $fileFailed = $false
    $lineNumber = 0

    foreach ($line in [System.IO.File]::ReadLines(
        (Resolve-Path $file).Path
    )) {
        $lineNumber++
        $recordCount++

        if ([string]::IsNullOrWhiteSpace($line)) {
            Write-Host "FAIL: Record $lineNumber is blank."
            $fileFailed = $true
            break
        }

        if ($line.Length -ne $expectedLength) {
            Write-Host "FAIL: Record $lineNumber has length $($line.Length); expected $expectedLength."
            $fileFailed = $true
            break
        }
    }

    if ($recordCount -eq 0) {
        Write-Host "FAIL: File contains no records."
        $fileFailed = $true
    }

    if ($fileFailed) {
        $failed = $true
    } else {
        Write-Host "PASS: $recordCount records; all records have $expectedLength characters."
    }
}

# TEST 3: Invalid record length
Write-Host "`nChecking invalid record..."

$invalidFile = "test-data/INVALID_RECORD_TEST.txt"

if (-not (Test-Path $invalidFile -PathType Leaf)) {
    Write-Host "FAIL: Invalid test file not found."
    $failed = $true
} else {
    $record = (Get-Content $invalidFile -Raw).TrimEnd()

    if ([string]::IsNullOrWhiteSpace($record)) {
        Write-Host "FAIL: Invalid test file is empty."
        $failed = $true
    } elseif ($record.Length -ne $expectedLength) {
        Write-Host "PASS: Invalid record detected. Length: $($record.Length); expected: $expectedLength."
    } else {
        Write-Host "FAIL: Invalid record was not detected."
        $failed = $true
    }
}

# TEST 4: Missing-file detection
Write-Host "`nChecking missing-file detection..."

$missingFile = "test-data/missing/DOES_NOT_EXIST.txt"

if (-not (Test-Path $missingFile -PathType Leaf)) {
    Write-Host "PASS: Missing-file condition detected."
} else {
    Write-Host "FAIL: Expected missing test file to be absent."
    $failed = $true
}

# FINAL RESULT
Write-Host "`n========================================"

if ($failed) {
    Write-Host "VALIDATION FAILED"
    exit 12
} else {
    Write-Host "ALL LOCAL TESTS PASSED"
    exit 0
}
