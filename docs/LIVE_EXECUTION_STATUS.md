# Live execution status and prerequisites

## Safety state

The documented `.env` source is the repository-root `.env`; the server loads that file by an absolute path derived from the repository directory. Do not replace either local `.env` file. The checked-in `.env.example` keeps both `MAINFRAME_ENABLED=false` and `MAINFRAME_AUTH_READY=false`.

The application has the read-only Zowe `zosmf` profile check, typed command construction for constrained operations, run-scoped plan persistence, staged-input SHA-256 integrity checks, and a separate persisted upload-verification smoke-test path. The smoke test can allocate two run-specific sequential datasets, transfer files, verify remote attributes and read-back contents, and clean only manifest-confirmed test datasets after its administrator gates are deliberately enabled. Its mutation commands and record/code-page behavior have not been tested against the installed CLI or target mainframe. **The full reconciliation run worker is still not implemented.** `MAINFRAME_ENABLED` and `MAINFRAME_AUTH_READY` remain false until an administrator deliberately enables the scoped test after review.

No connection test enables execution. A successful connection/read-only dataset check is only evidence for that check at that time.

## Operator application session

Audit viewing and privileged operations require the server-configured operator session. No default user or password is created. The API explicitly loads the repository-root `.env`; keep that local file private and do not replace it. Configure the username and hash there (or in the server's protected environment):

```powershell
node server/scripts/hash-operator-password.mjs
```

In PowerShell, from the repository root:

1. Open the existing root `.env` in a local editor. Set `APP_OPERATOR_USERNAME` to an operator name you choose; do not use an example/default account.
2. Run `node server/scripts/hash-operator-password.mjs` in an interactive PowerShell terminal. Enter a unique password of 12–1024 characters when prompted; input is hidden. The helper prints only a salted scrypt hash.
3. Copy the entire printed `APP_OPERATOR_PASSWORD_SCRYPT=scrypt$...` line into the root `.env`. Do not put the plaintext password in `.env`, a command argument, source control, or a support message. Keep the `.env` file private.
4. Restart the API (stop its current process, then run `npm run dev -w server`, or restart the workspace with `npm run dev`). The API reads the root `.env` at startup.
5. In Ledgerline, choose **Sign in**, enter the configured username and the original password, and submit. The password is sent only to the application sign-in endpoint; it is not a Zowe password. A successful sign-in creates the application session. Sign out or restart the API to end it.

The password is read without terminal echo and is not written to MongoDB, browser storage, cookies, or logs. The server keeps opaque session state in memory, issues an HttpOnly/SameSite=Strict cookie, and requires a session-bound CSRF token on state-changing authenticated routes. Production cookies are Secure and production must use HTTPS. Restarting the API invalidates sessions. If either setting is missing/invalid, the UI explains that server-side authentication setup is required and does not create default credentials.

The configured application username is an application actor only. It does not authenticate the displayed ZID to z/OS.

## Mainframe configuration when integration is reviewed

The backend must run under the Windows account that owns the local Zowe `zosmf` profile, with the correct inherited `PATH` and trusted certificate configuration. Zowe profile credentials stay in Zowe's secure local profile. Never paste them into the website or `.env`.

The administrator-reviewed server configuration must include:

- `MAINFRAME_ENABLED=false` until live execution has been reviewed and authorized.
- `MAINFRAME_AUTH_READY=false` until the administrator explicitly acknowledges the existing profile's authorization readiness.
- `MAINFRAME_HLQ`, `MAINFRAME_JOB_CLASS`, `MAINFRAME_SOURCE_LIBRARY`, and `MAINFRAME_LOAD_LIBRARY` matching the authorized environment.
- `ZOWE_CLI_TIMEOUT_MS` within 1000–60000 ms (default 45000) and a `zosmf` profile available to the API's Windows account.
- The local upload-verification smoke test requires `MAINFRAME_LOCAL_UPLOAD_TLS_RISK_ACCEPTED=true` to explicitly acknowledge the existing local `zosmf` profile's TLS risk; this does not assert successful certificate validation or change that profile. This flag does not authorize ordinary reconciliation/job execution.
- `APP_OPERATOR_USERNAME`, `APP_OPERATOR_PASSWORD_SCRYPT`, and `APP_SESSION_TTL_SECONDS` for privileged application actions.

The endpoint and credential material are not exposed to the browser. Do not set `MAINFRAME_AUTH_READY=true` based solely on a successful read-only test. Do not set the execution flags in this code change.

## Outstanding implementation and owner review

The CLI mutation commands still require validation against the installed Zowe CLI version and target z/OSMF. No file has been transferred, no dataset allocated or deleted, no JCL submitted, and no JES output retrieved during this work. In particular, the application must not treat command construction or RFJ envelope parsing as proof that an operation works on this system.

Before a controlled run, the mainframe owner must review and approve:

1. The upload encoding and FB record behavior, including record count verification after transfer.
2. `DISP=NEW` allocation and collision/recovery behavior under the authorized HLQ and storage policy.
3. Run-parameterized validation, the ICETOOL duplicate policy, VSAM creation/load, and every generated JCL statement on the target system.
4. JES status, spool retrieval and COBOL count parsing against real job output.
5. The dynamic EOD check and final dataset publication rules.
6. Retention and exact-manifest cleanup, including VSAM cluster deletion.

The current `rexx/VALIDATE.rex`, `jcl/master/MASTER.jcl` and `jcl/eod/EOD_VALIDATION.jcl` contain shared smoke-test dataset names or five-record assumptions and must not be run as a variable-size application workflow. The deployed COBOL compares transaction ID, account ID and amount, carries date/status but does not compare those fields, and does not emit financial totals. Any matched amount aggregate must only be derived after retrieving and verifying actual `MATCHOUT` records.

Until each dependency is implemented and verified, API readiness must report execution unavailable and live run requests must fail closed without creating a false success state.
