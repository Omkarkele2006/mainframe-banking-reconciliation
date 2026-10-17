//SETSORT  JOB ,MSGLEVEL=(2,0),CLASS=7
//* Sort settlement records by TXN_ID; preserve duplicate keys for review.
//SORTSTEP EXEC PGM=SORT
//SYSOUT   DD SYSOUT=*
//SORTIN   DD DSN=Z73968.BANK.SETTEST,DISP=SHR
//SORTOUT  DD DSN=Z73968.BANK.SETSORT,
//            DISP=(NEW,CATLG,DELETE),
//            SPACE=(TRK,(1,1)),
//            UNIT=SYSDA,
//            DCB=(RECFM=FB,LRECL=38,BLKSIZE=0)
//SYSIN    DD *
  SORT FIELDS=(1,10,CH,A)
/*
