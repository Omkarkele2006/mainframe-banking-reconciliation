# Mainframe owner sign-off — reconciliation orchestration

**Purpose:** record targeted decisions and approvals needed for run-specific orchestration and a controlled non-production execution. This document is not a blanket prerequisite for local implementation.

**Approval status:** all items are `PENDING`. Blank response, approver, and date cells are intentionally left for human completion. Preparing this document is not mainframe-owner approval. This package does not enable execution or authorize a job.

## Current evidence and safety boundary

- The source audit is recorded in [RECONCILIATION_JCL_REVIEW_MATRIX.md](./RECONCILIATION_JCL_REVIEW_MATRIX.md); the proposed stage gates and evidence expectations are in [RECONCILIATION_NONPROD_TEST_PLAN.md](./RECONCILIATION_NONPROD_TEST_PLAN.md).
- The operator assigned `Z73968` as the project's personal development/test HLQ. All project-owned processing datasets must be run-specific under `Z73968.*`; `ZXP.PUBLIC.*` must not be used for write targets or cleanup. Assignment does not establish permissions for every operation.
- Repository jobs include fixed/shared smoke datasets and five-record expectations. `rexx/VALIDATE.rex` checks hardcoded shared `TXNSORT` and `SETSORT`. `vsam/VSAM_LOAD.jcl` uses `REPRO REPLACE` against a shared KSDS.
- Checked-in `cobol/RECONCIL.cbl` pairs by ID, compares account and amount for paired IDs, and emits six record counts. The audit did not establish date/status comparison or financial-total calculation. These are source observations, not proof that deployed load modules match the repository.
- Run-specific JCL in `server/src/executionPlan.ts` is preview text. It has not been submitted or validated on z/OS.
- The reconciliation API remains fail-closed: it records a request as `NOT_CONFIGURED`, returns HTTP 503, and does not submit a job. Execution is not enabled by this sign-off package.

## 1. Dataset allocation and isolation decisions

The assigned project namespace is `Z73968`. Complete the remaining site-specific allocation and isolation fields below. Preview-generated dataset names remain uncreated candidates, not proof of permission or existence.

| Field | Purpose | Owner response | Approver/role | Approval date | Status |
|---|---|---|---|---|---|
| Approved non-production system / LPAR | Identify the target system for a future controlled test. |  |  |  | PENDING |
| Assigned development/test HLQ | Project operator assigned `Z73968`; verify whether any environment restriction prevents the planned operation. Do not substitute a public HLQ. |  |  |  | PENDING |
| Permitted naming pattern | Specify permitted qualifiers, characters, token scheme, maximum total DSN length, maximum qualifier length, and any reserved qualifiers. |  |  |  | PENDING |
| Concurrent-run isolation | State how run identifiers are assigned, collision checked, isolated in catalog/storage, and protected across concurrent submissions. |  |  |  | PENDING |
| Sequential input allocation | Approve DSORG, RECFM, LRECL, block-size policy, allocation unit, primary/secondary space, extent limits, SMS classes, and capacity ceilings for 38-byte input/sort datasets. |  |  |  | PENDING |
| Exception/output allocation | Approve capacity calculations and allocation policy for `FB/120` exception records and `FB/38` match/final output. |  |  |  | PENDING |
| VSAM allocation | Approve whether temporary per-run KSDS clusters are permitted; define key offset/length, record size, component naming, primary/secondary space, free space, share options, SMS policy, cataloging and recovery. |  |  |  | PENDING |
| Dataset operation allowlist | List exact classes of datasets the application may create, read, replace, or delete. Specify whether replacement is prohibited; proposed application behavior is create-new only and never replace shared data. |  |  |  | PENDING |
| Baseline/shared dataset protection | Identify baseline, user-owned, shared library, and restricted dataset patterns that must never be mutated or removed. |  |  |  | PENDING |
| Temporary dataset cleanup | Specify eligible temporary resources, exact ownership proof, retention period, cleanup authority, and manual recovery when ownership or creation outcome is uncertain. |  |  |  | PENDING |
| Published `FINAL` retention | Specify whether final output is retained, where it is cataloged, and its retention/cleanup owner. |  |  |  | PENDING |
| Storage/device policy | Confirm whether the preview's track estimates or `SYSDA` assumptions are acceptable; provide the approved storage/device conventions and maximum allocation. |  |  |  | PENDING |

## 2. Program and JCL artifact approvals

