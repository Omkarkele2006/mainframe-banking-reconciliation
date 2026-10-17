# Dataset Guide

## Primary input files
- `input/transaction/TRANSACTION.txt`: 10,000 records.
- `input/settlement/SETTLEMENT.txt`: 10,000 records.
- The primary files mirror one another so the baseline has 10,000 matching TXN_ID values and amounts.

## Scenario datasets
- `test-data/normal/`: 5 matched pairs for a quick successful test.
- `test-data/duplicate/`: 7 transaction rows with 2 exact duplicate rows; settlement has 5 rows.
- `test-data/mismatch/`: same TXN_ID with different amount in settlement data.
- `test-data/missing/`: one transaction-only TXN_ID and one settlement-only TXN_ID.

## Compatibility notes

These files use the current working 38-byte fixed-width record layout documented in `docs/RECORD_LAYOUT_PROPOSAL.md`, with `TXN_ID` at positions 1–10.

The primary datasets contain fictional test data. Before shared integration or mainframe execution, confirm the layout, dataset attributes, and duplicate-handling policy with the team.

If approved for mainframe use, the proposed dataset attributes are `RECFM=FB` and `LRECL=38`. The files have no header row or field delimiters.

## Invalid-record REXX test

`test-data/INVALID_RECORD_TEST.txt` contains a 37-character record. The local PowerShell check verifies the fixture length only and does not demonstrate that `VALIDATE.rex` rejects the record.

For the mainframe test, use an approved input method that preserves the record's actual 37-character length. Do not assume that loading the record into a dataset defined as `RECFM=FB,LRECL=38` will preserve the short length, because it may be padded to 38 bytes.

Run the validator against the test input and record the observed output and return code. If the test input is padded, use a different approved test method. Mark the test as pending until actual rejection has been observed.