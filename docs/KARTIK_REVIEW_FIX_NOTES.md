# Kartik Review Fix Notes

## 1. What Is Included

- `cobol/RECONCIL.cbl`: Fixed-format COBOL reconciliation baseline that merges sorted transaction and settlement records.
- `db2/CREATE_TABLES.sql`: Db2 reconciliation result-table definition.
- `db2/INSERT_TEST_DATA.sql`: Illustrative rows for the four reconciliation outcomes.
- `db2/QUERIES.sql`: Queries for reviewing results, counting statuses, and identifying exceptions.

**Implementation status:** The COBOL source is now file-based and reads the
settlement input from the VSAM KSDS. Successful compilation, execution, and
end-to-end verification have not been performed in this workspace. Db2 schema
and SQL scripts remain deferred because table creation currently fails with
SQLCODE -551; see `db2/BUILD_RUN_TEMPLATE.md` for future integration work.

## 2. Input Record Layout

Both input datasets use:

- `RECFM=FB`
- `LRECL=38`

| Columns | Field | Format |
|---|---|---|
| 1–10 | `TXN_ID` | 10 characters |
| 11–20 | `ACCOUNT_ID` | 10 characters in each input record |
| 21–29 | `AMOUNT` | 9 numeric digits with two implied decimal places |
| 30–37 | Date | `YYYYMMDD` |
| 38 | Status | One character |

Example: `000050000` represents `500.00`.

The reconciliation comparison validates and compares the fixed-width amount
strings. The Db2 write path separately converts the nine-digit amount to a
`DECIMAL(13,2)` host value. Date and status are not comparison fields in the
current reconciliation scope.

Both input datasets must be sorted in ascending order by `TXN_ID` before the merge.

## 3. Required Input and Output Files

### Input DD names

| DD name | Purpose |
|---|---|
| `TRANIN` | Sorted transaction input (`TXNSORT`) |
| `SETTIN` | Settlement VSAM KSDS reloaded from `SETSORT` |

### Output DD names

| DD name | Purpose | Record format |
|---|---|---|
| `MATCHOUT` | Matched transaction records | `FB`, `LRECL=38` |
| `MISMOUT` | Account/amount mismatch diagnostics | `FB`, `LRECL=120` |
| `TXNMISS` | Transactions without settlements | `FB`, `LRECL=120` |
| `SETMISS` | Settlements without transactions | `FB`, `LRECL=120` |

The four output datasets must be allocated with the corresponding record lengths. Empty exception outputs must still be created when required by the job setup.

Duplicate transaction records are expected to be removed by the upstream sorting/deduplication step. Conflicting duplicate IDs and duplicate settlements remain outside the current defined scope and require an agreed business rule.

## 4. Return Codes

| Return code | Meaning |
|---|---|
| `0` | Reconciliation completed without business exceptions |
| `4` | Reconciliation completed with business exceptions |
| `8+` | Technical failure, such as a file-processing error |

These are the intended return-code meanings in the current implementation. They have not yet been confirmed by a successful target-environment execution.

## 5. Amount Handling

The input amount is represented as nine numeric characters with two implied decimal places. For example, `000050000` represents `500.00`.

The current COBOL program validates that the amount field is numeric and compares the fixed-width amount strings when transaction and settlement IDs match. Because the validated fields have the same fixed width and numeric representation, string equality is used for the comparison.

The file-based path compares validated fixed-width amount strings. Db2 amount
conversion and nullable host-variable behavior are deferred with the SQL
integration.

## 6. Db2 Schema and Integration Status

The Db2 SQL scripts define a reconciliation result table, illustrative expected-result rows, and queries for reviewing stored results. The result-table design uses `RUN_ID` together with `TXN_ID` as a composite key so the same transaction ID can be retained across separate reconciliation runs.

Embedded SQL is not present in the current `RECONCIL.cbl`. The SQL scripts
define deferred schema/setup/query assets and do not demonstrate a successful
target build or Db2 write.

The current file outputs retain the transaction and settlement details needed
for mismatch and missing-record diagnostics. File errors return RC 8 or
higher; business exceptions return RC 4.

The following remain pending:

- Target-environment precompilation, binding, and runtime execution.
- Execution against the team's approved Db2 environment and verification of stored results.

These steps require the target environment and will be handled during the next integration stage.

## 7. Target-Environment Validation

The integration reviewer should verify:

1. Input dataset attributes and ascending transaction-ID ordering.
2. Transaction sorting/deduplication produces the expected five unique transaction IDs from the supplied fixture.
3. Settlement sorting produces the expected five records.
4. The four COBOL output datasets have the required record formats and lengths.
5. The normal fixture produces five matches and no business exceptions.
6. Negative tests produce the expected mismatch or missing-record diagnostics.
7. Return codes and downstream EOD controls behave as specified.
8. Compiler listings, job output, record counts, and exception files are retained as evidence.
9. Db2 permissions, build/runtime integration, and stored-result verification
are completed separately from the current VSAM flow.

No successful compilation, execution, or end-to-end Db2 validation is claimed by these notes.