       IDENTIFICATION DIVISION.
       PROGRAM-ID. RECONCIL.

       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT TRAN-FILE ASSIGN TO TRANIN
               ORGANIZATION IS SEQUENTIAL
               FILE STATUS IS WS-TFS.
           SELECT SETTLE-FILE ASSIGN TO SETTIN
               ORGANIZATION IS SEQUENTIAL
               FILE STATUS IS WS-SFS.
           SELECT MATCH-FILE ASSIGN TO MATCHOUT
               ORGANIZATION IS SEQUENTIAL
               FILE STATUS IS WS-MFS.
           SELECT MISMATCH-FILE ASSIGN TO MISMOUT
               ORGANIZATION IS SEQUENTIAL
               FILE STATUS IS WS-MISFS.
           SELECT TXNMISS-FILE ASSIGN TO TXNMISS
               ORGANIZATION IS SEQUENTIAL
               FILE STATUS IS WS-TMFS.
           SELECT SETMISS-FILE ASSIGN TO SETMISS
               ORGANIZATION IS SEQUENTIAL
               FILE STATUS IS WS-SMFS.

       DATA DIVISION.
       FILE SECTION.
       FD  TRAN-FILE
           RECORD CONTAINS 38 CHARACTERS.
       01  TRAN-REC.
           05 TRAN-ID          PIC X(10).
           05 TRAN-ACCOUNT     PIC X(10).
           05 TRAN-AMOUNT      PIC X(9).
           05 TRAN-DATE        PIC X(8).
           05 TRAN-STATUS      PIC X.

       FD  SETTLE-FILE
           RECORD CONTAINS 38 CHARACTERS.
       01  SETTLE-REC.
           05 SETTLE-ID        PIC X(10).
           05 SETTLE-ACCOUNT   PIC X(10).
           05 SETTLE-AMOUNT    PIC X(9).
           05 SETTLE-DATE      PIC X(8).
           05 SETTLE-STATUS    PIC X.

       FD  MATCH-FILE
           RECORD CONTAINS 38 CHARACTERS.
       01  MATCH-REC           PIC X(38).

       FD  MISMATCH-FILE
           RECORD CONTAINS 120 CHARACTERS.
       01  MISMATCH-REC        PIC X(120).

       FD  TXNMISS-FILE
           RECORD CONTAINS 120 CHARACTERS.
       01  TXNMISS-REC         PIC X(120).

       FD  SETMISS-FILE
           RECORD CONTAINS 120 CHARACTERS.
       01  SETMISS-REC         PIC X(120).

       WORKING-STORAGE SECTION.
       01  WS-TFS              PIC XX VALUE SPACES.
       01  WS-SFS              PIC XX VALUE SPACES.
       01  WS-MFS              PIC XX VALUE SPACES.
       01  WS-MISFS            PIC XX VALUE SPACES.
       01  WS-TMFS             PIC XX VALUE SPACES.
       01  WS-SMFS             PIC XX VALUE SPACES.

       01  WS-T-OPEN           PIC X VALUE "N".
       01  WS-S-OPEN           PIC X VALUE "N".
       01  WS-M-OPEN           PIC X VALUE "N".
       01  WS-MIS-OPEN         PIC X VALUE "N".
       01  WS-TM-OPEN          PIC X VALUE "N".
       01  WS-SM-OPEN          PIC X VALUE "N".

       01  WS-TEOF             PIC X VALUE "N".
       01  WS-SEOF             PIC X VALUE "N".
       01  WS-RC               PIC 99 VALUE 0.

       01  WS-COUNT-T          PIC 9(7) VALUE 0.
       01  WS-COUNT-S          PIC 9(7) VALUE 0.
       01  WS-MATCH            PIC 9(7) VALUE 0.
       01  WS-MISMATCH         PIC 9(7) VALUE 0.
       01  WS-TONLY            PIC 9(7) VALUE 0.
       01  WS-SONLY            PIC 9(7) VALUE 0.

       PROCEDURE DIVISION.
       MAIN.
           OPEN INPUT TRAN-FILE
           IF WS-TFS NOT = "00"
               DISPLAY "OPEN TRANIN FAILED: " WS-TFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           MOVE "Y" TO WS-T-OPEN

           OPEN INPUT SETTLE-FILE
           IF WS-SFS NOT = "00"
               DISPLAY "OPEN SETTIN FAILED: " WS-SFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           MOVE "Y" TO WS-S-OPEN

           OPEN OUTPUT MATCH-FILE
           IF WS-MFS NOT = "00"
               DISPLAY "OPEN MATCHOUT FAILED: " WS-MFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           MOVE "Y" TO WS-M-OPEN

           OPEN OUTPUT MISMATCH-FILE
           IF WS-MISFS NOT = "00"
               DISPLAY "OPEN MISMOUT FAILED: " WS-MISFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           MOVE "Y" TO WS-MIS-OPEN

           OPEN OUTPUT TXNMISS-FILE
           IF WS-TMFS NOT = "00"
               DISPLAY "OPEN TXNMISS FAILED: " WS-TMFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           MOVE "Y" TO WS-TM-OPEN

           OPEN OUTPUT SETMISS-FILE
           IF WS-SMFS NOT = "00"
               DISPLAY "OPEN SETMISS FAILED: " WS-SMFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           MOVE "Y" TO WS-SM-OPEN

           PERFORM READ-T
           PERFORM READ-S

           PERFORM UNTIL WS-TEOF = "Y" AND WS-SEOF = "Y"
               IF WS-RC >= 8
                   EXIT PERFORM
               END-IF
               EVALUATE TRUE
                 WHEN WS-TEOF = "Y"
                   PERFORM WRITE-S-ONLY
                   IF WS-RC < 8
                       PERFORM READ-S
                   END-IF
                 WHEN WS-SEOF = "Y"
                   PERFORM WRITE-T-ONLY
                   IF WS-RC < 8
                       PERFORM READ-T
                   END-IF
                 WHEN TRAN-ID = SETTLE-ID
                   PERFORM COMPARE-RECORDS
                   IF WS-RC < 8
                       PERFORM READ-T
                   END-IF
                   IF WS-RC < 8
                       PERFORM READ-S
                   END-IF
                 WHEN TRAN-ID < SETTLE-ID
                   PERFORM WRITE-T-ONLY
                   IF WS-RC < 8
                       PERFORM READ-T
                   END-IF
                 WHEN OTHER
                   PERFORM WRITE-S-ONLY
                   IF WS-RC < 8
                       PERFORM READ-S
                   END-IF
               END-EVALUATE
           END-PERFORM

           PERFORM CLEANUP

           DISPLAY "TRANSACTION INPUT COUNT: " WS-COUNT-T
           DISPLAY "SETTLEMENT INPUT COUNT:  " WS-COUNT-S
           DISPLAY "MATCHED COUNT:           " WS-MATCH
           DISPLAY "MISMATCHED COUNT:        " WS-MISMATCH
           DISPLAY "TRANSACTION-ONLY COUNT:  " WS-TONLY
           DISPLAY "SETTLEMENT-ONLY COUNT:   " WS-SONLY

           IF WS-RC < 8 AND
               (WS-MISMATCH > 0 OR WS-TONLY > 0 OR WS-SONLY > 0)
               MOVE 4 TO WS-RC
           END-IF
           MOVE WS-RC TO RETURN-CODE
           GOBACK.

       READ-T.
           READ TRAN-FILE
               AT END
                   MOVE "Y" TO WS-TEOF
               NOT AT END
                   IF WS-TFS = "00"
                       ADD 1 TO WS-COUNT-T
                   ELSE
                       DISPLAY "READ TRANIN FAILED: " WS-TFS
                       MOVE 8 TO WS-RC
                   END-IF
           END-READ
           IF WS-TFS NOT = "00" AND WS-TFS NOT = "10"
               DISPLAY "READ TRANIN FAILED: " WS-TFS
               MOVE 8 TO WS-RC
           END-IF.

       READ-S.
           READ SETTLE-FILE
               AT END
                   MOVE "Y" TO WS-SEOF
               NOT AT END
                   IF WS-SFS = "00"
                       ADD 1 TO WS-COUNT-S
                   ELSE
                       DISPLAY "READ SETTIN FAILED: " WS-SFS
                       MOVE 8 TO WS-RC
                   END-IF
           END-READ
           IF WS-SFS NOT = "00" AND WS-SFS NOT = "10"
               DISPLAY "READ SETTIN FAILED: " WS-SFS
               MOVE 8 TO WS-RC
           END-IF.

       CHECK-AMOUNTS.
           IF TRAN-AMOUNT IS NOT NUMERIC
               DISPLAY "INVALID TRANSACTION AMOUNT ID=" TRAN-ID
               MOVE 8 TO WS-RC
           END-IF
           IF SETTLE-AMOUNT IS NOT NUMERIC
               DISPLAY "INVALID SETTLEMENT AMOUNT ID=" SETTLE-ID
               MOVE 8 TO WS-RC
           END-IF.

       COMPARE-RECORDS.
           PERFORM CHECK-AMOUNTS
           IF WS-RC >= 8
               EXIT PARAGRAPH
           END-IF

           IF TRAN-ACCOUNT = SETTLE-ACCOUNT AND
               TRAN-AMOUNT = SETTLE-AMOUNT
               MOVE TRAN-REC TO MATCH-REC
               WRITE MATCH-REC
               IF WS-MFS NOT = "00"
                   DISPLAY "WRITE MATCHOUT FAILED: " WS-MFS
                   MOVE 8 TO WS-RC
               ELSE
                   ADD 1 TO WS-MATCH
               END-IF
           ELSE
               MOVE SPACES TO MISMATCH-REC
               STRING
                   "ID=" TRAN-ID
                   " T-ACCT=" TRAN-ACCOUNT
                   " S-ACCT=" SETTLE-ACCOUNT
                   " T-AMT=" TRAN-AMOUNT
                   " S-AMT=" SETTLE-AMOUNT
                   DELIMITED BY SIZE
                   INTO MISMATCH-REC
               END-STRING
               WRITE MISMATCH-REC
               IF WS-MISFS NOT = "00"
                   DISPLAY "WRITE MISMOUT FAILED: " WS-MISFS
                   MOVE 8 TO WS-RC
               ELSE
                   ADD 1 TO WS-MISMATCH
               END-IF
           END-IF.

       WRITE-T-ONLY.
           IF TRAN-AMOUNT IS NOT NUMERIC
               DISPLAY "INVALID TRANSACTION AMOUNT ID=" TRAN-ID
               MOVE 8 TO WS-RC
               EXIT PARAGRAPH
           END-IF
           MOVE SPACES TO TXNMISS-REC
           STRING "ID=" TRAN-ID
               " STATUS=MISSING_SETTLEMENT"
               DELIMITED BY SIZE INTO TXNMISS-REC
           END-STRING
           WRITE TXNMISS-REC
           IF WS-TMFS NOT = "00"
               DISPLAY "WRITE TXNMISS FAILED: " WS-TMFS
               MOVE 8 TO WS-RC
           ELSE
               ADD 1 TO WS-TONLY
           END-IF.

       WRITE-S-ONLY.
           IF SETTLE-AMOUNT IS NOT NUMERIC
               DISPLAY "INVALID SETTLEMENT AMOUNT ID=" SETTLE-ID
               MOVE 8 TO WS-RC
               EXIT PARAGRAPH
           END-IF
           MOVE SPACES TO SETMISS-REC
           STRING "ID=" SETTLE-ID
               " STATUS=MISSING_TRANSACTION"
               DELIMITED BY SIZE INTO SETMISS-REC
           END-STRING
           WRITE SETMISS-REC
           IF WS-SMFS NOT = "00"
               DISPLAY "WRITE SETMISS FAILED: " WS-SMFS
               MOVE 8 TO WS-RC
           ELSE
               ADD 1 TO WS-SONLY
           END-IF.

       CLEANUP.
           IF WS-T-OPEN = "Y"
               CLOSE TRAN-FILE
               MOVE "N" TO WS-T-OPEN
               IF WS-TFS NOT = "00"
                   DISPLAY "CLOSE TRANIN FAILED: " WS-TFS
                   MOVE 8 TO WS-RC
               END-IF
           END-IF
           IF WS-S-OPEN = "Y"
               CLOSE SETTLE-FILE
               MOVE "N" TO WS-S-OPEN
               IF WS-SFS NOT = "00"
                   DISPLAY "CLOSE SETTIN FAILED: " WS-SFS
                   MOVE 8 TO WS-RC
               END-IF
           END-IF
           IF WS-M-OPEN = "Y"
               CLOSE MATCH-FILE
               MOVE "N" TO WS-M-OPEN
               IF WS-MFS NOT = "00"
                   DISPLAY "CLOSE MATCHOUT FAILED: " WS-MFS
                   MOVE 8 TO WS-RC
               END-IF
           END-IF
           IF WS-MIS-OPEN = "Y"
               CLOSE MISMATCH-FILE
               MOVE "N" TO WS-MIS-OPEN
               IF WS-MISFS NOT = "00"
                   DISPLAY "CLOSE MISMOUT FAILED: " WS-MISFS
                   MOVE 8 TO WS-RC
               END-IF
           END-IF
           IF WS-TM-OPEN = "Y"
               CLOSE TXNMISS-FILE
               MOVE "N" TO WS-TM-OPEN
               IF WS-TMFS NOT = "00"
                   DISPLAY "CLOSE TXNMISS FAILED: " WS-TMFS
                   MOVE 8 TO WS-RC
               END-IF
           END-IF
           IF WS-SM-OPEN = "Y"
               CLOSE SETMISS-FILE
               MOVE "N" TO WS-SM-OPEN
               IF WS-SMFS NOT = "00"
                   DISPLAY "CLOSE SETMISS FAILED: " WS-SMFS
                   MOVE 8 TO WS-RC
               END-IF
           END-IF.
