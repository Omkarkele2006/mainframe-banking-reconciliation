# Mainframe-Based Banking Transaction Reconciliation and EOD Settlement Validation System

## Technology
- IBM Z / z/OS
- JCL
- DFSORT
- REXX
- COBOL
- VSAM KSDS (settlement input for the current file-based flow)
- Db2 (deferred persistence integration)
- TSO/ISPF
- JES/SDSF
- React, Vite, TypeScript, Tailwind CSS, Express, MongoDB/Mongoose (operations console foundation)

## Ledgerline console

React/TypeScript (`client/`) and Express/MongoDB (`server/`) operate z/OS through the backend account's Zowe `zosmf` profile. Sign in with the server-configured operator account; mainframe credentials never pass through the browser.

- Upload & Run: organization-scoped 38-byte inputs, isolated transfer verification, then run-scoped sort/duplicate preflight and VSAM/COBOL reconciliation.
- Reports & History: persisted JES jobs, six verified counts, authenticated downloads and EOD Settlement. ICETOOL validates counts; IEBGENER writes a report that is read back before confirming SETTLED/HOLD.
- Dataset Explorer and Jobs & Spool use constrained backend operations. Existing configuration gates remain authoritative. Final publication and automated reconciliation cleanup are not implemented.

Windows: `npm install`, configure the root `.env` from `.env.example` without committing secrets, then `npm run dev`. See [setup instructions](docs/FRONTEND_AND_BACKEND.md) for MongoDB and operator setup. Restart the API after configuration changes.

Generate fictional local 10K inputs with `npx tsx server/scripts/generate-demo-inputs.ts` (refuses overwrites). Each live test requires a fresh run. Positive acceptance: 10,000 matches and SETTLED; negative acceptance: 9,990 matches, 10 amount discrepancies, no missing records, verified RC 4 and HOLD. Count checks passing does not make discrepancies safe to settle.

The operator reports positive live evidence: `REC-20261029-B0353681A828EED7FAC7`, JOB01613/JOB01623/JOB01688, report `Z73968.XMLT36U5.EODRPT`, 10,000 matches and SETTLED. This historical run must not be rerun. The negative 10K acceptance path is offline-tested; live validation remains pending. New reports focus on record integrity; legacy reports retain their original format for verification. No aggregate monetary calculation or unsupported processing date is claimed.

Before committing: `npm test --workspace server`, `npm test --workspace client`, `npm run typecheck`, `npm run lint`, `git diff --check`.

## Team
- Om Karkele – JCL, DFSORT, EOD, Integration
- Kartik Mandhane – COBOL, Db2
- Atharv Katkar – PS datasets, DFSORT, Test Data
- Krushna Kodgirwar – REXX, VSAM

## Processing Flow
Input PS
→ DFSORT
→ REXX
→ VSAM KSDS reload
→ COBOL
→ Reconciliation Output
→ EOD Validation
→ Final Output

The current demo is file-based: `TRANIN` reads the sorted PS dataset
`Z73968.BANK.TXNSORT`, and `SETTIN` reads the already-defined
`Z73968.BANK.RECON.REF.KSDS` VSAM KSDS after it is reloaded from
`Z73968.BANK.SETSORT`. The Db2 schema and SQL scripts remain in the repository
as deferred work because the required database permissions are not available.
No embedded-SQL integration or end-to-end target execution is claimed.
