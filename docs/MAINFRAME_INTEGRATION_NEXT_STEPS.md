# Next steps: real z/OS execution integration

## Current truth

The readiness page invokes the local Zowe CLI under the API process Windows account, using the fixed `zosmf` profile to check z/OSMF status and read attributes for `Z73968.BANK.TXN10K`. The browser sends no mainframe password. This check is read-only and does **not** transfer input to z/OS, allocate datasets, submit JCL, run DFSORT/REXX/VSAM/COBOL/EOD, collect JES output, publish output, or calculate reconciliation. `NotConfiguredMainframeAdapter` still intentionally rejects submission. The API creates a `NOT_CONFIGURED` run record and returns `MAINFRAME_NOT_CONFIGURED`; this must not be presented as a successful mainframe run. A successful connection test never enables execution.

Local prerequisite: Zowe CLI must be installed, `zosmf` must be available to the same Windows user account that runs the backend, and that profile must authenticate. The current local profile's `reject-unauthorized=false` setting is an acknowledged TLS risk for the temporary upload-verification smoke test only when `MAINFRAME_LOCAL_UPLOAD_TLS_RISK_ACCEPTED=true`; this is not evidence of certificate validation and does not enable reconciliation/job execution. The application does not modify the profile. Reassess transport security separately before any broader or production use.

Keep the mainframe workflow and approved baseline datasets in the repository intact. Existing outputs use `DISP=NEW`, and the baseline smoke, 10K, and negative-test datasets must never be overwritten or removed by an application cleanup routine.

## Adapter contract

Implement `MainframeExecutionAdapter` in `server/src/types.ts` and `server/src/mainframe.ts` behind a server-only configuration gate. The current `submit` interface receives an application-generated run ID, staged input paths, and a fixed enumerated test profile. The authorization mechanism for real submissions must be selected with the mainframe administrator; the local CLI profile readiness check alone must not be assumed to authorize submission. The adapter may return a job ID only after z/OS has accepted a real submission.

Before allowing live runs:

1. Confirm the approved z/OSMF endpoint and TLS trust, authorization mechanism, operator permissions, HLQ, job class, source library, load library, and approved JCL templates with the backend administrator. These values are server-side configuration only. No browser-configurable endpoint, arbitrary dataset name, user JCL, password persistence, or secret logging is allowed.
2. Define run-ID-to-dataset mapping with strict validation and collision checks. Allocate run-specific PS inputs and outputs. Preserve source input bytes and `RECFM=FB,LRECL=38`; never pad, trim, or rewrite records. Validate identifier length against the approved HLQ and dataset naming rules.
3. Transfer both user uploads to run-specific datasets. Add explicit transfer integrity evidence (byte/record counts or hashes) and clean up only datasets created for that exact run after the approved retention period. Cleanup must be scoped and idempotent; it must not target baseline smoke, 10K, or negative datasets.
4. Submit a server-owned, reviewed JCL template that runs the existing DFSORT, REXX validation, VSAM reload/load, COBOL reconciliation and EOD checks against the run datasets. User input selects only an enumerated profile. Do not accept free-form JCL or arbitrary dataset overrides.
5. Poll/retrieve actual JES job and step status, return codes, and authorized spool. Distinguish submission, running, business-exception RC, technical failure, and retrieval failure. Retry safely with an idempotency key; never resubmit blindly after an uncertain timeout.
6. Parse a versioned machine-readable report contract emitted by the mainframe. The deployed COBOL currently reports counts and field-level mismatches; it may need controlled changes to emit transaction and settlement amount totals and a discrepancy amount. Do not derive validated amounts from counts or from frontend-side reconciliation.
7. Mark `COMPLETED` or `BUSINESS_EXCEPTION` only from verified actual output. Set EOD publication status only from actual EOD evidence. Publish only when deployed mainframe rules pass. Persist report metadata and parsed run results under the specific run ID; retain raw spool only under the approved access and retention policy.
8. Select and implement an approved backend authorization mechanism for real z/OS runs. The current browser and run-request API do not collect or accept mainframe passwords. Do not reuse the read-only CLI test as proof of run authorization without an explicit security decision.
9. Test in a non-production z/OS environment: clean smoke, mismatch, transaction-only, settlement-only, malformed input, duplicate IDs, upload/transfer failure, authorization denial, unavailable endpoint, job timeout, JES retrieval failure, output parsing failure, and repeat submission. Capture JES job IDs, RCs, SYSOUT and dataset evidence. Test scoped cleanup and ensure all baseline datasets remain unchanged.
10. Enable `MAINFRAME_ENABLED=true` only after connection/auth tests, security review, run isolation, failure handling and EOD gating have passed. Readiness must represent an actual successful connection test, not only the presence of environment values.

## Security and operations

Use HTTPS in production, restrictive CORS, a private network path to z/OSMF, TLS certificate verification, request validation, rate limiting, and an authenticated application session with appropriate CSRF protection if cookie sessions are introduced. Add authorization checks for organization and run access. Store application passwords only with a reviewed password hashing scheme if application login is added. Do not store mainframe credentials in MongoDB, browser storage, cookies, reports, traces, logs or audit details.

Define file retention, staging cleanup, report access, spool access, audit retention, backup, encryption-at-rest, alerting and incident-response policy with the banking administrator. Verify the configuration only through a backend-admin endpoint that returns non-secret booleans and status. Keep endpoint, headers, tokens and library details private to the server.

The API has a server-configured operator session. Audit queries and protected actions fail closed when operator credentials are not configured or no valid session is present. The displayed operator identity and local Zowe profile are not application authentication evidence. Do not expose audit records publicly to make the screen appear functional.

The existing `docs/INTEGRATION_CONTRACT.md` remains the source for current mainframe datasets and the 38-byte record layout. Reconcile any differences in that document with the approved system administrator and mainframe owners before enabling the adapter.
