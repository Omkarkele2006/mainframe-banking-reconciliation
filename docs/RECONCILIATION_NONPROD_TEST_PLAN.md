# Proposed reconciliation non-production test plan

**Status: proposal only.** Reconciliation remains `NOT_CONFIGURED`; the API returns HTTP 503 and does not submit jobs. This plan does not authorize a live run. No target-system naming, JCL syntax, allocation policy, data behavior, or return-code semantics beyond repository evidence are assumed.

The assigned personal development/test HLQ is `Z73968`. All project-owned processing inputs, scratch data, sort/exception outputs, temporary VSAM resources and any published output must be under `Z73968.*`. `ZXP.PUBLIC.*` is prohibited for all project writes and cleanup. This assignment supports local development without a blanket sign-off prerequisite; it does not imply that the profile has allocate, upload, submit, read-back or delete authority. Test permissions through the application's existing safe, allowlisted checks. If a permission is denied, stop and report the exact denied operation; never change namespace to a public HLQ.

## Goals and evidence boundary

The future controlled test should use operator-supplied transaction and settlement uploads, dedicated owner-approved non-production resources, and the actual deployed mainframe programs. Reconciliation and EOD decisions must be made from real z/OS outputs and JES evidence. Local application checks validate the upload contract and evidence but do not reconcile records.

Keep separate outcome dimensions:

| Dimension | Meaning |
|---|---|
| **Transfer verified** | Both remote inputs have verified attributes and read-back records/content matching the validated staged files. This alone is not job submission or reconciliation. |
| **Job submitted** | A real JES job ID was returned and persisted. This alone is not successful processing. |
| **Processing successful** | The completed JES status, accepted step return codes, parsed COBOL counts and retrieved output records are all validated. |
| **Completed with discrepancies** | Actual COBOL RC 4 and exception outputs/counts are present and internally consistent; this is not a clean result and must not publish clean `FINAL`. |
| **Failed or unresolved** | A technical failure, missing evidence, timeout/unknown submission, count mismatch, or ambiguous side effect prevents a verified conclusion. Do not retry a mutation blindly. |
| **Cleanup succeeded / failed** | Cleanup is an independent outcome. It must not rewrite the business result. Failed/unknown runs retain diagnostic evidence; cleanup failure is recorded and surfaced. |

A zero RC by itself is not proof that correct records were processed or that EOD passed.

## Proposed run-specific resource strategy

`server/src/executionPlan.ts` derives candidate names as `Z73968` + generated eight-character token + a purpose suffix. Examples of suffixes in code include `TXNIN`, `SETIN`, `TXNSORT`, `SETSORT`, `DUPES`, `SETTLE`, `SETDATA`, `SETIDX`, `MATCHOUT`, `MISMOUT`, `TXNMISS`, `SETMISS`, `FINAL`, and `EODERROR`. The builder rejects another HLQ. These names are preview values only.

The personal HLQ is assigned for this project; it is not necessary to obtain a separate blanket sign-off just to develop. Actual target restrictions, qualifier/catalog/SMS rules, VSAM component conventions, maximum allocations and job conventions must be tested or confirmed if z/OS rejects or constrains them. The application must validate generated names and JCL without truncating; perform an exact collision query; persist the manifest before remote mutation; use safe new-allocation semantics; and add each dataset to the owned manifest only after creation is positively confirmed. Name appearance alone does not prove ownership.

Never use shared smoke datasets (`Z73968.BANK.*`) as write targets, or clean them; never mutate user data, shared source/load libraries, or another run's resources. Use the existing load library only as read-only `STEPLIB`. Never use `ZXP.PUBLIC.*`. Do not reuse the file-transfer verification manifest or its cleanup; that workflow is intentionally temporary.

Allocation estimates in the plan use a local 3390 track-byte assumption and headroom. Treat these as unapproved estimates until the owner confirms storage units, device/SMS mapping, capacity, output sizing and secondary extents. Exception-output sizing must account for 120-byte records, not just 38-byte input records.

## Stage gates and responsibilities

