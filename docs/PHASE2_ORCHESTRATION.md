# Phase 2 orchestration foundation

## What the repository currently establishes

The deployed workflow is a five-record smoke job, not a run-isolated integration:

- `jcl/master/MASTER.jcl` reads `Z73968.BANK.TXNTEST` and `SETTEST`, writes fixed `TXNSORT`, `SETSORT`, `MATCHED`, `MISMATCH`, `TXNMISS`, `SETMISS`, `FINAL`, and `EODERROR` data sets, and checks literal counts of five/zero.
- Transaction `SUM FIELDS=NONE` removes duplicate transaction IDs, keeping a row for each key. The settlement sort preserves duplicate keys.
- The settlement path loads a unique-key KSDS (`KEYS(10 0)`, `RECORDSIZE(38 38)`). Duplicate settlement IDs therefore cannot be loaded safely.
- `rexx/VALIDATE.rex` hardcodes `Z73968.BANK.TXNSORT` and `Z73968.BANK.SETSORT`; passing a dynamic member argument does not change the datasets it checks.
- `jcl/eod/EOD_VALIDATION.jcl` is also smoke-only and assumes the same fixed datasets and counts.
- `cobol/RECONCIL.cbl` has the expected DD names and emits six count lines. It returns RC 0 for no exceptions, RC 4 for business exceptions and RC 8+ for technical failures. It does not currently report financial totals.

The existing input staging checks records at 38 bytes and writes the original uploaded buffer unchanged. Neither upload nor application-side metadata is used to reconcile records.

## Implemented local foundation

`server/src/executionPlan.ts` creates collision-resistant run IDs and DSN tokens, validates configured names, and builds a run-specific manifest. Every DSN is scoped under the configured HLQ and uses qualifiers within the eight-character limit. It generates fixed allocation, sort/duplicate-preflight, VSAM/COBOL, and EOD JCL. Generated datasets use `DISP=(NEW,CATLG,KEEP)`; generated JCL contains no baseline dataset references or delete steps. The manifest currently uses `RETAIN_PENDING_APPROVAL` for cleanup.

Duplicate policy is recorded explicitly: transaction IDs retain the existing master-job behavior (`SUM FIELDS=NONE`, keep one by key); settlement duplicate keys must fail the preflight before VSAM load. The EOD template accepts only counts parsed from COBOL SYSOUT, checks the actual PS datasets with ICETOOL, gates final publication on RC 0 and matching counts, and writes a run-specific diagnostic marker on a failed gate. Counts are not fixed to the smoke test.

`server/src/validation.ts` owns the byte-level fixed-width check and has focused tests for empty, malformed and valid input. Run IDs created by the API now use 80 bits of random suffix entropy.

## Non-mutating execution-plan preview

After both organization-scoped uploads pass the 38-byte validation, use **Upload & run → Preview execution plan**. The UI calls `POST /api/runs/preview` with only the organization ID, upload IDs and selected profile. The API reloads those records from MongoDB, verifies organization/kind/validity, creates a collision-resistant run ID and dataset token, builds the preview from server-side templates, validates dataset qualifier and JCL statement limits, and returns the plan. It does not persist a Run, read or retransmit staged file bytes, allocate datasets, invoke Zowe, or submit jobs. The uploaded counts shown are validated intake metadata; they are not post-sort/deduplicated reconciliation counts.

Every dataset in the preview is marked `PLANNED_NOT_CREATED`. The cleanup manifest is an exact list of this token's proposed transient names; it authorizes no cleanup. `FINAL` and `EODERROR` are listed as retained candidates. Allocation, upload, run-specific REXX validation, reconciliation and EOD steps are explicitly plan-only or blocked. EOD JCL is intentionally omitted until actual COBOL SYSOUT and physical output counts exist. Generated JCL can be inspected in the browser but has not been submitted or validated on z/OS.

