-- Mainframe Banking Transaction Reconciliation
-- Read-only queries for reviewing reconciliation results.
-- The COBOL source writes these rows after the approved Db2 build/run.
-- Replace <RUN_ID> with the run under investigation; it is not a production
-- default.

-- 1. Display results for a specified run.
-- Replace the sample RUN_ID with the run being reviewed.
SELECT
    RUN_ID,
    TXN_ID,
    TRAN_ACCOUNT_ID,
    SETTLE_ACCOUNT_ID,
    TRAN_AMOUNT,
    SETTLE_AMOUNT,
    STATUS,
    DETAILS
FROM RECON_RESULTS
WHERE RUN_ID = '<RUN_ID>'
ORDER BY TXN_ID;


-- 2. Count results by status for a specified run.
SELECT
    STATUS,
    COUNT(*) AS RECORD_COUNT
FROM RECON_RESULTS
WHERE RUN_ID = '<RUN_ID>'
GROUP BY STATUS
ORDER BY STATUS;


-- 3. Display records requiring investigation for a specified run.
SELECT
    RUN_ID,
    TXN_ID,
    TRAN_ACCOUNT_ID,
    SETTLE_ACCOUNT_ID,
    TRAN_AMOUNT,
    SETTLE_AMOUNT,
    STATUS,
    DETAILS
FROM RECON_RESULTS
WHERE RUN_ID = '<RUN_ID>'
  AND STATUS <> 'MATCHED'
ORDER BY TXN_ID;


-- 4. List available reconciliation runs.
SELECT
    RUN_ID,
    COUNT(*) AS RECORD_COUNT,
    MIN(RUN_TIMESTAMP) AS FIRST_RECORDED,
    MAX(RUN_TIMESTAMP) AS LAST_RECORDED
FROM RECON_RESULTS
GROUP BY RUN_ID
ORDER BY RUN_ID;