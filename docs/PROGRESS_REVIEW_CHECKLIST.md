# 48-hour Progress Review Checklist

Goal: demonstrate working stages with reproducible evidence. Do not estimate completion from the number of files or mark a stage tested without its JES output.

## Day 1 — freeze interfaces and make the smoke path executable

- [ ] Share `INTEGRATION_CONTRACT.md` with all team members and freeze the 38-byte layout and DD names.
- [ ] Krushna aligns `VALIDATE.rex` to validate `Z73968.BANK.TXNSORT` and `Z73968.BANK.SETSORT`; captures actual TSO/REXX output and RC. Keep VSAM as a separate extension until its reference-record layout, input dataset and real dataset names are defined.
- [ ] Kartik updates COBOL to use `TRANIN`/`SETTIN` and create `MATCHOUT`, `MISMOUT`, `TXNMISS`, and `SETMISS` at the defined record lengths. Add explicit source format and check file-status/SQLCODE/SQLSTATE.
- [ ] Confirm the installed COBOL compile PROC and whether the target system supports the Db2 precompiler/coprocessor, bind and DSN runtime. Record actual PROC/subsystem/plan/library names; don't guess them.
- [ ] Run settlement DFSORT and save the JES output showing 5 input records, 5 output records, RC 0.
- [ ] Compile and run the file-only COBOL stage only after its DD interface matches this contract; save the compiler listing and job output.

## Day 2 — prove success and failure gates

- [ ] Submit updated `MASTER.jcl` against the existing small test datasets after deleting only old intermediate/output datasets.
- [ ] Happy-path evidence: TXNTEST 7 → TXNSORT 5; SETTEST 5 → SETSORT 5; MATCHED 5; all three exception counts 0; final dataset has 5 records; job stages have expected RCs.
- [ ] Negative case using separate test datasets: create at least one amount mismatch or missing ID; verify the proper exception dataset is populated and `FINAL` is not published. Save the output and JES RCs.
- [ ] Db2: execute DDL in the authorized schema, implement embedded SQL in COBOL, run the Db2 build/bind/run flow if access is available, and query for the expected statuses. If subsystem/privileges are unavailable, list this as a blocker—not a completed integration.
- [ ] Only after smoke success, consider loading and processing the 10,000-record profile in distinct datasets. Record actual input/output counts; don't replace the smoke profile's constants blindly.

## What to show the mentor

1. The source record contract and architecture/step flow.
2. A real DFSORT job result (already available for transaction deduplication) and a new settlement-sort result.
3. REXX run output and return code.
4. COBOL compile listing plus generated output datasets and counts.
5. EOD success evidence and a negative-test run where final publishing is blocked.
6. The Db2 schema and embedded-SQL status, with any remaining environment dependency stated plainly.

The progress review should say “implemented and tested” only for items with reproducible output. A planned test or source-only artifact is “implemented, test pending.”