| Stage | Prerequisites | Success criteria | Failure behavior | Cleanup / retained evidence |
|---|---|---|---|---|
| 0. Authorization and admission | Future complete executor implemented/reviewed; authenticated application operator; CSRF/origin protections; explicit admin gates; approved non-production window, HLQ, profile, job class, source/load references and permissions. Current state fails this gate. | Server confirms flags/config, operator authorization, readiness, supported profile, approved org/uploads, plan integrity and no duplicate request. | Return a clear blocked/not-configured result. Do not contact mutation APIs or submit anything. | No remote resources. Persist blocked request/audit outcome only according to application policy. |
| 1. Local file verification | Both organization-scoped staged uploads exist; SHA-256 and byte size equal stored metadata; each file within configured max and 38-byte contract. | Nonempty file, valid 38-byte records, supported encoding/line endings, exact original bytes preserved; validated record counts reflect the upload only. | Reject before any remote mutation. Do not trim, pad, deduplicate, reorder or repair source records. | No remote cleanup. Keep or expire local staged files per existing upload policy. |
| 2. Plan, names and collision preflight | Owner-approved plan parameters and naming/storage policy; unique persisted run ID; validated server-generated JCL; every proposed dataset in a run-specific manifest. | Every generated DSN/JCL parameter passes exact validation; all required names are absent from an authoritative exact-name check; no baseline/shared DSN appears. | Fail closed on collision, malformed or uncertain response, name-limit issue or JCL validation issue. Do not allocate. | All manifest entries remain planned. Preserve the failure stage; no cleanup is claimed. |
| 3. Persist initial run and manifest | Stage 2 passes; idempotency key and unique run/run-plan constraint; durable MongoDB available. | Persist `PREFLIGHT` state, plan ID/version, all candidate resources, initial timestamps, actor and upload hash metadata before remote mutation. | Do not mutate remotely if persistence fails or duplicate/uncertain submission is found. | No remote cleanup. |
| 4. Allocate run-specific input datasets | Persisted manifest, exact absent check, approved allocation model, validated NEW-only allocation statements and security authorization. | Both PS datasets positively created with approved `DSORG=PS`, `RECFM=FB`, `LRECL=38`; actual safe attributes stored; ownership marked only after confirmation. | Stop at exact allocation stage; record actual result and any uncertain partial creation. Do not blindly retry. | Preserve known-created resources in manifest; do not wildcard delete. Cleanup only after positive ownership and according to approved policy. |
| 5. Upload and remote verify | Input datasets created; original staged hash/size/contract rechecked; temporary transfer copies created using existing normalized text-transfer convention; transfer permissions approved. | Actual upload operations succeed, remote attributes are correct, remote record counts and read-back records/content match originals. Mark **transfer verified** only after this. | Stop processing on any transfer/read-back discrepancy; no job submission. Keep source files and failure evidence. | Remove local transfer-only copies in all paths. Any remote cleanup is exact-manifest-only after owner-approved policy; never call verification workflow cleanup against reconciliation manifest. |
| 6. Transaction/settlement sort and duplicate preflight | Transfer verified, run-specific JCL reviewed by owner, output datasets absent/allocated as approved, job submission and JES permissions verified. | Transaction sort is bytes 1–10 ascending with existing `SUM FIELDS=NONE` behavior; settlement sort is bytes 1–10 ascending preserving duplicates. Actual input/output counts and duplicate evidence retrieved. Every step/job is checked against real JES status and RC. | Any technical sort/utility failure stops. Settlement duplicate result blocks VSAM create/load and COBOL. Do not equate duplicate evidence with technical success; classify explicitly. | Retain sorted and duplicate evidence until report persistence and cleanup decision. No cleanup during unknown/failed job outcome. |
| 7. Run-specific record validation | Stage 6 clean; a new parameterized REXX validator or owner-approved alternative has been deployed and its interface/RC tested. Existing `VALIDATE.rex` is blocked because it hardcodes shared `TXNSORT`/`SETSORT`. | Validator proves required run-specific datasets are accessible, nonempty, PS/FB/LRECL=38, have actual usable counts, and satisfy owner-approved checks. | Stop before VSAM; preserve SYSOUT, RC, run manifest. The current plan does not provide this runnable step. | No automatic deletion. |
| 8. Create and load run-specific settlement KSDS | Duplicate preflight has no duplicate settlement key; validation passed; owner-approved VSAM attributes/naming/storage; cluster is absent; JCL accepted. Repository COBOL requires 10-byte key at offset 0 and 38-byte records. | Cluster creation is positively confirmed; load job's actual JES status/RC and expected loaded count are verified; cluster attributes/key are checked. | Unexpected existing cluster or create/load uncertainty stops. A load error blocks COBOL. No replace/reuse behavior. | Preserve exact manifest and diagnostic spool. Cleanup of a partially created VSAM cluster requires explicit owner-approved recovery; do not infer cluster ownership from the name. |
| 9. COBOL reconciliation | Valid sorted transaction PS/FB/38 and loaded unique-key settlement KSDS; run-specific output DDs PS/FB/38 and PS/FB/120; load module/deployed source equivalence confirmed. | Real JES completion; `RECONCIL` step RC and six displayed counts captured. Retrieve outputs and independently verify their record formats/counts. Count accounting must hold: transaction = matched + mismatched + transaction-only; settlement = matched + mismatched + settlement-only. | RC 8+ or missing/invalid spool/output is failed or unresolved. RC 4 is completed with business discrepancies only if exception evidence and counts validate; no clean final publication. | Keep all inputs/output datasets and spool until verified report and audit are persisted. |
| 10. Output retrieval and semantic checks | COBOL job completed; exact output datasets are in run manifest; read/download permissions approved. | Download actual MATCHOUT/MISMOUT/TXNMISS/SETMISS, verify record formats and counts against COBOL summary and remote count checks. Exception details are from actual outputs, not inferred. | Missing output, count mismatch, malformed summary or retrieval failure means unresolved/failed; do not report successful reconciliation or EOD. | Preserve all diagnostic datasets and JES evidence. |
| 11. Dynamic EOD validation | Actual COBOL counts and independent physical record counts are verified; reviewed run-specific EOD JCL and accepted equations deployed. Existing EOD JCL is fixed to smoke data/counts and is not reused unchanged. | Mainframe-side count checks against this run's data pass; equations above pass; final JES state and required RCs pass. Clean publication only for RC 0 and zero mismatch/missing counts. | Any failed check prevents `FINAL`; RC 4/discrepancies may be recorded as completed-with-exceptions only if all relevant evidence validates. | Retain EOD SYSOUT/error marker and all involved outputs. No clean final dataset on failure or uncertainty. |
| 12. Report and audit persistence | Verified JES, COBOL, EOD and retrieved output evidence. | Persist job IDs/statuses/step RCs, timestamps, input hashes/counts, exact dataset manifest, counts, exceptions, publication decision, report references and audit event before marking terminal state. | If persistence fails, do not claim completion or clean cleanup eligibility. Reconcile durable state before recovery. | Keep remote datasets and spool until persistence can be confirmed. |
| 13. Cleanup/retention | Terminal evidence and reports persisted; owner-approved retention and cleanup authorization; exact manifest proves creation by this run. | Delete only explicitly owned, temporary run datasets by exact name; capture each result. Retain `FINAL` according to the approved policy. | On any failure, report cleanup warning separately and preserve business status. Unknown ownership/status blocks deletion. No wildcards or baseline names. | The first controlled test should retain all resources until owner/operator has inspected evidence; no cleanup until a separate approved decision. |

