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