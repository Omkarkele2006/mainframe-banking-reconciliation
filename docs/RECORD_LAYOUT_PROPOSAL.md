# Record Layout — Current Working Specification

Project: Mainframe-Based Banking Transaction Reconciliation and EOD Settlement Validation System
Dataset owner: Atharv Katkar

The project team has approved this layout for current development and testing. The uploaded checklist does not define exact positions, lengths, or numeric representation. Confirm the layout and dataset attributes with the team before shared integration or mainframe execution.

## Proposed fixed-width record: 38 bytes

| Field | Start | Length | End | Format |
|---|---:|---:|---:|---|
| TXN_ID | 1 | 10 | 10 | Alphanumeric, left-justified |
| ACCOUNT_ID | 11 | 10 | 20 | Alphanumeric, left-justified |
| AMOUNT | 21 | 9 | 29 | Digits only; implied 2 decimal places (minor units) |
| TXN_DATE | 30 | 8 | 37 | YYYYMMDD |
| STATUS | 38 | 1 | 38 | S |

Proposed dataset attributes if the team approves fixed-width records: RECFM=FB, LRECL=38.
No header row or field delimiters are used. All data is fictional.

## Proposed DFSORT key
TXN_ID is at positions 1-10:
`SORT FIELDS=(1,10,CH,A)`

Possible duplicate elimination by TXN_ID:
`SUM FIELDS=NONE`

Om and the team must confirm whether this duplicate policy is appropriate, and confirm DD names, dataset names, field positions, amount encoding, date format, and status values before production of the final JCL.
