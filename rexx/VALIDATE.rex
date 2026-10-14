
/* REXX */
/* Module: VALIDATE.rex */
/* Purpose: Validate transaction and settlement datasets */
/* Expected record length: 38 characters */

ADDRESS TSO

SAY '========================================'
SAY ' BANKING RECONCILIATION VALIDATION'
SAY '========================================'

/* Replace these placeholders with agreed dataset names */
TRAN_DSN = 'YOURID.TRANSACTION'
SETT_DSN = 'YOURID.SETTLEMENT'

EXPECTED_LENGTH = 38
FAIL = 0

/* Validate both input datasets */
CALL CHECK_DATASET TRAN_DSN, 'TRANSACTION'
CALL CHECK_DATASET SETT_DSN, 'SETTLEMENT'

IF FAIL = 1 THEN DO
    SAY '========================================'
    SAY 'VALIDATION FAILED'
    EXIT 12
END

SAY '========================================'
SAY 'VALIDATION SUCCESS'
EXIT 0


CHECK_DATASET:
    PARSE ARG DSN, LABEL

    SAY ''
    SAY 'Checking' LABEL 'dataset:' DSN

    /* Check dataset existence using the LISTDSI REXX function */
    DSI_RC = LISTDSI(DSN)

    IF DSI_RC <> 0 THEN DO
        SAY 'FAIL:' LABEL 'dataset missing or inaccessible:' DSN
        SAY 'LISTDSI return code:' DSI_RC
        FAIL = 1
        RETURN
    END

    SAY 'PASS:' LABEL 'dataset exists.'

    QUEUE_NAME = 'VALQ'

    /* Allocate dataset for reading */
    ADDRESS TSO "ALLOC FI("QUEUE_NAME") DA('"DSN"') SHR REUSE"

    IF RC <> 0 THEN DO
        SAY 'FAIL:' LABEL 'dataset allocation failed. RC=' RC
        FAIL = 1
        RETURN
    END

    /* Initialize record stem */
    DROP REC.
    REC.0 = 0

    /* Read dataset records */
    ADDRESS TSO "EXECIO * DISKR "QUEUE_NAME" (STEM REC. FINIS"
    READ_RC = RC

    IF READ_RC <> 0 THEN DO
        SAY 'FAIL:' LABEL 'dataset read failed. RC=' READ_RC
        FAIL = 1
    END
    ELSE IF REC.0 = 0 THEN DO
        SAY 'FAIL:' LABEL 'dataset is empty.'
        FAIL = 1
    END
    ELSE DO
        BAD = 0

        DO I = 1 TO REC.0
            IF LENGTH(REC.I) <> EXPECTED_LENGTH THEN DO
                SAY 'FAIL:' LABEL 'record' I,
                    'has length' LENGTH(REC.I),
                    '- expected' EXPECTED_LENGTH
                BAD = 1
                LEAVE
            END
        END

        IF BAD = 1 THEN DO
            SAY 'FAIL:' LABEL 'record-length validation failed.'
            FAIL = 1
        END
        ELSE DO
            SAY 'PASS:' LABEL REC.0,
                'records have length' EXPECTED_LENGTH
        END
    END

    /* Release allocation even if reading fails */
    ADDRESS TSO "FREE FI("QUEUE_NAME")"
    FREE_RC = RC

    IF FREE_RC <> 0 THEN DO
        SAY 'FAIL:' LABEL 'dataset deallocation failed. RC=' FREE_RC
        FAIL = 1
    END

RETURN
