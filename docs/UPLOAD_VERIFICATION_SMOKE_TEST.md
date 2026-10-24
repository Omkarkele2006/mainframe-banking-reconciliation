# Controlled mainframe file-transfer verification

## Scope

This is a dedicated upload-verification operation, separate from reconciliation. For two already uploaded and validated files, the backend creates two unique PS datasets, transfers them in Zowe text mode, verifies PS/FB/LRECL=38 attributes, reads the data back, compares every fixed-width record, persists the outcome, and deletes only datasets marked `CREATED` in that operation's MongoDB manifest. It does not submit JCL, sort, load VSAM, run COBOL, perform EOD validation, or publish output.

No mainframe mutation has been performed by unit tests or this implementation. A run qualifier is allocated from cryptographic randomness at preview time. Dataset names use `MAINFRAME_HLQ.<8-character-token>.TXNIN` and `.SETIN`; the actual names are displayed in the UI and are required in the confirmation request. Sequential input allocations use the actual staged byte size, 25% headroom, 3390 track estimates, and one secondary track. The individual upload maximum remains 10 MiB.

## Configuration prerequisite

The documented configuration source is the repository-root `.env`, loaded by the API. Preserve local environment files. The administrator must configure the following server-side values manually for the controlled test and restart the API:

```dotenv
MAINFRAME_ENABLED=true
MAINFRAME_AUTH_READY=true
MAINFRAME_LOCAL_UPLOAD_TLS_RISK_ACCEPTED=true
MAINFRAME_UPLOAD_TEST_REVIEWED=true
MAINFRAME_ENDPOINT=https://<approved-zosmf-host>
MAINFRAME_HLQ=<approved-single-level-HLQ>
MAINFRAME_JOB_CLASS=<approved-job-class>
MAINFRAME_SOURCE_LIBRARY=<approved-source-library-under-HLQ>
MAINFRAME_LOAD_LIBRARY=<approved-load-library-under-HLQ>
ZOWE_CLI_TIMEOUT_MS=15000
```

`MAINFRAME_AUTH_READY=true` is an administrator acknowledgement, not a connection-test side effect. `MAINFRAME_LOCAL_UPLOAD_TLS_RISK_ACCEPTED=true` records explicit acceptance of the existing local Zowe profile's TLS risk for this temporary upload-verification smoke test only. It does not mean certificate validation succeeded, and it does not change the profile. Leave it `false` by default. `MAINFRAME_UPLOAD_TEST_REVIEWED=true` acknowledges that the mainframe owner reviewed the installed CLI's create/upload/download/delete syntax and the fixed-record transfer behavior. Both execution flags must stay `false` unless an administrator deliberately enables this narrowly scoped test. The backend also requires the existing server-configured application operator account and an authenticated session with CSRF protection. No default operator credentials exist.

Run the backend as the same Windows account that owns the `zosmf` Zowe profile, with that account's Zowe directories, secure credential store, and CLI directory inherited through `PATH`. The current local profile uses `reject-unauthorized=false`, so this smoke test does not have verified server-certificate validation. Enabling `MAINFRAME_LOCAL_UPLOAD_TLS_RISK_ACCEPTED` acknowledges that known risk for this upload-verification test only; it does not alter the Zowe profile or relax any additional application security checks. The application does not inspect or print the Zowe config. Never copy profile credentials or passwords into the website, MongoDB, or application logs.

The ordinary reconciliation run API remains blocked by the unconfigured mainframe execution adapter even when these two flags are enabled for this narrow smoke test. A read-only connection test does not set either flag.

## Operator procedure

