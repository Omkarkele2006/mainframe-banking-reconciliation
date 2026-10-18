# Integration Contract — Banking Reconciliation

Status: working development baseline for the five-record smoke test. This document makes the interfaces explicit; it is not evidence that the full pipeline has passed JES testing.

## 1. Test-data profiles

### Smoke / integration profile (use first)

The currently loaded mainframe datasets are `Z73968.BANK.TXNTEST` and `Z73968.BANK.SETTEST`.

- `TXNTEST`: 7 records, including 2 duplicate transaction rows.
- `TXNSORT`: expected 5 unique transaction IDs after sorting and deduplication.
- `SETTEST`: 5 records.
- `SETSORT`: expected 5 records after sorting; the settlement sort does not remove duplicates.
- Happy-path EOD expectation: 5 matched rows, 0 mismatches, 0 transaction-only rows, 0 settlement-only rows.

These counts belong only to the smoke fixture. They must not be presented as the 10,000-record run.

### Volume profile (later)

The repository contains primary local input files described as 10,000 transaction rows and 10,000 settlement rows. Keep them as the volume/performance profile. After the smoke test passes, load the volume files into separate test datasets, verify the actual record counts and key uniqueness, and create a separate JCL/profile with expectations based on measured results. Do not overwrite `TXNTEST` or `SETTEST`, and do not change the smoke-test constants to 10,000 without changing the source datasets and capturing evidence.

## 2. Input layout — 38 bytes

Both transaction and settlement inputs must be `RECFM=FB,LRECL=38`.

| Positions | Field | Contract |
|---|---|---|
| 1–10 | `TXN_ID` | 10-character alphanumeric key |
| 11–20 | `ACCOUNT_ID` | 10-character alphanumeric value |
| 21–29 | `AMOUNT` | 9 digits, two implied decimal places; e.g. `000050000` = 500.00 |
| 30–37 | `TXN_DATE` | `YYYYMMDD` |
| 38 | `STATUS` | 1 character |

The merge inputs must be in ascending `TXN_ID` order before COBOL runs.

## 3. Stage and dataset interfaces

| Stage | Input | Output / contract |
|---|---|---|
| DFSORT transaction | `Z73968.BANK.TXNTEST` | `Z73968.BANK.TXNSORT`; sort columns 1–10 and deduplicate by that key |
| DFSORT settlement | `Z73968.BANK.SETTEST` | `Z73968.BANK.SETSORT`; sort columns 1–10 and preserve duplicate keys |
| REXX validation | `TXNSORT`, `SETSORT` | Check dataset accessibility, non-empty input and 38-character records; RC 0 pass, nonzero fail. It must validate the sorted datasets used by COBOL, not the unsorted originals. |
| COBOL input DDs | `TRANIN` = `TXNSORT`; `SETTIN` = `SETSORT` | Sorted fixed-width records as above |
| COBOL output DDs | See table below | All four outputs must be created, including empty exception datasets |

### Required COBOL outputs

| DD name | Dataset | Format | Meaning |
|---|---|---|---|
| `MATCHOUT` | `Z73968.BANK.MATCHED` | FB, LRECL 38 | Original transaction record for each matched key whose account ID and amount agree |
| `MISMOUT` | `Z73968.BANK.MISMATCH` | FB, LRECL 120 | One diagnostic record for a shared TXN_ID whose account ID or amount differs |
| `TXNMISS` | `Z73968.BANK.TXNMISS` | FB, LRECL 120 | Transaction exists but no settlement exists (`MISSING_SETTLEMENT`) |
| `SETMISS` | `Z73968.BANK.SETMISS` | FB, LRECL 120 | Settlement exists but no transaction exists (`MISSING_TRANSACTION`) |

For the current scope, a shared `TXN_ID` is `MATCHED` only when `ACCOUNT_ID` and `AMOUNT` agree. Date and one-character status are carried in the source record but are not comparison fields in this baseline. The team must explicitly change this contract if it wants those fields compared.

The transaction fixture has exact duplicate rows and the DFSORT stage deduplicates by TXN_ID. Conflicting rows with the same TXN_ID and duplicate settlement IDs are not covered by the smoke profile. They must be assigned a business rule and tested before claiming general duplicate-handling support.