The owner should identify the deployed version/member, approve the future run-specific interface, and attach or reference non-production evidence. No current generated JCL is represented as target-valid.

| Artifact / actual member | Intended purpose | Current shared/hardcoded dependencies | Required decision or parameterization | Owner review and evidence required | Owner response | Approver/role | Approval date | Status |
|---|---|---|---|---|---|---|---|---|
| `rexx/VALIDATE.rex` — member `VALIDATE` | Check sorted input datasets for accessibility, nonempty content, PS/FB/LRECL=38 and record length. | Hardcodes `Z73968.BANK.TXNSORT` and `Z73968.BANK.SETSORT`; accepts no run DSN arguments. | Approve a new run-specific member/interface or an equivalent validator. Specify accepted arguments, validation rules, environment/library setup and RCs. Do not overwrite the shared member without explicit change approval. | Source/member identity; test against disposable run datasets; JES/SYSOUT and RC evidence; missing/inaccessible/malformed cases. |  |  |  | PENDING |
| `jcl/master/MASTER.jcl` — job `BANKMAST` | Existing combined smoke flow: sort, REXX, shared VSAM load, COBOL, smoke counts and conditional final copy. | Fixed `TXNTEST`, `SETTEST`, sort/output datasets, shared KSDS, `Z73968.SOURCE(VALIDATE)`, `Z73968.LOAD`; five-record count checks. | Confirm whether to retire, parameterize, or use only as a reference. Approve job grouping, symbols, per-run DDs, RC gates and EOD behavior. | Reviewed JCL listing; successful/negative JES runs; actual step RCs, count checks, and proof shared datasets were untouched. |  |  |  | PENDING |
| `jcl/eod/EOD_VALIDATION.jcl` — job `EODVAL` | Standalone smoke-only EOD check and final-copy gate. | Fixed shared input/output names, literal five/zero counts, manually supplied `RECONRC`. | Define dynamic count inputs, accepted COBOL RCs, count equations, discrepancy behavior and final publication rules; decide whether to retire or rewrite for run-specific use. | Passing clean run and discrepancy/failure evidence; verify no `FINAL` on any failed gate; actual JES output and count evidence. |  |  |  | PENDING |
| `vsam/VSAM_CREATE.jcl` — job `VSAMCRT`, IDCAMS `DEFINE CLUSTER` | Define indexed settlement KSDS. | Fixed `Z73968.BANK.RECON.REF.KSDS` and component names; literal attributes and allocation; class/account/message fields. | Approve per-run cluster and component naming, attributes, allocation, RC handling, existing-cluster behavior and partial-create recovery. Confirm terminology discrepancy in comments (`TXN_ID`) versus COBOL key (`SETTLE-ID`). | Target IDCAMS/JES output for create success, collision, authorization failure and partial failure; verified catalog attributes. |  |  |  | PENDING |
| `vsam/VSAM_LOAD.jcl` — job `VSAMLOAD`, IDCAMS `REPRO` | Load sorted settlement records to VSAM. | Fixed shared `SETSORT` and shared KSDS; `REPLACE` option. | Confirm that application use must be new-cluster-only; specify duplicate behavior, load validation and failure recovery. Approve any replacement semantics explicitly (default proposal: none). | JES/SYSPRINT evidence for successful load, duplicate key and failed/partial load; independently verified loaded count; no shared data changes. |  |  |  | PENDING |
| `jcl/assignment1/SORT_DEDUP.jcl` — job `TXNSORT` | Standalone transaction sort/dedup smoke job. | Fixed `TXNTEST` input and `TXNSORT` output. | Approve bytes 1–10 ascending and `SUM FIELDS=NONE`; specify which row is retained for duplicate IDs with conflicting non-key values. | DFSORT input/output counts and representative exact/conflicting duplicate results from a disposable fixture. |  |  |  | PENDING |
| `jcl/assignment1/SORT_SETTLEMENT.jcl` — job `SETSORT` | Standalone settlement sort. | Fixed `SETTEST` input and `SETSORT` output. | Approve key ordering, preservation of duplicate keys, duplicate-detection stage, and required failure classification before VSAM. | JES/DFSORT results for unique and duplicate-key settlement fixtures; proof duplicate case blocks VSAM and COBOL. |  |  |  | PENDING |
| `sort/SORTCNTL.txt` | Transaction DFSORT control cards (`SORT FIELDS=(1,10,CH,A)`, `SUM FIELDS=NONE`). | No DSNs; caller supplies DDs. Master embeds equivalent cards separately. | Confirm whether this control member is deployed/used; approve duplicate semantics and character collating behavior. | Show actual job references and target DFSORT output for duplicate test data. |  |  |  | PENDING |
| `sort/SETSORTCNTL.txt` | Settlement DFSORT control cards (`SORT FIELDS=(1,10,CH,A)`). | No DSNs; caller supplies DDs. | Confirm deployment/use, ordering behavior and how duplicates are reported while preserved. | Show actual job references and target DFSORT output including duplicate evidence. |  |  |  | PENDING |
| `cobol/RECONCIL.cbl` — program `RECONCIL` | Merge transactions against indexed settlement records; emit match, mismatch and missing-side outputs plus six counts. | No DSNs in COBOL; caller-provided DDs. Requires `TRANIN`, `SETTIN`, `MATCHOUT`, `MISMOUT`, `TXNMISS`, `SETMISS`. | Confirm deployed module/source version, compiler/runtime, key and sort assumptions, field comparison rules, counter limits, record layouts, RC 0/4/8+ meaning and output message format. Decide whether date/status, debit/credit, currency, precision or totals must be added in a separately reviewed source change. | Build/listing identity; JES output for clean, mismatch, each missing side, invalid amount, file errors and count boundaries; retrieve and inspect each output dataset. |  |  |  | PENDING |
| `server/src/executionPlan.ts` — generated plan templates | Local run-name/allocation/JCL preview; not a mainframe artifact or executor. | Preview names are run-scoped under input HLQ; references shared load library read-only; dynamic REXX stage remains blocked. | Review proposed inputs and generated text after owner values are supplied. Decide approved job/dataset parameters; do not approve by preview alone. | Static review plus owner-supervised target syntax and non-production job evidence for every generated job. |  |  |  | PENDING |
| `server/src/zoweCli.ts`, `server/src/zoweUploadAdapter.ts`, `server/src/uploadVerification.ts` — fixed CLI/upload path | Readiness and separate file-transfer verification; not reconciliation orchestration. | Upload verification has its own temporary resources and cleanup manifest. | Approve exact permissions and supported operations needed for future reconciliation; confirm the transfer-verification cleanup cannot be reused on a reconciliation manifest. | Authorization matrix and separately reviewed test evidence for allocate/upload/readback/submit/JES/download/exact cleanup. |  |  |  | PENDING |

