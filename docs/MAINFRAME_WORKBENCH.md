# Mainframe Workbench operation contract

Dataset Explorer and Jobs & Spool require the authenticated application session. They use the backend process's local Zowe `zosmf` profile. The browser cannot choose an endpoint, provide credentials, or submit a CLI argument list. All write controls are off by default; no configuration changes were made as part of this implementation.

## Dataset Explorer

### Read-only browse

Configure `MAINFRAME_HLQ` and `MAINFRAME_DATASET_READ_SCOPES` in the API environment. The latter is a comma-separated list of masks ending in `.*`; each mask must remain under the configured HLQ. The browser can select only scopes returned by the API. Listing uses the verified `zos-files list data-set <scope> --zosmf-profile zosmf --attributes --rfj` form, and returned resources are checked against the requested mask. Dataset content preview/download accepts only PS/FB with LRECL 38 or 120, validates each downloaded record, and enforces a 2 MiB limit. Temporary downloads are removed after the response completes.

### Supported sequential dataset lifecycle

The current mutation path supports only application-owned sequential PS/FB/LRECL=38 datasets. The API generates `Z73968.Uxxxxxxx.DATA` names; it does not accept a dataset name, allocation arguments, path, endpoint, or command from the browser. The qualifier has eight characters and the complete dataset name is validated. Allocation is fixed at one primary and one secondary track. A successful create is recorded in MongoDB and confirmed by a separate exact-name attribute query before it is shown as created.

Upload and replacement require a record in the authenticated operator's `DatasetOwnership` manifest, a valid `.txt` upload under the existing size cap, and exact PS/FB/LRECL=38 remote attributes. The server validates every 38-byte record, makes a temporary LF-delimited transfer copy, uploads through the typed IBM-1047 Zowe operation, downloads the remote dataset, and compares all records before reporting success. The incoming source bytes are not retained by this workflow. Replacement requires a confirmation dialog and an exact `confirmDataset` value at the API. Delete requires an exact-name prompt, ownership record, attribute verification, typed exact-dataset delete, and a subsequent exact-name absence check.

Each action has a persistent `DatasetOperation` idempotency record. Repeated idempotency keys do not repeat remote actions. If a remote mutation may have partially completed or timed out, the resource becomes `UNCERTAIN` and further write/delete actions are blocked. **Check remote state** performs read-only reconciliation against the saved manifest. It only resolves create when a successful allocation response was persisted and the exact attributes match; it resolves upload/replace only when remote records match the saved count and canonical SHA-256; delete is resolved by exact absence or by confirming the unchanged owned resource is still present. Ambiguous results remain locked for manual review. No automatic cleanup is run.

The API requires all of these server settings before dataset create/upload/replace/delete can run:

- `MAINFRAME_ENABLED=true`
- `MAINFRAME_AUTH_READY=true` (administrator acknowledgment; not inferred from readiness)
- `MAINFRAME_DATASET_MUTATIONS_ENABLED=true`
- `MAINFRAME_DATASET_MUTATIONS_REVIEWED=true`
- `MAINFRAME_LOCAL_UPLOAD_TLS_RISK_ACCEPTED=true` (the configured local profile's TLS risk acceptance; not a claim of certificate validation)
- `MAINFRAME_HLQ=Z73968`
- A configured application operator account/session with CSRF protection
- The Zowe `zosmf` profile available to the API's local process/account

All mutation flags are `false` in `.env.example`. These flags are independent of `MAINFRAME_RECONCILIATION_ENABLED`; opening the dataset gate does not enable reconciliation. This code has not been exercised against z/OS for dataset create, upload, replacement, recovery, download or delete. A manual controlled test must start with one disposable, application-generated dataset and inspect the persisted operation and ownership records. Never use `ZXP.PUBLIC.*` or `Z73968.BANK.*` as write targets.

PDS/PDSE creation/member browse/member upload/member replacement/member deletion are unavailable because the installed CLI syntax and exact RFJ response contract have not been verified in the repository. They are not emulated through shell calls.

## Jobs & spool

The page lists only real JES job IDs already associated with persisted `Run` records. It can refresh actual status and retrieve actual spool, then persists the sanitized spool snapshot in `JobEvidence`; spool download is from that saved evidence. JES OUTPUT is not treated as proof of business success. Existing status/spool code is typed and constrained, but no public submit route is enabled.

`GET /api/mainframe/jobs/submission-readiness` is authenticated and audited. It returns `enabled: false` because the server-side approved-template registry is empty. The CLI has an internal typed local-file submit operation, but this application does not accept arbitrary JCL or expose that operation. The checked-in master/EOD JCL still contains smoke-test assumptions and is not an approved variable-size workbench template. No generic job submission API exists. `MAINFRAME_JOB_SUBMISSION_ENABLED=false` is the default and changing it alone cannot enable submission.

## Reports & History

Existing report routes are tied to persisted run IDs. They show only persisted run/job/spool evidence and do not invent amounts, counts, EOD status, or final publication. `JobEvidence` associates retrieved spool with run ID and JES ID. Reconciliation remains `NOT_CONFIGURED` / HTTP 503; no reconciliation run is submitted by Dataset Explorer or Jobs & Spool.

## Authentication, audit and operational review

State-changing API requests require the application operator session and CSRF token. Dataset and job readiness/history access is authenticated; create/upload/replace/delete, recovery, JES reads and reports are recorded through the server audit path. Operation history exposes only sanitized operation evidence to its owning application actor. Zowe credentials and local profile content are never sent to the browser or stored in these records.

### First controlled dataset smoke test (not run here)

1. Review the local worktree and verify the API runs as the Windows account that owns profile `zosmf`; authenticate to the application.
2. Manually configure the gates above for a supervised, disposable test. Keep `MAINFRAME_RECONCILIATION_ENABLED=false` and `MAINFRAME_JOB_SUBMISSION_ENABLED=false`. Do not change the root `.env` unless that is the operator's separate deliberate action.
3. Open **Dataset Explorer** and confirm the server returns no mutation blockers. Create one PS/FB/LRECL=38 dataset; record the generated exact name from the operation response and Mongo manifest.
4. Upload a small locally prepared valid 38-byte `.txt` file. Confirm `contentMatch=true` and the verified record count in operation history. Replace only after the exact-name confirmation.
5. Delete only that same app-owned dataset using the exact-name prompt. Confirm state `DELETED` and `verifiedAbsent=true`. If any result is `UNCERTAIN`, use **Check remote state**; do not repeat the mutation. Preserve unresolved evidence for a manually reviewed recovery.
6. Confirm no operation references any namespace other than `Z73968` and check the backend audit log. This is not a reconciliation or JES test.

No Zowe command, dataset mutation, job submission, or live test was performed while implementing these changes. All CLI mutation semantics still require a controlled z/OS validation.
