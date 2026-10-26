# Reconciliation execution status

## Current state

The application has a separate, read-only execution-plan preview and a separate mainframe file-transfer verification operation. The transfer verification creates two temporary sequential datasets, uploads the test inputs, reads them back for content comparison, and cleans only its own manifest. It does not submit JCL and its datasets are not retained for reconciliation.

The reconciliation workflow remains **disabled and not target-validated**. This revision adds an injectable multi-stage orchestration service, a typed fixed-operation Zowe/JES adapter, MongoDB persistence mapping, isolated JCL contract checks and offline tests. These components are not production-wired: the active `MainframeExecutionAdapter` remains `NotConfiguredMainframeAdapter`, and `POST /api/runs` continues to persist `NOT_CONFIGURED`, return HTTP 503 and submit no job. This boundary is intentional because generated JCL, JES response/spool parsing, VSAM allocation and output contracts have not been verified through a real z/OS job. A read-only readiness check cannot enable execution.

### Latest read-only connectivity diagnostic

The earlier reported `CONNECTION_FAILED / CLI_ERROR` was not reproducible during this implementation session. A direct read-only invocation in the backend process successfully ran the fixed profile status and test-dataset attribute checks. Therefore the cause of the earlier failure is **not established**; this observation does not prove that the website route, job permissions, upload permissions or execution path are currently available. No credentials, configuration contents or raw CLI output are recorded here.

## Assigned development namespace

The project operator has assigned `Z73968` as the personal development/test HLQ. Run-specific project-owned datasets must be named beneath `Z73968.*`; the execution-plan builder and reconciliation configuration gate now reject other HLQs. Do not write, allocate, upload, publish, or clean up under `ZXP.PUBLIC.*`. Existing `Z73968.BANK.*` smoke datasets and shared `Z73968.SOURCE` / `Z73968.LOAD` libraries are not run-owned and must not be overwritten or deleted. The source/load libraries may only be referenced read-only where the actual job requires them.

This namespace decision permits implementation work without treating a blanket owner sign-off as a prerequisite. It does not prove that the current Zowe identity can perform every operation. Actual permission and target behavior must be established with the existing safe checks and, later, explicitly authorized run-scoped tests. A denied operation is a real environment limitation; it must not trigger fallback to a public namespace.

## Rules established by repository sources

- A record is 38 bytes: transaction/settlement ID bytes 1–10, account bytes 11–20, amount bytes 21–29, date bytes 30–37, status byte 38. Inputs must be nonempty; the application validates the file structure only.
- `SORTCNTL.txt` and the existing master JCL use a transaction sort on bytes 1–10 with `SUM FIELDS=NONE` (keep the first transaction record for a duplicate key). Settlement sorting preserves duplicate keys; duplicate settlement keys must stop processing before loading a unique-key KSDS.
- `RECONCIL.cbl` uses `TRANIN` sequential and `SETTIN` indexed KSDS with the 10-byte record key at offset zero. Output DDs are `MATCHOUT` PS/FB/38 and `MISMOUT`, `TXNMISS`, `SETMISS` PS/FB/120.
- The COBOL merge pairs records by ID. For paired IDs it checks account and amount; it does not compare date/status or calculate financial totals. The program displays six record counts, returns RC 0 for no business differences, RC 4 when mismatches or missing records exist, and RC 8 or higher for technical errors.
- The existing `MASTER.jcl`, `EOD_VALIDATION.jcl`, `VSAM_CREATE.jcl`, and `VSAM_LOAD.jcl` refer to shared smoke-test datasets and/or fixed five-record expectations. They are not safe templates for arbitrary uploads. `VSAM_LOAD.jcl` includes a REPRO replacement pattern against a shared cluster and must not be used by this application.
- `VALIDATE.rex` hardcodes `Z73968.BANK.TXNSORT` and `Z73968.BANK.SETSORT`. It cannot validate run-specific datasets without a reviewed parameterized member or an approved equivalent. The current orchestration skips this member and uses remote read-back plus generated output checks; whether that alternative provides sufficient target-side validation remains unresolved. Generated JCL has not been submitted to z/OS.

## Execution controls

The new `MAINFRAME_RECONCILIATION_ENABLED` setting is independent of the existing file-transfer-verification gates and defaults to `false`. A separate `MAINFRAME_RECONCILIATION_TLS_RISK_ACCEPTED` administrator acknowledgment is required for a local Zowe profile with relaxed certificate verification; it does not change TLS behavior. The app also requires `MAINFRAME_ENABLED=true`, `MAINFRAME_AUTH_READY=true`, valid server-only HTTPS endpoint/HLQ/job class/library settings, and a configured complete orchestration adapter. The adapter is currently not configured, and the readiness API explicitly reports live reconciliation as disabled.

Do not change any execution setting to true to test this code. Before a controlled live test, resolve the specific technical and authorization prerequisites below; seek mainframe-owner input for site restrictions or behavior not established by repository source, rather than treating sign-off as a blanket prerequisite for local implementation:

1. Provide a run-specific validation member or approve a verified equivalent; do not overwrite the shared `Z73968.SOURCE(VALIDATE)` member.
2. Review and test the generated allocation, DFSORT/ICETOOL, VSAM, COBOL, and dynamic EOD JCL on a non-production system. Confirm space units/SMS policy, VSAM attributes, JCL return-code interpretation and output count evidence.
3. Confirm Zowe CLI permissions for run-scoped allocation, IBM-1047 text transfer, JCL submission, bounded JES status/spool retrieval, output download and exact-manifest cleanup. Confirm the local Zowe profile's TLS posture. No certificate checks are changed by this app.
4. Validate run-specific JCL and actual job/spool/output response shapes on a controlled target; resolve the run-specific validation step; review persisted recovery, report access and cleanup; then connect the adapter to the API behind all execution gates. The current orchestration is dependency-injected and tested with mocks only; it does not call transfer-verification cleanup.
5. Keep `MAINFRAME_RECONCILIATION_ENABLED=false` until a complete path has been target-validated, reviewed and deployed. Any later live test must be an explicit operator action using disposable run resources under `Z73968.*`.

The repository gate expects `MAINFRAME_HLQ=Z73968` and the source/load library names beneath that HLQ. This does not authorize any operation. In this revision the API hard-blocks run requests because its active adapter is unconfigured; setting flags cannot enable a live action. No dataset or job should be created using this documentation alone.

## Verification boundary

The successful file-transfer verification operation reported by the operator demonstrates input transfer and read-back only. It is not evidence that run-specific sort, duplicate preflight, VSAM, COBOL, EOD, publication, JES orchestration or cleanup works. Local orchestration tests use mocked Zowe operations, representative JES responses and generated JCL. They verify state/persistence contracts and static namespace/DD/RC constraints, not z/OS syntax or operational correctness. No reconciliation job, output count, report or cleanup has been verified on z/OS.
