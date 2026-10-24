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

## Web console (foundation)

The console is in `client/` and the API is in `server/`. See [docs/FRONTEND_AND_BACKEND.md](docs/FRONTEND_AND_BACKEND.md) for Windows setup, API routes, and limitations. The UI supports organization metadata, temporary fixed-width file uploads, run history, details, and report exports. Mainframe execution is intentionally not configured: no reconciliation or settlement is performed in the web application, and run requests never fabricate a JES job or successful result. See [docs/MAINFRAME_INTEGRATION_NEXT_STEPS.md](docs/MAINFRAME_INTEGRATION_NEXT_STEPS.md) for the z/OS integration contract.

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
