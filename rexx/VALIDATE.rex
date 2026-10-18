
/* REXX */
/* Module: VALIDATE.rex */
/* Purpose: Validate sorted reconciliation input datasets */
/* Required inputs: TXNSORT and SETSORT */
/* Requirements: Accessible, non-empty, 38-byte records */
/* Return codes: 0 = success, 12 = validation/technical failure */

ADDRESS TSO

SAY '========================================'
SAY ' BANKING RECONCILIATION VALIDATION'
SAY '========================================'

/* Use the actual sorted dataset names for this test environment. */
TRAN_DSN = 'Z73736.TXNSORT'
SETT_DSN = 'Z73736.SETSORT'

EXPECTED_LENGTH = 38
FAIL = 0

CALL CHECK_DATASET TRAN_DSN, 'TRANSACTION'
CALL CHECK_DATASET SETT_DSN, 'SETTLEMENT'

SAY '========================================'

IF FAIL <> 0 THEN DO
    SAY 'VALIDATION FAILED'
    SAY 'RETURN CODE: 12'
    EXIT 12
END

SAY 'VALIDATION SUCCESS'
SAY 'RETURN CODE: 0'
EXIT 0


CHECK_DATASET:
    PARSE ARG DSN, LABEL

    SAY ''
    SAY 'Checking' LABEL 'dataset:' DSN

    /* Check whether the dataset is cataloged and accessible. */
    DSN_STATUS = SYSDSN("'"DSN"'")

    IF DSN_STATUS <> 'OK' THEN DO
        SAY 'FAIL:' LABEL 'dataset missing or inaccessible.'
        SAY 'SYSDSN status:' DSN_STATUS
        FAIL = 1
        RETURN
    END

    SAY 'PASS:' LABEL 'dataset is accessible.'

    QUEUE_NAME = 'VALQ'

    /* Allocate the dataset for shared reading. */
    ADDRESS TSO "ALLOC FI("QUEUE_NAME") DA('"DSN"') SHR REUSE"
    ALLOC_RC = RC

    IF ALLOC_RC <> 0 THEN DO
        SAY 'FAIL:' LABEL 'allocation failed. RC=' ALLOC_RC
        FAIL = 1
        RETURN
    END

    DROP REC.
    REC.0 = 0

    /* Read all records and close the input allocation. */
    ADDRESS TSO "EXECIO * DISKR "QUEUE_NAME" (STEM REC. FINIS"
    READ_RC = RC

    IF READ_RC <> 0 THEN DO
        SAY 'FAIL:' LABEL 'read failed. RC=' READ_RC
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

    /* Release the allocation and report any failure. */
    ADDRESS TSO "FREE FI("QUEUE_NAME")"
    FREE_RC = RC

    IF FREE_RC <> 0 THEN DO
        SAY 'FAIL:' LABEL 'deallocation failed. RC=' FREE_RC
        FAIL = 1
    END

RETURN
