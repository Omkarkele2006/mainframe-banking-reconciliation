# Frontend and backend console

## Current scope

The React/Vite/TypeScript application lives in `client/`; the Express/TypeScript API and Mongoose models live in `server/`. The existing COBOL, JCL, REXX, DFSORT, VSAM, and Db2 files are retained unchanged by this application layer.

The console supports organization metadata, temporary transaction and settlement uploads, basic 38-byte fixed-width contract checks and previews, run request metadata, readiness, run history, run detail, audit records, and run-scoped CSV/PDF exports. Uploaded bytes are staged under `UPLOAD_DIR` with restrictive local permissions and an expiry record; they are not embedded in reports or MongoDB. The API does not calculate reconciliation outcomes or monetary totals. The readiness check uses local Zowe CLI commands against the `zosmf` profile and performs read-only connection and dataset-access checks; it does not upload files or submit jobs.

Run metadata uses explicit states: `RECEIVED`, `READY_FOR_MAINFRAME`, `SUBMITTED`, `RUNNING`, `COMPLETED`, `BUSINESS_EXCEPTION`, `FAILED`, and `NOT_CONFIGURED`. In this phase the adapter is `NotConfiguredMainframeAdapter`. A valid run request is saved as `NOT_CONFIGURED` and returns `MAINFRAME_NOT_CONFIGURED`; no job ID, successful status, reconciliation output, or EOD decision is fabricated. Live execution therefore stays disabled.

MongoDB stores organizations, uploads and expiry metadata, runs, report metadata, and audit events. Start MongoDB locally before starting the API. CORS is allowlisted using `CLIENT_ORIGIN`; Helmet and API rate limiting are enabled. The application supports a server-configured operator session using `APP_OPERATOR_USERNAME` and `APP_OPERATOR_PASSWORD_SCRYPT`; no account is created by default. Audit access and protected actions fail closed without that session. The browser sends no mainframe credentials. The backend invokes the installed Zowe CLI with two fixed read-only command forms: `zowe zosmf check status --zosmf-profile zosmf --rfj` and `zowe zos-files list data-set Z73968.BANK.TXN10K --zosmf-profile zosmf --attributes --rfj`. This test uses the local profile under the Windows account running the API. It does not change job execution readiness. The run adapter remains not configured, and execution remains disabled.

Every `/api` request writes a JSON completion line to the API process terminal with timestamp, request ID (`X-Request-ID`), method, route, duration, outcome, status code, and sanitized failure classification. The same request completion is persisted independently to the MongoDB `auditevents` collection; business actions also retain their operation-specific audit records. If MongoDB audit persistence fails, an `audit.persist_failed` error is printed to the API terminal. New audit events contain no request body, IP address, credentials, or headers. Existing legacy audit fields remain in the schema for compatibility. Events are not automatically deleted by a new retention policy.