1. Have the mainframe owner approve the target HLQ, job class, space policy, Zowe permissions, dataset creation/deletion authority, code-page behavior, and the installed Zowe CLI version. Verify the commands in the installed CLI help. For this local smoke test only, explicitly accept the existing profile's `reject-unauthorized=false` risk; the application does not inspect or modify the user's Zowe config.
2. Configure the values above in the local root `.env` or an approved secret/configuration provider; restart the API. Do not change project source or `.env.example` flags.
3. Sign in to the application using the server-configured operator account. In Mainframe Readiness, run the read-only `zosmf` connection and dataset-access test and confirm it reports success.
4. In Upload & Run, select the intended organization and upload the transaction and settlement `.txt` files. Confirm both pass the existing 38-byte validation.
5. Select **Preview transfer test**. Review organization, filenames, sizes, record counts, generated dataset names, and the gate message.
6. Select **Confirm planned transfer test**, inspect both exact names, check the explicit authorization box, and start the test.
7. Follow persisted stage status. Success requires a successful RFJ transfer for each file, exact remote dataset name and PS/FB/38 attributes, matching read-back record counts, and byte-for-byte equality of normalized records. LF/CRLF line separators are treated as record separators; the 38 characters in each record are not trimmed or rewritten.
8. The backend persists verification evidence before cleanup. It deletes only exact dataset names whose create response was accepted and whose manifest state is `CREATED`. A cleanup warning leaves the failed dataset in the operation view; **Retry tracked cleanup** rechecks the exact dataset before deleting. An `UNKNOWN` allocation outcome is not deleted automatically and needs mainframe-owner investigation.

The operation ID, generated qualifier, stage outcomes, dataset attributes, read-back record counts and cleanup states persist in the dedicated MongoDB `UploadVerification` collection. API responses never include server staging paths or file contents. Audit/request logs do not contain credentials or raw file data.

## Fixed Zowe operations

The adapter permits only typed, fixed operations. It does not accept command strings or dataset names from a request. On Windows it invokes the PATH-resolved `zowe` command using `cmd.exe /d /c`, with local paths quoted and dataset names unquoted.

- Dataset existence/attributes: `zos-files list data-set <exact-name> --zosmf-profile zosmf --attributes --rfj`.
- Sequential allocation: `zos-files create data-set-sequential <exact-name> --size <tracks>TRK --secondary-space 1 --record-format FB --record-length 38 --block-size 27968 --attributes --zosmf-profile zosmf --rfj`.
- Upload: `zos-files upload file-to-data-set <approved-staged-path> <exact-name> --zosmf-profile zosmf --rfj`. `--binary` is intentionally omitted so the CLI uses its text/record-aware transfer mode.
- Read-back: `zos-files download data-set <exact-name> --file <server-generated-path> --zosmf-profile zosmf --rfj`, also without binary mode.
- Cleanup: `zos-files delete data-set <exact-name> --for-sure --zosmf-profile zosmf --rfj`.

Zowe's documented CLI command names and options can vary by installed version. The local CLI help invocation could not initialize in the restricted development sandbox because its user-level Zowe log file was inaccessible. Therefore the installed-version mutation command syntax and actual transfer conversion behavior still require a mainframe-owner controlled verification before enabling this test. The official command references are [create data-set-sequential](https://docs.zowe.org/stable/web_help/docs/zowe_zos-files_create_data-set-sequential), [upload file-to-data-set](https://docs.zowe.org/v3.1.x/web_help/docs/zowe_zos-files_upload_file-to-data-set), and [download data-set](https://docs.zowe.org/v1.19.x/web_help/docs/zowe_zos-files_download_data-set).

## Safety and recovery limitations

- No wildcard dataset operation exists in this flow. The only generated qualifiers are eight characters and all target names are validated before CLI invocation.
- Both names are checked before creation. If any already exists, the operation stops without writing.
- Each allocation is persisted as `CREATING` before the CLI call and `CREATED` only after a successful RFJ operation response. A process interruption while creating leaves an `UNKNOWN` state; the application will not infer ownership or delete that dataset.
- A run-time process crash leaves the last persisted stage and manifest for investigation. Do not rerun the operation ID; request a fresh preview only after reconciling any `CREATING`/`UNKNOWN` resource with the mainframe owner.
- Cleanup requires enabled gates and the same operator session. Cleanup failure remains visible and does not convert the transfer result into a clean success.
- There is no reconciliation result, JES job ID, EOD decision, or report in this operation.
