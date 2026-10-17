
# Read This First

## 1. What Is Included

- `cobol/RECONCIL.cbl`: Fixed-format COBOL file-merge and report-generation baseline using 38-byte input records.
- `db2/CREATE_TABLES.sql`: Db2 reconciliation result-table definition.
- `db2/INSERT_TEST_DATA.sql`: Example rows for the four reconciliation outcomes.
- `db2/QUERIES.sql`: Queries for viewing results, counting statuses, and identifying exceptions.

**Important:** This package is not evidence of a successful compilation or execution. The COBOL program must be compiled and tested using the team's target z/OS environment.

## 2. Input Dataset Layout

Both input datasets use the following record format:

- `RECFM=FB`
- `LRECL=38`

| Columns | Field | Format |
|---|---|---|
| 1–10 | `TXN_ID` | 10 characters |
| 11–20 | `ACCOUNT_ID` | 10 characters |
| 21–29 | `AMOUNT` | 9 digits, with two implied decimal places |
| 30–37 | Date | `YYYYMMDD` |
| 38 | Status | One character |

Example: `000050000` represents `500.00`. The COBOL program converts the numeric amount by dividing it by 100.

## 3. Required JCL DD Names

| DD name | Dataset or purpose |
|---|---|
| `TRANIN` | `Z73968.BANK.TXNTEST` |
| `SETTIN` | `Z73968.BANK.SETTEST` |
| `REPORTOUT` | Output report dataset with `RECFM=FB` and `LRECL=120` |

Both input datasets must be sorted in ascending order by columns 1–10 (`TXN_ID`) before running the merge.

The current implementation does not define a duplicate-transaction-ID policy. Confirm the expected behavior with Om before finalizing the implementation.

## 4. Intended Return Codes

| Return code | Intended meaning |
|---|---|
| `0` | Reconciliation completed without exceptions |
| `4` | Reconciliation completed, but mismatches or missing IDs were found |
| `12` | File-handling error or invalid amount |

These are intended return codes and must be verified through actual execution.

## 5. Db2 Integration Status

The current COBOL program generates a report file. It does **not** contain embedded `EXEC SQL` statements to insert reconciliation outcomes into Db2.

The SQL scripts separately define the result table, provide example data, and query reconciliation results.

If the acceptance criteria require the COBOL program itself to write results to Db2, additional integration is required. This includes the appropriate Db2 precompilation, compilation, binding, and execution process in the team's environment.

Do not treat Db2 integration as complete until it has been implemented and tested.

## 6. Before Compilation and Execution

1. Confirm the team's compile JCL procedure, COBOL source-format setting, compiler version, and expected output DD name with Om.
2. Confirm the approved Db2 subsystem and schema qualifier before running SQL scripts.
3. Use approved test datasets. Do not overwrite the shared input datasets.
4. Verify that both input datasets have the required record attributes and sorted keys.
5. Compile the COBOL program and resolve any compiler errors.
6. Execute tests covering:
   - Normal matching records
   - Amount mismatches
   - Transactions without settlements
   - Settlements without transactions
   - Invalid amounts
   - Output-file failures
7. Save the compiler listing, JES/SDSF job output, return codes, and generated report as test evidence.
8. Confirm whether duplicate IDs and direct COBOL-to-Db2 integration are required for acceptance.