## Processing rules supported by checked-in source

- The input record contract is 38 bytes: ID bytes 1–10, account 11–20, amount 21–29, date 30–37, status 38. The repository documentation describes amount as nine digits with two implied decimal places, while COBOL treats it as character data and checks numeric syntax in relevant paths. No currency is specified.
- Transaction DFSORT sorts bytes 1–10 ascending and uses `SUM FIELDS=NONE`; this removes duplicate key records. The precise retained record for conflicting duplicate-key rows must be confirmed; do not assume application-level “first row” semantics from the text alone.
- Settlement DFSORT sorts bytes 1–10 and does not deduplicate. A duplicate key must be detected and prevent loading a unique-key KSDS.
- COBOL matches equal IDs only when account and amount agree. It does not compare date/status and emits no financial totals. It writes counts and exception records through the documented DDs.
- COBOL RC 0/4/8+ meanings are source/documentation claims. Confirm actual deployed program and JES behavior. RC 4 must not be collapsed into clean success.
- A zero return code does not prove correct input transfer, output record counts, count equations, EOD gate, or publication. All evidence is required.
- If a matched amount aggregate is later exposed, it must be computed only from verified `MATCHOUT` returned by the mainframe using exact integer arithmetic; unit/currency remains unspecified absent approved metadata.

