
-- Mainframe Banking Transaction Reconciliation
-- Queries for reviewing reconciliation results.

-- 1. Display all reconciliation results.
SELECT
    TXN_ID,
    ACCOUNT_ID,
    TRAN_AMOUNT,
    SETTLE_AMOUNT,
    STATUS,
    DETAILS
FROM RECON_RESULTS
ORDER BY TXN_ID;


-- 2. Count records for each reconciliation status.
SELECT
    STATUS,
    COUNT(*) AS RECORD_COUNT
FROM RECON_RESULTS
GROUP BY STATUS
ORDER BY STATUS;


-- 3. Display only records requiring investigation.
SELECT
    TXN_ID,
    ACCOUNT_ID,
    TRAN_AMOUNT,
    SETTLE_AMOUNT,
    STATUS,
    DETAILS
FROM RECON_RESULTS
WHERE STATUS <> 'MATCHED'
ORDER BY TXN_ID;
