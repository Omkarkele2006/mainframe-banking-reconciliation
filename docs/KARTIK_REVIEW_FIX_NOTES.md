# Kartik Review Fix Notes

## 1. What Is Included

- `cobol/RECONCIL.cbl`: Fixed-format COBOL reconciliation baseline that merges sorted transaction and settlement records.
- `db2/CREATE_TABLES.sql`: Db2 reconciliation result-table definition.
- `db2/INSERT_TEST_DATA.sql`: Illustrative rows for the four reconciliation outcomes.
- `db2/QUERIES.sql`: Queries for reviewing results, counting statuses, and identifying exceptions.

**Implementation status:** The COBOL source preserves the file interfaces and
now contains embedded SQL inserts and commit/error handling. Successful
precompile, compilation, binding, execution, and Db2 verification have not
been performed in this workspace. Site-specific build/runtime details remain
pending; see `db2/BUILD_RUN_TEMPLATE.md`.

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
| `SETTIN` | Sorted settlement input (`SETSORT`) |

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

The embedded-SQL path converts validated amounts by dividing the nine-digit
integer by 100 before the `DECIMAL(13,2)` insert. Absent transaction or
settlement values use nullable host-variable indicators.

## 6. Db2 Schema and Integration Status

The Db2 SQL scripts define a reconciliation result table, illustrative expected-result rows, and queries for reviewing stored results. The result-table design uses `RUN_ID` together with `TXN_ID` as a composite key so the same transaction ID can be retained across separate reconciliation runs.

Embedded SQL is implemented in `RECONCIL.cbl`, but source presence does not
demonstrate a successful target build or Db2 write. The SQL scripts define the
same result schema and remain manual setup/query assets.

Db2 stores `TRAN_ACCOUNT_ID` and `SETTLE_ACCOUNT_ID` independently so an
account mismatch remains diagnosable. Transaction-only and settlement-only
rows set the absent-side account, amount, date, and status indicators to
NULL. Output files are closed before commit; technical failures attempt a
rollback and return RC 8 or higher.

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
9. Embedded SQL and Db2 build/runtime integration are completed and verified separately.

No successful compilation, execution, or end-to-end Db2 validation is claimed by these notes.