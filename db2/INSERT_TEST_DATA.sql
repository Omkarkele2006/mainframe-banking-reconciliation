-- Mainframe Banking Transaction Reconciliation
-- Illustrative expected results for one sample run.
-- These inserts do not execute the COBOL reconciliation program.
-- Execute only in the approved project/test schema.
-- RUN_ID is a sample identifier; use a distinct value per run.

INSERT INTO RECON_RESULTS
    (RUN_ID, TXN_ID, ACCOUNT_ID, TRAN_AMOUNT,
     SETTLE_AMOUNT, STATUS, DETAILS)
VALUES
    ('RUN20261019A', 'TXN0000001', 'ACCT000001',
     500.00, 500.00, 'MATCHED',
     'Equal account and amount');

INSERT INTO RECON_RESULTS
    (RUN_ID, TXN_ID, ACCOUNT_ID, TRAN_AMOUNT,
     SETTLE_AMOUNT, STATUS, DETAILS)
VALUES
    ('RUN20261019A', 'TXN0000002', 'ACCT000002',
     750.00, 700.00, 'MISMATCHED',
     'Amount differs');

INSERT INTO RECON_RESULTS
    (RUN_ID, TXN_ID, ACCOUNT_ID, TRAN_AMOUNT,
     SETTLE_AMOUNT, STATUS, DETAILS)
VALUES
    ('RUN20261019A', 'TXN0000003', 'ACCT000003',
     125.00, NULL, 'MISSING_SETTLEMENT',
     'Transaction only');

INSERT INTO RECON_RESULTS
    (RUN_ID, TXN_ID, ACCOUNT_ID, TRAN_AMOUNT,
     SETTLE_AMOUNT, STATUS, DETAILS)
VALUES
    ('RUN20261019A', 'TXN0000004', 'ACCT000004',
     NULL, 125.00, 'MISSING_TRANSACTION',
     'Settlement only');