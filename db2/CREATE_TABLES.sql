-- Db2 for z/OS starter schema.
-- Confirm schema/authorization and supported syntax with your course environment.
-- Run once in the target schema; DROP statements are intentionally omitted.

CREATE TABLE BANK_TRANSACTION (
    TXN_ID       CHAR(8)       NOT NULL,
    ACCOUNT_ID   CHAR(12),
    AMOUNT       DECIMAL(13,2),
    TXN_DATE     CHAR(8),
    PRIMARY KEY (TXN_ID)
);

CREATE TABLE BANK_SETTLEMENT (
    TXN_ID            CHAR(8)       NOT NULL,
    SETTLEMENT_AMOUNT DECIMAL(13,2),
    SETTLEMENT_DATE   CHAR(8),
    PRIMARY KEY (TXN_ID)
);

CREATE TABLE RECON_RESULTS (
    TXN_ID          CHAR(8)       NOT NULL,
    STATUS          VARCHAR(12)   NOT NULL,
    REASON_CODE     VARCHAR(32),
    TRAN_AMOUNT     DECIMAL(13,2),
    SETTLE_AMOUNT   DECIMAL(13,2),
    PROCESSED_AT    TIMESTAMP     NOT NULL DEFAULT CURRENT TIMESTAMP
);

CREATE INDEX IX_RECON_RESULTS_STATUS
    ON RECON_RESULTS (STATUS);