## 3. Business-rule decisions

Current source-supported behavior is limited: checked-in COBOL pairs records by ID, compares account and amount, and emits six counts. The review did not establish date/status comparison or financial-total calculation. Do not silently change these rules or assume repository source equals the deployed program.

| Decision/question | Current evidence | Owner response | Approver/role | Approval date | Status |
|---|---|---|---|---|---|
| Authoritative transaction key and position/format | COBOL record layout names bytes 1–10 `TRAN-ID`; DFSORT sorts positions 1–10. |  |  |  | PENDING |
| Authoritative settlement key and position/format | COBOL indexed record key `SETTLE-ID`; `VSAM_CREATE.jcl` uses `KEYS(10 0)`. |  |  |  | PENDING |
| Pairing/match rule for equal IDs | COBOL compares account and amount; a match writes the transaction record when both equal. |  |  |  | PENDING |
| Transaction duplicate ID policy | Existing DFSORT uses `SUM FIELDS=NONE`; precise survivor for conflicting rows is not established. Specify reject/deduplicate/which-row semantics. |  |  |  | PENDING |
| Settlement duplicate record policy | Settlement sort preserves keys; indexed KSDS requires unique key. Confirm reject policy and duplicate evidence/RC. |  |  |  | PENDING |
| Missing transaction / missing settlement behavior | COBOL emits `SETMISS` for settlement-only and `TXNMISS` for transaction-only. Confirm whether each is a business exception and whether either can be accepted. |  |  |  | PENDING |
| Account mismatch classification | COBOL writes a combined mismatch diagnostic when account or amount comparison fails. Decide whether account and amount should be separate discrepancy categories. |  |  |  | PENDING |
| Amount mismatch classification | COBOL compares the nine-character amount fields as characters after numeric checks in paired paths. Approve numeric format and exact semantics. |  |  |  | PENDING |
| Date comparison | Checked-in COBOL does not compare date. Should date be compared? Define accepted date format/calendar validation. |  |  |  | PENDING |
| Status comparison | Checked-in COBOL does not compare status. Should status be compared? Define valid values and effect on matching. |  |  |  | PENDING |
| Debit/credit direction and sign | Not established by source; no direction field is identified in the 38-byte layout. Specify representation and accounting rules if required. |  |  |  | PENDING |
| Currency and precision | Documentation describes two implied decimal places; no currency metadata is present. Specify currency, scale, rounding and whether multiple currencies are allowed. |  |  |  | PENDING |
| Financial totals | COBOL emits no financial totals. Specify totals, authoritative source, balance equations and acceptable tolerances; identify whether a reviewed source/output change is required. |  |  |  | PENDING |
| Required counts and equations | Source emits transaction, settlement, matched, mismatched, transaction-only and settlement-only counts. Proposed checks: transaction = matched + mismatched + transaction-only; settlement = matched + mismatched + settlement-only. Approve definitions and any additional totals. |  |  |  | PENDING |
| Clean acceptance criteria and EOD decision | Smoke artifacts use fixed expectations; production/non-production acceptance criteria are not established. Specify exact count, discrepancy, duplicate, job-step and publication conditions. |  |  |  | PENDING |
| Business discrepancy versus technical job result | Source documentation describes RC 4 for business differences and RC 8+ for technical error; deployed behavior not verified. Can RC 4 be an accepted completed business outcome? It must not be reported as clean. |  |  |  | PENDING |
| Final publication | Smoke EOD copies matched output only when RC 0 and fixed counts pass. Approve what `FINAL` means, its contents, who may consume it, and when it may be published. |  |  |  | PENDING |

