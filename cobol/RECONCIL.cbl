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
           SELECT REPORT-FILE ASSIGN TO REPORTOUT
               ORGANIZATION IS SEQUENTIAL
               FILE STATUS IS WS-OFS.
       DATA DIVISION.
       FILE SECTION.
       FD TRAN-FILE RECORD CONTAINS 38 CHARACTERS.
       01 TRAN-REC.
          05 TRAN-ID       PIC X(10).
          05 TRAN-ACCOUNT  PIC X(10).
          05 TRAN-AMOUNT   PIC X(9).
          05 TRAN-DATE     PIC X(8).
          05 TRAN-STATUS   PIC X.
       FD SETTLE-FILE RECORD CONTAINS 38 CHARACTERS.
       01 SETTLE-REC.
          05 SETTLE-ID      PIC X(10).
          05 SETTLE-ACCOUNT PIC X(10).
          05 SETTLE-AMOUNT  PIC X(9).
          05 SETTLE-DATE    PIC X(8).
          05 SETTLE-STATUS  PIC X.
       FD REPORT-FILE RECORD CONTAINS 120 CHARACTERS.
       01 REPORT-REC PIC X(120).
       WORKING-STORAGE SECTION.
       01 WS-TFS PIC XX VALUE SPACES.
       01 WS-SFS PIC XX VALUE SPACES.
       01 WS-OFS PIC XX VALUE SPACES.
       01 WS-TEOF PIC X VALUE "N".
       01 WS-SEOF PIC X VALUE "N".
       01 WS-RC PIC 99 VALUE 0.
       01 WS-COUNT-T PIC 9(7) VALUE 0.
       01 WS-COUNT-S PIC 9(7) VALUE 0.
       01 WS-MATCH PIC 9(7) VALUE 0.
       01 WS-MISMATCH PIC 9(7) VALUE 0.
       01 WS-TONLY PIC 9(7) VALUE 0.
       01 WS-SONLY PIC 9(7) VALUE 0.
       01 WS-TA PIC 9(7)V99.
       01 WS-SA PIC 9(7)V99.
       01 WS-RESULT PIC X(24).
       01 WS-LINE PIC X(120).
       PROCEDURE DIVISION.
       MAIN.
           OPEN INPUT TRAN-FILE
           IF WS-TFS NOT = "00"
               DISPLAY "OPEN TRANIN FAILED: " WS-TFS
               MOVE 12 TO WS-RC
               PERFORM FINISH
           END-IF
           OPEN INPUT SETTLE-FILE
           IF WS-SFS NOT = "00"
               DISPLAY "OPEN SETTIN FAILED: " WS-SFS
               MOVE 12 TO WS-RC
               PERFORM FINISH
           END-IF
           OPEN OUTPUT REPORT-FILE
           IF WS-OFS NOT = "00"
               DISPLAY "OPEN REPORTOUT FAILED: " WS-OFS
               MOVE 12 TO WS-RC
               PERFORM FINISH
           END-IF
           PERFORM READ-T
           PERFORM READ-S
           PERFORM UNTIL WS-TEOF = "Y" AND WS-SEOF = "Y"
             EVALUATE TRUE
               WHEN WS-TEOF = "Y"
                 MOVE "MISSING_TRANSACTION" TO WS-RESULT
                 PERFORM WRITE-S-ONLY
                 PERFORM READ-S
               WHEN WS-SEOF = "Y"
                 MOVE "MISSING_SETTLEMENT" TO WS-RESULT
                 PERFORM WRITE-T-ONLY
                 PERFORM READ-T
               WHEN TRAN-ID = SETTLE-ID
                 PERFORM COMPARE-RECORDS
                 PERFORM READ-T
                 PERFORM READ-S
               WHEN TRAN-ID < SETTLE-ID
                 MOVE "MISSING_SETTLEMENT" TO WS-RESULT
                 PERFORM WRITE-T-ONLY
                 PERFORM READ-T
               WHEN OTHER
                 MOVE "MISSING_TRANSACTION" TO WS-RESULT
                 PERFORM WRITE-S-ONLY
                 PERFORM READ-S
             END-EVALUATE
           END-PERFORM
           MOVE SPACES TO REPORT-REC
           STRING "SUMMARY T=" WS-COUNT-T " S=" WS-COUNT-S
             " MATCHED=" WS-MATCH " MISMATCHED=" WS-MISMATCH
             " MISSING_SETTLEMENT=" WS-TONLY
             " MISSING_TRANSACTION=" WS-SONLY
             DELIMITED BY SIZE INTO REPORT-REC
           END-STRING
           WRITE REPORT-REC
           IF WS-OFS NOT = "00"
             DISPLAY "SUMMARY WRITE FAILED: " WS-OFS
             MOVE 12 TO WS-RC
           END-IF
           PERFORM FINISH
           IF WS-RC = 0 AND (WS-MISMATCH > 0 OR WS-TONLY > 0
                                      OR WS-SONLY > 0)
             MOVE 4 TO WS-RC
           END-IF
           MOVE WS-RC TO RETURN-CODE
           GOBACK.
       READ-T.
           READ TRAN-FILE
             AT END MOVE "Y" TO WS-TEOF
             NOT AT END ADD 1 TO WS-COUNT-T
           END-READ
           IF WS-TFS NOT = "00" AND WS-TFS NOT = "10"
             DISPLAY "READ TRANIN FAILED: " WS-TFS
             MOVE 12 TO WS-RC
           END-IF.
       READ-S.
           READ SETTLE-FILE
             AT END MOVE "Y" TO WS-SEOF
             NOT AT END ADD 1 TO WS-COUNT-S
           END-READ
           IF WS-SFS NOT = "00" AND WS-SFS NOT = "10"
             DISPLAY "READ SETTIN FAILED: " WS-SFS
             MOVE 12 TO WS-RC
           END-IF.
       COMPARE-RECORDS.
           IF TRAN-AMOUNT IS NOT NUMERIC OR
              SETTLE-AMOUNT IS NOT NUMERIC
             MOVE "INVALID_AMOUNT" TO WS-RESULT
             MOVE 12 TO WS-RC
           ELSE
             COMPUTE WS-TA = FUNCTION NUMVAL(TRAN-AMOUNT) / 100
             COMPUTE WS-SA = FUNCTION NUMVAL(SETTLE-AMOUNT) / 100
             IF TRAN-ACCOUNT = SETTLE-ACCOUNT AND WS-TA = WS-SA
               MOVE "MATCHED" TO WS-RESULT
               ADD 1 TO WS-MATCH
             ELSE
               MOVE "MISMATCHED" TO WS-RESULT
               ADD 1 TO WS-MISMATCH
             END-IF
           END-IF
           MOVE SPACES TO REPORT-REC
           STRING "ID=" TRAN-ID " RESULT=" WS-RESULT
             " TXN-AMT=" TRAN-AMOUNT " SETTLE-AMT=" SETTLE-AMOUNT
             DELIMITED BY SIZE INTO REPORT-REC
           END-STRING
           WRITE REPORT-REC
           IF WS-OFS NOT = "00"
             DISPLAY "REPORT WRITE FAILED: " WS-OFS
             MOVE 12 TO WS-RC
           END-IF.
       WRITE-T-ONLY.
           ADD 1 TO WS-TONLY
           MOVE SPACES TO REPORT-REC
           STRING "ID=" TRAN-ID " RESULT=" WS-RESULT
             " TXN-AMT=" TRAN-AMOUNT
             DELIMITED BY SIZE INTO REPORT-REC
           END-STRING
           WRITE REPORT-REC
           IF WS-OFS NOT = "00"
             DISPLAY "REPORT WRITE FAILED: " WS-OFS
             MOVE 12 TO WS-RC
           END-IF.
       WRITE-S-ONLY.
           ADD 1 TO WS-SONLY
           MOVE SPACES TO REPORT-REC
           STRING "ID=" SETTLE-ID " RESULT=" WS-RESULT
             " SETTLE-AMT=" SETTLE-AMOUNT
             DELIMITED BY SIZE INTO REPORT-REC
           END-STRING
           WRITE REPORT-REC
           IF WS-OFS NOT = "00"
             DISPLAY "REPORT WRITE FAILED: " WS-OFS
             MOVE 12 TO WS-RC
           END-IF.
       FINISH.
           IF WS-TFS = "00"
             CLOSE TRAN-FILE
             IF WS-TFS NOT = "00"
               DISPLAY "CLOSE TRANIN FAILED: " WS-TFS
               MOVE 12 TO WS-RC
             END-IF
           END-IF
           IF WS-SFS = "00"
             CLOSE SETTLE-FILE
             IF WS-SFS NOT = "00"
               DISPLAY "CLOSE SETTIN FAILED: " WS-SFS
               MOVE 12 TO WS-RC
             END-IF
           END-IF
           IF WS-OFS = "00"
             CLOSE REPORT-FILE
             IF WS-OFS NOT = "00"
               DISPLAY "CLOSE REPORTOUT FAILED: " WS-OFS
               MOVE 12 TO WS-RC
             END-IF
           END-IF.