Generated sequential allocations use the uploaded bytes and validated record counts, round to 3390 track units at 56,664 bytes per track, and add 25% headroom. The hard upload maximum is 10 MiB per file (a lower `MAX_UPLOAD_BYTES` setting still applies). Output PS sizing is derived from the relevant input count and output LRECL. The settlement KSDS estimate uses 50% additional space and divides it into nonzero primary and secondary track allocations. These are preview estimates: the mainframe owner must confirm `SYSDA` mapping, SMS/storage policy, block sizing and production capacity before any use.

The generated sort job nests `SETSORT`, `DUPSEL` and `DUPCNT` under `IF` checks of the preceding step's exact RC 0. `DUPCNT` returns RC 8 when duplicate settlement keys are found. The generated VSAM/COBOL job similarly nests `VSAMLOAD` under `VSAMCRT.RC = 0`, and `RECONCIL` under `VSAMLOAD.RC = 0`; an unexpected existing cluster therefore blocks the load. For later separately submitted jobs, the backend gate requires actual JES status `OUTPUT` and RC 0 before progression. That JES polling/orchestration remains a contract helper, not an active execution path while the adapter is disabled.

The preview explicitly surfaces these implementation gaps: current `MASTER.jcl` and `EOD_VALIDATION.jcl` use shared fixed datasets and literal five-record assumptions; `VALIDATE.rex` reads fixed shared sort datasets rather than runtime names; the generated reconciliation template does not yet invoke a dynamic REXX validation step; VSAM and JCL behavior need target-system verification; and COBOL currently emits counts/field mismatches but no financial totals. The transaction deduplication behavior remains `SUM FIELDS=NONE`; settlement duplicates remain present for a pre-load failure gate. No financial amount is inferred from record counts.

## Live execution remains disabled

`MAINFRAME_ENABLED=false` and `MAINFRAME_AUTH_READY=false` remain required. `NotConfiguredMainframeAdapter` is still the only adapter. The generated JCL is a tested local template, not a claim of target-system syntax or behavior verification. It is not submitted by the API.

Before connecting the remaining orchestration stages, the mainframe owner must review and deploy run-parameterized REXX validation (or approve an equivalent validated stage), verify the ICETOOL duplicate-selection syntax and generated JCL on the target, confirm available storage/space policy, and approve Zowe upload/submission/JES APIs and authorization. The existing REXX member must not be assumed to accept runtime datasets. The eventual application must persist actual submission/job/step/spool/count evidence before marking a run complete.

No cleanup is currently issued. Future cleanup must use the exact created-dataset manifest, run only after verified report persistence, and retain failed-run diagnostics. Never clean up baseline datasets, shared libraries, or an untracked dataset.

## First controlled-test sequence after review

Do not enable live execution to try this template. First deploy and review the run-parameterized REXX member and generated JCL in a non-production test environment. With the reviewed adapter still disabled, use the test suite to inspect templates. A later authorized test should:

1. Select two operator-supplied files and a test organization; confirm both are non-empty and every record is 38 bytes.
2. Create a run in the application only after an administrator has reviewed and enabled the server-side execution gate. The application-generated dataset names have the form `HLQ.<8-character collision-resistant token>.{TXNIN,SETIN,TXNSORT,SETSORT,DUPES,SETTLE,...}`; the actual names must come from that run's persisted manifest, never be copied from this example.
3. Confirm all generated names are absent before any allocation. Allocate only that run's inputs, then transfer the exact staged bytes. Check transfer record/byte evidence.
4. Submit preflight and inspect its JES evidence. Stop on any non-zero RC or settlement duplicates. Do not run VSAM load or COBOL on a failed preflight.
5. Submit the reviewed reconciliation JCL, inspect the actual job/step RCs and the six COBOL counts, then submit the generated EOD gate using those verified values. Confirm no run is complete unless output counts agree and the mainframe EOD evidence permits publication.
6. Persist the report and manifest before cleanup. For the initial test, retain every dataset and spool result. Cleanup has no approved command or retention rule yet; no datasets may be deleted during this initial test.

The current API has no enabled submission operation, so there is intentionally no command for an operator to use to start a live run yet. Do not bypass the readiness gate or manually submit an unreviewed generated job.