The root `.env` is loaded explicitly by the API. Configure an application operator account using the steps in [LIVE_EXECUTION_STATUS.md](LIVE_EXECUTION_STATUS.md#operator-application-session); the password itself is never stored. Without those server-side values, sign-in reports that configuration is unavailable and protected operations and audit access remain denied.

The single application configuration file is the repository-root `.env`, copied from `.env.example`. The API resolves this path explicitly whether started from the root workspace, the `server` workspace, or its compiled `server/dist` entry point. Shell environment variables override `.env` values. A legacy `server/.env` is ignored and is not loaded; move any needed settings to the root `.env` without committing either file. Vite only exposes variables prefixed with `VITE_`, and no mainframe values use that prefix.

## Windows setup

From PowerShell in the repository root:

```powershell
Copy-Item .env.example .env
# Edit .env and set MONGODB_URI to your local MongoDB instance.
npm install
npm run typecheck
npm run lint
npm run build
npm run dev
```

Install a current Node.js LTS release and MongoDB Community Server first. The Vite UI runs at `http://localhost:5173`; Express listens at `http://localhost:4000`. Vite proxies `/api` to Express in development. For separate local terminals use `npm run dev -w server` and `npm run dev -w client`. For a built API use `npm start` after `npm run build`.

`MAX_UPLOAD_BYTES` defaults to 10 MiB per file. `UPLOAD_DIR` defaults to `server/.uploads`. The upload endpoint requires `.txt`; each record must be 38 bytes before the line delimiter, with 10-character alphanumeric transaction ID and account ID fields, a 9-digit amount, an 8-digit date, and a one-character status. Validation reads original bytes, does not rewrite staged bytes, and reports basic structural errors. It does not validate banking business rules, reconcile records, or verify that a date or amount is financially valid.

The sidebar operator profile is a display identity only. It does not authenticate a user or establish a mainframe login. The connection-test response distinguishes unavailable CLI, failed/verified connection, and failed/verified dataset access, with sanitized actionable errors. A successful check does not enable execution.

## API overview

- `GET/POST /api/organizations`: list/create organization metadata.
- `GET /api/readiness`: server-side sanitized integration readiness.
- `GET /api/audit`: paginated audit query with ISO date range, event type, outcome, and request ID filters. Requires existing authenticated actor context; this repository has no auth middleware, so access is denied by default.
- `POST /api/mainframe/connection-test`: read-only Zowe CLI profile and fixed dataset-access checks. It accepts no credentials or request fields and is rate limited to five attempts per 15 minutes per client IP.
- `POST /api/uploads/transaction` and `POST /api/uploads/settlement`: multipart `file` plus `organizationId`; returns upload ID, structural status and preview.
- `GET /api/uploads/:uploadId`: temporary upload status.
- `POST /api/runs`: validated organization, upload IDs, and profile. Not-configured deployments persist a run record and respond with HTTP 503 and `MAINFRAME_NOT_CONFIGURED`.
- `GET /api/runs` and `GET /api/runs/:runId`: paginated/filterable run history and run detail.
- `GET /api/runs/:runId/report`: report metadata; `GET .../export.csv` and `GET .../export.pdf`: per-run exports.
- `GET /api/audit`: paginated audit history.
- `GET /api/health`: API and Mongo connection status.

Financial values, matched/mismatched counts, JES job evidence, step return codes, spool content, and EOD publication decisions remain unavailable until actual output is collected from z/OS and parsed by an approved adapter. Amount formatting uses the record layout's implied two decimal places, but the currency code is not specified by the current contract and is therefore not shown. The amount discrepancy definition must be agreed with the mainframe report contract before displaying calculated comparisons.

The API locates the installed `zowe` executable from the server process PATH (including the standard per-user npm bin directory on Windows), independent of the repository working directory. It starts CLI commands with the Windows user's home directory as the working directory so Zowe resolves that user's profile/secure store. Application code never opens, prints, or exports the Zowe configuration file or secure-profile values; Zowe CLI reads its profile internally to perform the check. TLS verification behavior is controlled by the existing local Zowe profile; the application does not modify it. `ZOWE_CLI_TIMEOUT_MS` (default 45000, allowed 1000–60000) bounds each command. An in-flight readiness check is shared by concurrent API requests rather than starting duplicate CLI calls, and the UI also prevents repeat clicks. Combined subprocess output is capped at 1 MiB.

Prerequisites for testing locally: install Zowe CLI; ensure profile `zosmf` is available to the backend process under the same Windows user account; and verify that profile authentication succeeds. Start the API from the root with `npm run dev -w server`, open **Mainframe readiness**, and choose **Test connection**. The button sends an empty POST; the server runs the fixed read-only status and dataset-attributes checks. Result status and sanitized troubleshooting guidance are shown in the UI and detailed stages are logged in the API terminal. No credentials are requested by the site. A successful test does not enable execution. Keep `MAINFRAME_ENABLED=false` and `MAINFRAME_AUTH_READY=false`. Automated server tests mock subprocess results and do not invoke Zowe or submit jobs.

To verify from the browser, set the server-only endpoint and fixed dataset in root `.env`, restart the API, open **Mainframe readiness**, enter the operator's own credentials, and choose **Test connection**. The check is read-only. Keep `MAINFRAME_ENABLED=false` and `MAINFRAME_AUTH_READY=false`. Automated `npm test -w server` tests use mocked HTTP responses and never submit jobs.
