# Read this first

## What is included
- `cobol/RECONCIL.cbl`: a fixed-format COBOL file-merge/report baseline using 38-byte records.
- `db2/*.sql`: corrected Db2 schema and example SQL.
- This pack is not evidence of a successful compile/run. Compile on the team's target z/OS compiler.

## Input layout (both datasets)
FB, LRECL=38:
- 1-10 TXN_ID
- 11-20 ACCOUNT_ID
- 21-29 AMOUNT (nine digits; cents implied)
- 30-37 date YYYYMMDD
- 38 one-character status

Example: `000050000` means 500.00; the COBOL program divides the numeric amount by 100.

## JCL DD names needed by this COBOL program
- TRANIN -> Z73968.BANK.TXNTEST
- SETTIN -> Z73968.BANK.SETTEST
- REPORTOUT -> output dataset, FB with LRECL=120

Both inputs must be sorted ascending by columns 1-10 (TXN_ID). This merge does not implement a duplicate-ID policy; ask Om what the project expects for duplicates.

## Return codes intended
- 0 = no exceptions
- 4 = ran but mismatches/missing IDs exist
- 12 = file or invalid amount error

## Db2 limitation
The COBOL program currently writes a report file; it does not contain embedded `EXEC SQL` statements to insert reconciliation outcomes into Db2. The SQL files define a result table and provide queries/test rows separately. If Om's acceptance criteria require the COBOL program itself to write Db2 rows, that integration still needs to be added and compiled with the team's Db2 precompiler/bind process. Do not claim embedded SQL is finished.

## Before use
1. Confirm Om's compile JCL procedure, source format setting, and the exact expected output DD name.
2. Confirm the Db2 schema qualifier and subsystem with Om.
3. Use test data only; do not overwrite the shared input datasets.
4. Compile and run normal, mismatch, missing-record, invalid-amount, and output-failure tests. Save JES/SDSF output and report output.
