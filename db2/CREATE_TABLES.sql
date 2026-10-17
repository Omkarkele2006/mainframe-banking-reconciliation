
-- Mainframe Banking Transaction Reconciliation
-- Db2 result table.
--
-- Before execution:
-- 1. Confirm the correct Db2 subsystem with Om.
-- 2. Confirm the correct schema qualifier.
-- 3. Run this only in the approved project/test schema.
--
-- Input amount format:
-- The input file contains nine digits with two implied decimal places.
-- Example: 000050000 represents 500.00.
-- Store the converted value in DECIMAL(13,2).

CREATE TABLE RECON_RESULTS
(
    TXN_ID          CHAR(10) NOT NULL,
    ACCOUNT_ID      CHAR(10),
    TRAN_AMOUNT     DECIMAL(13,2),
    SETTLE_AMOUNT   DECIMAL(13,2),
    TRAN_DATE       CHAR(8),
    SETTLE_DATE     CHAR(8),
    TRAN_STATUS     CHAR(1),
    SETTLE_STATUS   CHAR(1),
    STATUS          VARCHAR(24) NOT NULL,
    DETAILS         VARCHAR(100),
    RUN_TIMESTAMP   TIMESTAMP NOT NULL
                    WITH DEFAULT CURRENT TIMESTAMP,

    PRIMARY KEY (TXN_ID)
);
