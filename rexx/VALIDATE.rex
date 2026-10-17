/* REXX */
/* Module: VALIDATE.rex */
/* Purpose: Validate transaction and settlement datasets */
/* Expected record length: 38 characters */
/* Mainframe execution must be tested in the target TSO/REXX environment. */

ADDRESS TSO

SAY '========================================'
SAY ' BANKING RECONCILIATION VALIDATION'
SAY '========================================'

/* Dataset names for the current integration test */
TRAN_DSN = 'Z73968.BANK.TXNTEST'
SETT_DSN = 'Z73968.BANK.SETTEST'

EXPECTED_LENGTH = 38
FAIL = 0

CALL CHECK_DATASET TRAN_DSN, 'TRANSACTION'
CALL CHECK_DATASET SETT_DSN, 'SETTLEMENT'

SAY '========================================'

IF FAIL = 1 THEN DO
    SAY 'VALIDATION FAILED'
    EXIT 12
END

SAY 'VALIDATION SUCCESS'
EXIT 0


CHECK_DATASET:
    PARSE ARG DSN, LABEL

    SAY ''
    SAY 'Checking' LABEL 'dataset:' DSN

    /* Check dataset status */
    DSN_STATUS = SYSDSN("'"DSN"'")

    IF DSN_STATUS <> 'OK' THEN DO
        SAY 'FAIL:' LABEL 'dataset missing or inaccessible:' DSN
        SAY 'SYSDSN status:' DSN_STATUS
        FAIL = 1
        RETURN
    END

    SAY 'PASS:' LABEL 'dataset exists.'

    QUEUE_NAME = 'VALQ'

    /* Allocate dataset for reading */
    ADDRESS TSO "ALLOC FI("QUEUE_NAME") DA('"DSN"') SHR REUSE"
    ALLOC_RC = RC

    IF ALLOC_RC <> 0 THEN DO
        SAY 'FAIL:' LABEL 'dataset allocation failed. RC=' ALLOC_RC
        FAIL = 1
        RETURN
    END

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

    /* Attempt to release the allocation */
    ADDRESS TSO "FREE FI("QUEUE_NAME")"
    FREE_RC = RC

    IF FREE_RC <> 0 THEN DO
        SAY 'FAIL:' LABEL 'dataset deallocation failed. RC=' FREE_RC
        FAIL = 1
    END

RETURN