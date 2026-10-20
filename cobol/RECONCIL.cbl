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
           EXEC SQL
               INCLUDE SQLCA
           END-EXEC.

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

       01  WS-RUN-ID           PIC X(32) VALUE SPACES.
       01  WS-DB2-TXN-ID       PIC X(10) VALUE SPACES.
       01  WS-DB2-STATUS       PIC X(24) VALUE SPACES.
       01  WS-DB2-DETAIL       PIC X(100) VALUE SPACES.
       01  WS-DB2-TACCOUNT     PIC X(10) VALUE SPACES.
       01  WS-DB2-SACCOUNT     PIC X(10) VALUE SPACES.
       01  WS-DB2-TDATE        PIC X(8) VALUE SPACES.
       01  WS-DB2-SDATE        PIC X(8) VALUE SPACES.
       01  WS-DB2-TSTATUS      PIC X VALUE SPACE.
       01  WS-DB2-SSTATUS      PIC X VALUE SPACE.
       01  WS-DB2-TAMT         PIC S9(13)V99 COMP-3 VALUE 0.
       01  WS-DB2-SAMT         PIC S9(13)V99 COMP-3 VALUE 0.
       01  WS-T-AMT-NUM        PIC 9(9) VALUE 0.
       01  WS-S-AMT-NUM        PIC 9(9) VALUE 0.
       01  WS-DB2-TAMT-IND     PIC S9(4) COMP VALUE 0.
       01  WS-DB2-SAMT-IND     PIC S9(4) COMP VALUE 0.
       01  WS-DB2-TACCT-IND    PIC S9(4) COMP VALUE 0.
       01  WS-DB2-SACCT-IND    PIC S9(4) COMP VALUE 0.
       01  WS-DB2-TDATE-IND    PIC S9(4) COMP VALUE 0.
       01  WS-DB2-SDATE-IND    PIC S9(4) COMP VALUE 0.
       01  WS-DB2-TSTAT-IND    PIC S9(4) COMP VALUE 0.
       01  WS-DB2-SSTAT-IND    PIC S9(4) COMP VALUE 0.

       PROCEDURE DIVISION.
       MAIN.
           ACCEPT WS-RUN-ID FROM COMMAND-LINE
           IF WS-RUN-ID = SPACES
               DISPLAY "RUN ID IS REQUIRED"
               MOVE 8 TO WS-RC
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           OPEN INPUT TRAN-FILE
           IF WS-TFS NOT = "00"
               DISPLAY "OPEN TRANIN FAILED: " WS-TFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               PERFORM ROLLBACK-DB2
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           MOVE "Y" TO WS-T-OPEN

           OPEN INPUT SETTLE-FILE
           IF WS-SFS NOT = "00"
               DISPLAY "OPEN SETTIN FAILED: " WS-SFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               PERFORM ROLLBACK-DB2
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           MOVE "Y" TO WS-S-OPEN

           OPEN OUTPUT MATCH-FILE
           IF WS-MFS NOT = "00"
               DISPLAY "OPEN MATCHOUT FAILED: " WS-MFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               PERFORM ROLLBACK-DB2
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           MOVE "Y" TO WS-M-OPEN

           OPEN OUTPUT MISMATCH-FILE
           IF WS-MISFS NOT = "00"
               DISPLAY "OPEN MISMOUT FAILED: " WS-MISFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               PERFORM ROLLBACK-DB2
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           MOVE "Y" TO WS-MIS-OPEN

           OPEN OUTPUT TXNMISS-FILE
           IF WS-TMFS NOT = "00"
               DISPLAY "OPEN TXNMISS FAILED: " WS-TMFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               PERFORM ROLLBACK-DB2
               MOVE WS-RC TO RETURN-CODE
               GOBACK
           END-IF
           MOVE "Y" TO WS-TM-OPEN

           OPEN OUTPUT SETMISS-FILE
           IF WS-SMFS NOT = "00"
               DISPLAY "OPEN SETMISS FAILED: " WS-SMFS
               MOVE 8 TO WS-RC
               PERFORM CLEANUP
               PERFORM ROLLBACK-DB2
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
           IF WS-RC >= 8
               PERFORM ROLLBACK-DB2
           ELSE
               PERFORM COMMIT-DB2
           END-IF

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
               IF WS-RC < 8
                   MOVE "MATCHED" TO WS-DB2-STATUS
                   MOVE "Account and amount agree" TO WS-DB2-DETAIL
                   PERFORM PREPARE-BOTH-DB2
                   PERFORM WRITE-DB2
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
                   ON OVERFLOW
                       DISPLAY "MISMATCH MESSAGE TOO LONG"
                       MOVE 8 TO WS-RC
               END-STRING
               WRITE MISMATCH-REC
               IF WS-MISFS NOT = "00"
                   DISPLAY "WRITE MISMOUT FAILED: " WS-MISFS
                   MOVE 8 TO WS-RC
               ELSE
                   ADD 1 TO WS-MISMATCH
               END-IF
               IF WS-RC < 8
                   MOVE "MISMATCHED" TO WS-DB2-STATUS
                   MOVE "Account or amount differs" TO WS-DB2-DETAIL
                   PERFORM PREPARE-BOTH-DB2
                   PERFORM WRITE-DB2
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
               ON OVERFLOW
                   DISPLAY "TXNMISS MESSAGE TOO LONG"
                   MOVE 8 TO WS-RC
           END-STRING
           WRITE TXNMISS-REC
           IF WS-TMFS NOT = "00"
               DISPLAY "WRITE TXNMISS FAILED: " WS-TMFS
               MOVE 8 TO WS-RC
           ELSE
               ADD 1 TO WS-TONLY
           END-IF.
           IF WS-RC < 8
               MOVE "MISSING_SETTLEMENT" TO WS-DB2-STATUS
               MOVE "Transaction has no settlement" TO WS-DB2-DETAIL
               PERFORM PREPARE-TRAN-DB2
               PERFORM WRITE-DB2
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
               ON OVERFLOW
                   DISPLAY "SETMISS MESSAGE TOO LONG"
                   MOVE 8 TO WS-RC
           END-STRING
           WRITE SETMISS-REC
           IF WS-SMFS NOT = "00"
               DISPLAY "WRITE SETMISS FAILED: " WS-SMFS
               MOVE 8 TO WS-RC
           ELSE
               ADD 1 TO WS-SONLY
           END-IF.
           IF WS-RC < 8
               MOVE "MISSING_TRANSACTION" TO WS-DB2-STATUS
               MOVE "Settlement has no transaction" TO WS-DB2-DETAIL
               PERFORM PREPARE-SETTLE-DB2
               PERFORM WRITE-DB2
           END-IF.

       PREPARE-BOTH-DB2.
           MOVE TRAN-ID TO WS-DB2-TXN-ID
           MOVE TRAN-ACCOUNT TO WS-DB2-TACCOUNT
           MOVE SETTLE-ACCOUNT TO WS-DB2-SACCOUNT
           MOVE TRAN-DATE TO WS-DB2-TDATE
           MOVE SETTLE-DATE TO WS-DB2-SDATE
           MOVE TRAN-STATUS TO WS-DB2-TSTATUS
           MOVE SETTLE-STATUS TO WS-DB2-SSTATUS
           MOVE 0 TO WS-DB2-TACCT-IND WS-DB2-SACCT-IND
               WS-DB2-TAMT-IND
               WS-DB2-SAMT-IND WS-DB2-TDATE-IND
               WS-DB2-SDATE-IND WS-DB2-TSTAT-IND
               WS-DB2-SSTAT-IND
           MOVE TRAN-AMOUNT TO WS-T-AMT-NUM
           COMPUTE WS-DB2-TAMT = WS-T-AMT-NUM / 100
           MOVE SETTLE-AMOUNT TO WS-S-AMT-NUM
           COMPUTE WS-DB2-SAMT = WS-S-AMT-NUM / 100.

       PREPARE-TRAN-DB2.
           MOVE TRAN-ID TO WS-DB2-TXN-ID
           MOVE TRAN-ACCOUNT TO WS-DB2-TACCOUNT
           MOVE -1 TO WS-DB2-SACCT-IND
           MOVE TRAN-DATE TO WS-DB2-TDATE
           MOVE TRAN-STATUS TO WS-DB2-TSTATUS
           MOVE -1 TO WS-DB2-SAMT-IND WS-DB2-SDATE-IND
               WS-DB2-SSTAT-IND
           MOVE 0 TO WS-DB2-TACCT-IND WS-DB2-TAMT-IND
               WS-DB2-TDATE-IND WS-DB2-TSTAT-IND
           MOVE TRAN-AMOUNT TO WS-T-AMT-NUM
           COMPUTE WS-DB2-TAMT = WS-T-AMT-NUM / 100.

       PREPARE-SETTLE-DB2.
           MOVE SETTLE-ID TO WS-DB2-TXN-ID
           MOVE SETTLE-ACCOUNT TO WS-DB2-SACCOUNT
           MOVE -1 TO WS-DB2-TACCT-IND
           MOVE SETTLE-DATE TO WS-DB2-SDATE
           MOVE SETTLE-STATUS TO WS-DB2-SSTATUS
           MOVE -1 TO WS-DB2-TAMT-IND WS-DB2-TDATE-IND
               WS-DB2-TSTAT-IND
           MOVE 0 TO WS-DB2-SACCT-IND WS-DB2-SAMT-IND
               WS-DB2-SDATE-IND WS-DB2-SSTAT-IND
           MOVE SETTLE-AMOUNT TO WS-S-AMT-NUM
           COMPUTE WS-DB2-SAMT = WS-S-AMT-NUM / 100.

       WRITE-DB2.
           EXEC SQL
               INSERT INTO RECON_RESULTS
                 (RUN_ID, TXN_ID, TRAN_ACCOUNT_ID,
                  SETTLE_ACCOUNT_ID, TRAN_AMOUNT,
                  SETTLE_AMOUNT, TRAN_DATE, SETTLE_DATE,
                  TRAN_STATUS, SETTLE_STATUS, STATUS, DETAILS)
               VALUES
                 (:WS-RUN-ID, :WS-DB2-TXN-ID,
                  :WS-DB2-TACCOUNT :WS-DB2-TACCT-IND,
                  :WS-DB2-SACCOUNT :WS-DB2-SACCT-IND,
                  :WS-DB2-TAMT :WS-DB2-TAMT-IND,
                  :WS-DB2-SAMT :WS-DB2-SAMT-IND,
                  :WS-DB2-TDATE :WS-DB2-TDATE-IND,
                  :WS-DB2-SDATE :WS-DB2-SDATE-IND,
                  :WS-DB2-TSTATUS :WS-DB2-TSTAT-IND,
                  :WS-DB2-SSTATUS :WS-DB2-SSTAT-IND,
                  :WS-DB2-STATUS, :WS-DB2-DETAIL)
           END-EXEC
           IF SQLCODE NOT = 0
               DISPLAY "DB2 INSERT FAILED SQLCODE=" SQLCODE
                   " SQLSTATE=" SQLSTATE
               MOVE 8 TO WS-RC
           END-IF.

       COMMIT-DB2.
           EXEC SQL
               COMMIT
           END-EXEC
           IF SQLCODE NOT = 0
               DISPLAY "DB2 COMMIT FAILED SQLCODE=" SQLCODE
                   " SQLSTATE=" SQLSTATE
               MOVE 8 TO WS-RC
               PERFORM ROLLBACK-DB2
           END-IF.

       ROLLBACK-DB2.
           EXEC SQL
               ROLLBACK
           END-EXEC
           IF SQLCODE NOT = 0
               DISPLAY "DB2 ROLLBACK FAILED SQLCODE=" SQLCODE
                   " SQLSTATE=" SQLSTATE
               IF WS-RC < 8
                   MOVE 8 TO WS-RC
               END-IF
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
