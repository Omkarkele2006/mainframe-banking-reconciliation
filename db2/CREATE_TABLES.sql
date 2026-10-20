-- Mainframe Banking Transaction Reconciliation
-- Db2 result table.
--
-- Before execution:
-- 1. Confirm the correct Db2 subsystem with Om.
-- 2. Confirm the correct schema qualifier.
-- 3. Run only in the approved project/test schema.
--
-- RUN_ID identifies a reconciliation run.
-- TXN_ID identifies a transaction within that run.
-- Embedded SQL is present in RECONCIL.cbl; target precompile, bind, and
-- runtime execution remain pending.

CREATE TABLE RECON_RESULTS
(
    RUN_ID          VARCHAR(32) NOT NULL,
    TXN_ID          CHAR(10) NOT NULL,
    TRAN_ACCOUNT_ID CHAR(10),
    SETTLE_ACCOUNT_ID CHAR(10),
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

    CHECK (STATUS IN ('MATCHED', 'MISMATCHED',
                     'MISSING_SETTLEMENT', 'MISSING_TRANSACTION')),
    PRIMARY KEY (RUN_ID, TXN_ID)
);