## 4. Execution, permissions, evidence, and recovery

| Decision/question | Current evidence | Owner response | Approver/role | Approval date | Status |
|---|---|---|---|---|---|
| Approved Zowe profile and execution account | Existing local profile label is `zosmf`; profile label is not authorization. |  |  |  | PENDING |
| Required z/OS permissions | Future orchestration may require exact-name dataset query, allocate/create, write/upload, submit, JES status/spool read, output download and exact manifest-owned delete. Actual permitted authorities are not established. |  |  |  | PENDING |
| Job class, accounting and submission mechanism | Smoke JCL uses class 7 in some jobs; VSAM jobs use class A and fixed account/message fields. No common approved execution policy established. |  |  |  | PENDING |
| Job IDs and job names | JES returns actual job identity; preview proposes a token-based name. Owner to approve accepted format and collision rules. |  |  |  | PENDING |
| Polling and completion status | No live reconciliation poller exists. Define accepted JES status, polling interval/deadline, cancellation policy and terminal conditions. |  |  |  | PENDING |
| Step RC / condition-code policy | Repository source/docs describe COBOL RC 0, 4, and 8+; utility/JCL RC behavior requires target verification. Specify accepted RCs per step/job, warnings and condition-code handling. |  |  |  | PENDING |
| Required job evidence | Proposed evidence includes actual job/step IDs, JES status, RCs, relevant JES/SYSOUT/IDCAMS/DFSORT/ICETOOL output, six COBOL counts, remote output counts and EOD result. Approve exact spool classes/DDs and retention. |  |  |  | PENDING |
| Submission timeout or uncertain outcome | No reconciliation submit/recovery implementation exists. Define how to query JES by correlation/job name and establish whether submission occurred before retry. |  |  |  | PENDING |
| Partial dataset allocation | Define how to establish exact created-resource ownership after timeout/partial success; specify whether to retain, inspect or manually recover. |  |  |  | PENDING |
| Upload or read-back failure | Define whether uploaded datasets are retained for investigation, how integrity is checked, and who authorizes any cleanup. |  |  |  | PENDING |
| Job failure / missing spool / output retrieval failure | Define unresolved state, evidence retention, re-query approach and explicit recovery approval. No automatic retry should repeat uncertain side effects. |  |  |  | PENDING |
| Cleanup ownership and retention | Exact manifest-only cleanup is proposed; retention periods and delete authority are not established. Define temporary-input, sort, duplicate, VSAM, exception, spool, report and `FINAL` retention separately. |  |  |  | PENDING |
| Audit/report retention | Application audit/report metadata is persisted locally; required mainframe evidence retention, privacy classification and retention duration are not established. |  |  |  | PENDING |
| Manual recovery procedure | Provide runbook/contact for orphaned datasets/jobs, partial VSAM clusters, uncertain submissions and cleanup denial. |  |  |  | PENDING |
| Controlled non-production test approval | Identify responsible approving role/contact, required change ticket/window, approved test data and explicit go/no-go evidence. |  |  |  | PENDING |
| Site-specific certificate/security review | Existing local Zowe profile TLS posture is separate from this sign-off; no TLS validation is claimed. Specify required administrator review and environment policy before any remote execution. |  |  |  | PENDING |

