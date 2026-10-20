# Mainframe-Based Banking Transaction Reconciliation and EOD Settlement Validation System

## Technology
- IBM Z / z/OS
- JCL
- DFSORT
- REXX
- COBOL
- Db2 (planned persistence integration)
- VSAM (optional standalone extension; not in the master flow)
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
→ COBOL
→ Db2
→ Reconciliation Output
→ EOD Validation
→ Final Output

The source interfaces and Db2 SQL path are implemented for manual
target-environment validation. Local fixtures and historical evidence are not
claims of current z/OS, Db2, or end-to-end execution. Complete the
site-specific Db2 build/run template before using the embedded-SQL path.