**COBOL report length check:** `MISMOUT`, `TXNMISS`, and `SETMISS` are `LRECL=120` in this contract. Every assembled exception message must fit within 120 bytes. The current PR source uses a 24-character result plus a 40-character detail in a report assembled from multiple labels and amounts, which can exceed 120 bytes. Before using the 120-byte DDs, shorten the detail field/messages (for example, `WS-DETAIL PIC X(24)` and concise detail literals) or revise the agreed output LRECL in both COBOL and JCL; do not leave potential `STRING` overflow untested.

## 4. Return-code contract

- `0`: reconciliation completed with no mismatches or missing IDs and no technical error.
- `4`: processing completed but business exceptions were found. EOD diagnostics should run; `FINAL` must not be published.
- `8` or higher: technical failure. Do not publish `FINAL`; create an EOD diagnostic marker when the JCL can run the failure branch.
- ICETOOL count checks use RC 8 when a measured count differs from the expected smoke-profile count.

## 5. EOD publication rule

The smoke profile passes only when `TXNSORT=5`, `SETSORT=5`, `MATCHED=5`, `MISMATCH=0`, `TXNMISS=0`, and `SETMISS=0`, and the COBOL step return code is 0. Only then may `IEBGENER` copy `MATCHED` to `Z73968.BANK.FINAL`. A failed step/count must prevent final publication and write `Z73968.BANK.EODERROR` when possible.

The standalone `jcl/eod/EOD_VALIDATION.jcl` assumes COBOL already completed with RC 0 and all four output datasets exist. The integrated `MASTER.jcl` additionally gates later steps on DFSORT, REXX and COBOL return codes.

Before rerunning JCL that allocates outputs with `DISP=(NEW,CATLG,DELETE)`, remove only the named intermediate/output datasets from a prior run. Never delete the source inputs as part of cleanup.

## 6. Db2 scope — required, environment details still to confirm

Embedded SQL in COBOL is part of the project work distribution; separate SQL scripts are useful for schema setup and inspection but are not a substitute for COBOL-to-Db2 inserts/lookups in the final deliverable.

For each unique reconciled TXN_ID, the intended Db2 result statuses are `MATCHED`, `MISMATCHED`, `MISSING_SETTLEMENT`, and `MISSING_TRANSACTION`. The COBOL program must check SQLCODE/SQLSTATE and must not report RC 0 if SQL processing fails.

The repository does not currently prove the following environment-specific details. Do not guess them in runnable JCL:

1. The target COBOL cataloged procedure/compiler version and compile options.
2. The Db2 subsystem ID, plan/package or collection names, Db2 precompiler procedure and required load libraries.
3. Whether the shared environment grants use of the Db2 precompiler, bind and batch DSN runtime.
4. Whether `Z73968.BANK.REXXLIB(VALIDATE)` and `Z73968.BANK.LOAD(RECONCIL)` have been created in the target environment.

IBM commonly documents `IGYWCL` as a compile/link-edit cataloged procedure, but availability and library/version values are installation-dependent. Since the final COBOL source is intended to contain embedded SQL, use the environment's Db2 precompile/build/bind path rather than assuming a non-SQL `IGYWCL` job is the finished build. Confirm the installed procedure and run method from a working course example or the system administrator.

The current `MASTER.jcl` uses `EXEC PGM=RECONCIL` as a file-only integration scaffold. It is not the final runtime invocation for a static embedded-SQL COBOL program. Update that step to the confirmed Db2 batch run method after the subsystem and plan are known.

## 7. Evidence required for the progress review

1. Existing transaction DFSORT evidence: JES output showing 7 input records, 5 output records and RC 0.
2. Settlement sort evidence: 5 input, 5 output, RC 0.
3. REXX execution evidence against `TXNSORT` and `SETSORT`, including return code.
4. COBOL compiler listing and run output, including counts and file/SQL status handling.
5. EOD evidence: six count checks pass, final dataset contains 5 records, and `EODERROR` is absent for the successful smoke run.
6. Negative test: make a mismatch or missing-record fixture active in separate test datasets; show that the appropriate exception file is populated and `FINAL` is not published.
7. Db2 evidence: table DDL executed, embedded-SQL program compiled/precompiled/bound and run, query results showing the expected statuses. Until this is done, mark Db2 integration as pending.

Do not describe a stage as tested based on source code or a local fixture check alone. A JES job ID, RC, relevant SYSOUT and inspected output dataset are the evidence for mainframe execution.
