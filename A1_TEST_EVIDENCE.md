
# A1 Dataset and DFSORT Test Evidence

## 1. Main Dataset Validation

- Transaction records: 10,000 — PASS
- Settlement records: 10,000 — PASS
- Record length: 38 characters — PASS
- Transaction and settlement baseline comparison: PASS

## 2. Duplicate Test

- Input transaction records: 7
- Expected deduplicated records: 5
- Expected duplicate keys removed: 2
- TXN_ID uniqueness: PASS
- TXN_ID ascending order: PASS

## 3. Other Test Scenarios

- Normal: 5 transaction records and 5 settlement records
- Mismatch: same TXN_ID with different amounts
- Missing: transaction-only and settlement-only IDs

## 4. Control Statements

Control file: `sort/SORTCNTL.txt`

- `SORT FIELDS=(1,10,CH,A)`
- `SUM FIELDS=NONE`

## 5. Verification Status

Local dataset and reference-output checks were performed using PowerShell. These checks validate the local test files and do not independently prove mainframe execution.

### Historical execution records

The following entries are retained as historical evidence supplied with the
repository. They are not re-executed or independently verified by this source
update; current manual validation must retain the actual JES output.

### Actual DFSORT Execution — IBM Z Xplore

- Job name: DFSORT1
- Job ID: JOB02242
- Input records: 3
- Output records: 2
- Duplicate records removed: 1
- Return code: 0000
- Sort key: positions 1–10, ascending
- Duplicate handling: `SUM FIELDS=NONE`
- Verification: DFSORT spool statistics and SORTOUT inspected.

### Historical project DFSORT execution — z/OS

- Job name: TXNSORT
- Job ID: JOB04859
- Input dataset: `Z73968.BANK.TXNTEST`
- Input records: 7
- Output dataset: `Z73968.BANK.TXNSORT`
- Output records: 5
- Duplicate transaction keys removed: 2
- Sort key: positions 1–10, ascending
- Duplicate handling: `SUM FIELDS=NONE`
- Return code: RC=0000
- Verification: JES2 job log and output dataset inspected in Zowe Explorer.

### Remaining Validation

The complete integrated workflow, including REXX validation, COBOL
reconciliation, Db2 integration, and EOD success/failure scenarios remains
pending current target-environment validation. VSAM is an optional standalone
extension and is not part of the master flow.

The current duplicate-removal policy retains one record per TXN_ID. Duplicate settlement handling and the final integrated workflow must be validated before the project is considered complete.