## 5. Sign-off register

Record each individual answer in the sections above, then complete the corresponding sign-off row. `Owner response`, `Approver/role`, and `Approval date` remain blank until provided by the human approver. Do not change status to approved without explicit owner approval and evidence.

| Decision/question | Current evidence | Owner response | Approver/role | Approval date | Status |
|---|---|---|---|---|---|
| Approved non-production environment, HLQ, dataset naming and isolation rules | No execution HLQ or naming policy approved in repository; preview names only. |  |  |  | PENDING |
| Dataset allocation, formats, space/SMS policy, VSAM definition and limits | Current jobs show smoke literals; site policy not established. |  |  |  | PENDING |
| Create/read/replace/delete allowlist and dataset retention/cleanup | Shared smoke jobs include fixed names and `REPLACE`; application should be manifest-scoped. Owner policy absent. |  |  |  | PENDING |
| Run-specific validation REXX/alternative | `VALIDATE.rex` hardcodes shared sort DSNs. |  |  |  | PENDING |
| Master/sort/VSAM/COBOL/EOD artifact disposition and parameterization | Review matrix describes fixed smoke names/counts and target validation gaps. |  |  |  | PENDING |
| Matching, keys, duplicates, missing rows, field comparison and financial rules | Source behavior is limited; business acceptance criteria not established. |  |  |  | PENDING |
| Job submission authority, job class, JES polling, RC/condition codes and evidence retention | No reconciliation executor; several smoke job classes/RC paths differ. |  |  |  | PENDING |
| Timeout, uncertain submission, partial failure, recovery and manual runbook | No live recovery path exists. |  |  |  | PENDING |
| Security permissions, Zowe account/profile and non-production test window | No reconciliation authorization matrix or test approval supplied. |  |  |  | PENDING |

## 6. Exit criteria

### Decisions needed while implementing the run-specific orchestrator

- [ ] Apply the assigned `Z73968` namespace in code; record any actual environment naming restriction or permission denial. Do not use `ZXP.PUBLIC.*` as a fallback.
- [ ] Owner approves allocation/SMS/VSAM attributes, resource operation allowlist, resource ownership proof and retention/cleanup policy.
- [ ] Owner approves deployed program/member identities and target interfaces for `RECONCIL`, sort controls, validation REXX/alternative, VSAM, and EOD.
- [ ] Business owner approves keys, duplicate policies, missing-side outcomes, field comparisons, financial semantics, balancing equations, discrepancy acceptance and final-publication criteria.
- [ ] Owner defines job class/submission mechanism, JES status/polling, RC/condition-code interpretation, evidence requirements, timeout and recovery behavior.
- [ ] Required Zowe/z/OS permissions and security review are documented as they are established; app authorization and audit controls remain mandatory.
- [ ] Decisions are recorded with named approver role/date and explicit status; unresolved blockers remain fail-closed.

### Mandatory before the first controlled non-production live test

- [ ] Run-specific validator and all proposed JCL have been reviewed and validated by the owner in the approved target environment.
- [ ] A later implementation includes the complete authenticated orchestration path, durable state/manifest, duplicate-submission controls, JES/output verification, EOD gate and exact-manifest cleanup/recovery; the current API is not that implementation.
- [ ] All execution configuration is reviewed and deliberately enabled by the authorized administrator only after the above criteria; this document does not change any flag.
- [ ] Owner approves exact disposable test inputs, run, resources, maintenance window and observation/recovery contacts.
- [ ] The first run retains all remote input/output/spool evidence until the owner reviews actual JES status, step RCs, six COBOL counts, output counts, discrepancies, EOD decision and cleanup plan.
- [ ] A separate explicit owner/operator decision authorizes cleanup after report/audit evidence is persisted; no wildcard or baseline/shared resource cleanup is permitted.

## Related documents

- [Reconciliation execution status](./RECONCILIATION_EXECUTION_STATUS.md)
- [JCL/source review matrix](./RECONCILIATION_JCL_REVIEW_MATRIX.md)
- [Proposed non-production test plan](./RECONCILIATION_NONPROD_TEST_PLAN.md)

**Final status:** approval has not been obtained by preparing this package. Reconciliation remains disabled and `NOT_CONFIGURED`; no z/OS job or dataset operation is authorized here.


