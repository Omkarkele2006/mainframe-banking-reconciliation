# A1 Dataset and DFSORT Test Evidence

## 1. Main Dataset Validation
- Transaction records: 10,000 — PASS
- Settlement records: 10,000 — PASS
- Record length: 38 characters — PASS
- Transaction and settlement baseline comparison: PASS

## 2. Duplicate Test
- Input transaction records: 7
- Expected deduplicated records: 5
- Expected duplicates removed: 2
- TXN_ID uniqueness: PASS
- TXN_ID ascending order: PASS

## 3. Other Test Scenarios
- Normal: 5 transaction records and 5 settlement records
- Mismatch: same TXN_ID with different amounts
- Missing: transaction-only and settlement-only IDs

## 4. Control Statements
Control file: `SORTCNTL.txt`

- `SORT FIELDS=(1,10,CH,A)`
- `SUM FIELDS=NONE`

## 5. Verification Status
Local dataset and reference-output checks were performed using PowerShell.

Actual DFSORT/JCL execution on z/OS has not yet been verified. The team must confirm the duplicate-handling policy and compare the actual mainframe output with the expected reference output.

### Actual DFSORT Execution — IBM Z Xplore

- **Job name:** DFSORT1
- **Job ID:** JOB02242
- **Input records:** 3
- **Output records:** 2
- **Duplicate records removed:** 1
- **Return code:** 0000 (successful)
- **Sort key:** Positions 1–10, ascending
- **Duplicate handling:** `SUM FIELDS=NONE`
- **Verification:** Confirmed using DFSORT spool statistics and SORTOUT.