## Suggested controlled test cases

Run only after prerequisites below are satisfied and with owner-approved non-production inputs/datasets.

| Case | What it demonstrates | Expected outcome evidence |
|---|---|---|
| Small clean smoke file | Basic upload, sort, unique settlement KSDS, COBOL match and EOD | Actual input/post-sort/output counts; matching counts; RCs; output read-back; final allowed only after clean EOD. |
| Transaction duplicate keys | Existing transaction dedup behavior | Raw vs sorted counts and actual retained key rows documented; no assumption about which conflicting row survives until confirmed. |
| Settlement duplicate key | Unique-key VSAM protection | Duplicate evidence retrieved; no VSAM create/load or COBOL job submitted. |
| Account or amount mismatch | COBOL business discrepancy path | RC 4, one actual mismatch diagnostic, consistent count equations, no clean final publication. |
| Transaction-only / settlement-only IDs | Missing-side outputs | RC 4 and the correct actual `TXNMISS` / `SETMISS` records; no clean final. |
| Invalid record/amount | Contract vs COBOL validation boundaries | Upload rejects structural error before mutation; numeric amount failure at COBOL is technical according to current source. |
| Collision and uncertain allocation | Safe admission and recovery | No overwrite or repeated allocation; persisted stage/manifest reflects only positively verified resource ownership. |
| JES timeout / submission ambiguity | Recovery discipline | Run marked unresolved; reconcile stored request with JES/dataset evidence before any retry; no blind resubmit/cleanup. |
| Output/count/EOD mismatch | False-success prevention | No terminal clean status and no `FINAL`; preserve spool and data for investigation. |
| Cleanup denied | Independent cleanup outcome | Business result remains its verified status; exact failed manifest item appears as cleanup warning; no unrelated resource touched. |

## Preconditions and owner questions

Before implementation is allowed to progress from disabled planning:

1. Confirm the target system and test that the assigned `Z73968` namespace permits the specific requested operations; confirm any actual qualifier, run-token, job-name/class or accounting restrictions returned by the environment.
2. Confirm the repository source and deployed `RECONCIL` load module are identical enough for the stated DD/record/RC behavior; provide compile/run evidence.
3. Provide or approve a parameterized run-specific validation member/alternative. Existing `VALIDATE.rex` checks fixed shared names and cannot be used for this run.
4. Approve the exact JCL and DFSORT/ICETOOL syntax, duplicate-selection cards, conditional/return-code behavior and job grouping; inspect actual JES output from a disposable run before application use.
5. Confirm allocation units and maximum primary/secondary space, output capacity for 120-byte exception records, SMS classes, volume handling, VSAM cluster components/key/sharing and retention.
6. Confirm whether a settlement KSDS must be newly defined per run and how partial define/load failures are safely recovered without deleting another run's cluster.
7. Verify the configured Zowe identity's permissions for exact dataset queries, allocation, IBM-1047 text upload, JCL submit, JES polling/spool, output download and exact-manifest deletion. If denied, document the actual response and stop; do not fall back to another HLQ. Confirm no arbitrary command/JCL facility is exposed.
8. Define acceptable JES completion statuses, job/step RC classification, timeout/recovery procedure, missing spool behavior, and how an unknown submission is reconciled before retry.
9. Approve business rules for conflicting duplicate transaction records, settlement duplicates, amount representation/currency, and what constitutes clean EOD.
10. Define report/audit persistence, remote output retention, temporary dataset cleanup timing and `FINAL` retention. For the first supervised run, retain all resources until evidence is reviewed.

## Current application state and safe next action

`POST /api/runs` currently validates the selected organization/uploads/plan and staged-file hashes, enforces an idempotency key, records `status: NOT_CONFIGURED`, audits a blocked request, and returns HTTP 503 with code `MAINFRAME_RECONCILIATION_NOT_CONFIGURED`. It has no call to submit a reconciliation job. Readiness also reports execution disabled. Setting environment gates cannot replace the missing executor.

For now, operators may inspect the plan preview and use the separate file-transfer verification only under its existing controls. Do not treat that temporary transfer workflow as a reconciliation run. Do not submit preview JCL manually as part of this plan. The first live test requires a later reviewed implementation and a separately authorized manual test window.

No live connection, allocation, upload, job, spool, report, EOD or cleanup operation was performed for this document.
