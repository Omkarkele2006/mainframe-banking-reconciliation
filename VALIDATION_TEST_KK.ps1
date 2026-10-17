# Local Pre-Validation for Banking Reconciliation
# Author: Krushna Kodgirwar
# IMPORTANT: This script checks local files only.
# It does NOT execute VALIDATE.rex or test mainframe datasets.

$ErrorActionPreference = "Stop"
$expectedLength = 38
$failed = $false
$root = $PSScriptRoot

Write-Host "========================================"
Write-Host " BANKING RECONCILIATION LOCAL PRE-VALIDATION"
Write-Host "========================================"
Write-Host "Project directory: $root"
Write-Host "Expected record length: $expectedLength"
Write-Host "NOTE: Mainframe REXX execution is not tested here."

# TEST 1 and 2: Validate local transaction and settlement files
$files = @(
    [PSCustomObject]@{
        Label = "TRANSACTION"
        Path  = Join-Path $root "input/transaction/TRANSACTION.txt"
    },
    [PSCustomObject]@{
        Label = "SETTLEMENT"
        Path  = Join-Path $root "input/settlement/SETTLEMENT.txt"
    }
)

foreach ($item in $files) {
    Write-Host "`nChecking $($item.Label): $($item.Path)"

    if (-not (Test-Path -LiteralPath $item.Path -PathType Leaf)) {
        Write-Host "FAIL: File does not exist."
        $failed = $true
        continue
    }

    $recordCount = 0
    $fileFailed = $false
    $lineNumber = 0

    foreach ($line in [System.IO.File]::ReadLines($item.Path)) {
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
        Write-Host "PASS: $recordCount records; all have $expectedLength characters."
    }
}

# TEST 3: Check that the local invalid-record fixture is malformed.
# This checks the fixture only; it does not prove that REXX rejects it.
Write-Host "`nChecking invalid-record test fixture..."

$invalidFile = Join-Path $root "test-data/INVALID_RECORD_TEST.txt"

if (-not (Test-Path -LiteralPath $invalidFile -PathType Leaf)) {
    Write-Host "FAIL: Invalid-record test file not found."
    $failed = $true
} else {
    $invalidLines = [System.IO.File]::ReadAllLines($invalidFile)

    if ($invalidLines.Count -ne 1) {
        Write-Host "FAIL: Expected exactly one test record."
        $failed = $true
    } else {
        $record = $invalidLines[0]

        if ([string]::IsNullOrWhiteSpace($record)) {
            Write-Host "FAIL: Invalid test record is blank."
            $failed = $true
        } elseif ($record.Length -eq $expectedLength) {
            Write-Host "FAIL: Fixture has $expectedLength characters; it is not an invalid-length case."
            $failed = $true
        } else {
            Write-Host "PASS: Fixture has $($record.Length) characters; expected $expectedLength."
            Write-Host "NOTE: Actual REXX rejection must be tested on the mainframe."
        }
    }
}

# TEST 4: Missing-file detection
Write-Host "`nChecking missing-file condition..."

$missingFile = Join-Path $root "test-data/missing/DOES_NOT_EXIST.txt"

if (-not (Test-Path -LiteralPath $missingFile -PathType Leaf)) {
    Write-Host "PASS: Missing-file condition detected."
} else {
    Write-Host "FAIL: Expected missing test file to be absent."
    $failed = $true
}

# FINAL RESULT
Write-Host "`n========================================"

if ($failed) {
    Write-Host "LOCAL PRE-VALIDATION FAILED"
    exit 12
} else {
    Write-Host "ALL LOCAL PRE-VALIDATION CHECKS PASSED"
    Write-Host "Mainframe REXX testing remains pending."
    exit 0
}
