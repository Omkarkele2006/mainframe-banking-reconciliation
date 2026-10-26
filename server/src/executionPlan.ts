import { randomBytes, randomInt } from 'node:crypto';

const TOKEN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TOKEN_SPACE = 36 ** 7;
const TOKEN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Project-owned reconciliation resources are isolated to the assigned personal HLQ. */
export const PROJECT_RECONCILIATION_HLQ = 'Z73968' as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const TRACK_BYTES_3390 = 56_664;
export const ALLOCATION_HEADROOM = 1.25;
const DATASET_SUFFIXES = {
  TXNIN: 'TXNIN', SETIN: 'SETIN', TXNSORT: 'TXNSORT', SETSORT: 'SETSORT', DUPES: 'DUPES',
  SETTLE: 'SETTLE', SETTLE_DATA: 'SETDATA', SETTLE_INDEX: 'SETIDX', MATCHOUT: 'MATCHOUT',
  MISMOUT: 'MISMOUT', TXNMISS: 'TXNMISS', SETMISS: 'SETMISS', FINAL: 'FINAL', EODERROR: 'EODERROR',
} as const;

export type RunDatasets = Record<keyof typeof DATASET_SUFFIXES, string>;
export type MainframePlanConfig = {
  hlq: string;
  jobClass: string;
  sourceLibrary: string;
  loadLibrary: string;
  loadModule: string;
  rexxMember: string;
};
export type CobolCounts = {
  transactionCount: number;
  settlementCount: number;
  matchedCount: number;
  mismatchedCount: number;
  transactionOnlyCount: number;
  settlementOnlyCount: number;
};
export type RunExecutionPlan = {
  runId: string;
  token: string;
  jobName: string;
  config: MainframePlanConfig;
  /** Exact validated file metadata used to size the run's input and sort datasets. */
  inputs: { transaction: PlanInputFile; settlement: PlanInputFile };
  datasets: RunDatasets;
  allocation: {
    transactionInputTracks: number; settlementInputTracks: number;
    transactionSortTracks: number; settlementSortTracks: number; duplicateTracks: number;
    settlementVsamPrimaryTracks: number; settlementVsamSecondaryTracks: number;
    matchTracks: number; mismatchTracks: number; transactionOnlyTracks: number; settlementOnlyTracks: number; finalTracks: number;
    maximumUploadBytes: number; headroomPercent: 25; vsamHeadroomPercent: 50;
  };
  duplicatePolicy: { transaction: 'DEDUPLICATE_BY_ID_KEEP_FIRST_AS_EXISTING_MASTER'; settlement: 'FAIL_ON_DUPLICATE_KEY_BEFORE_VSAM_LOAD' };
  collisionCheckRequired: true;
  cleanupPolicy: 'RETAIN_PENDING_APPROVAL';
};

export type JesJobEvidence = { jobId: string; status: string; returnCode: number | null };
/** Cross-job orchestration must call this with normalized evidence retrieved from JES. */
export function assertSuccessfulJesJob(evidence: JesJobEvidence, stage: string): void {
  if (!evidence.jobId || evidence.status !== 'OUTPUT' || evidence.returnCode !== 0) {
    throw new Error(`${stage} cannot advance: JES must report a completed OUTPUT job with return code 0.`);
  }
}

function tracksForBytes(bytes: number, headroom = ALLOCATION_HEADROOM): number {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Allocation byte count is invalid.');
  return Math.max(1, Math.ceil(bytes * headroom / TRACK_BYTES_3390));
}

function computeAllocation(transaction: PlanInputFile, settlement: PlanInputFile): RunExecutionPlan['allocation'] {
  const txnRaw = Math.max(transaction.size, transaction.recordCount * 38);
  const setRaw = Math.max(settlement.size, settlement.recordCount * 38);
  const vsamTotal = tracksForBytes(setRaw, 1.5); // 50% for KSDS index/control overhead and growth.
  const vsamSecondary = Math.max(1, Math.ceil(vsamTotal * 0.2));
  const vsamPrimary = Math.max(1, vsamTotal - vsamSecondary);
  return {
    transactionInputTracks: tracksForBytes(txnRaw), settlementInputTracks: tracksForBytes(setRaw),
    transactionSortTracks: tracksForBytes(transaction.recordCount * 38), settlementSortTracks: tracksForBytes(settlement.recordCount * 38), duplicateTracks: tracksForBytes(settlement.recordCount * 38),
    settlementVsamPrimaryTracks: vsamPrimary, settlementVsamSecondaryTracks: vsamSecondary,
    matchTracks: tracksForBytes(Math.min(transaction.recordCount, settlement.recordCount) * 38),
    mismatchTracks: tracksForBytes(Math.min(transaction.recordCount, settlement.recordCount) * 120),
    transactionOnlyTracks: tracksForBytes(transaction.recordCount * 120), settlementOnlyTracks: tracksForBytes(settlement.recordCount * 120),
    finalTracks: tracksForBytes(Math.min(transaction.recordCount, settlement.recordCount) * 38),
    maximumUploadBytes: MAX_UPLOAD_BYTES, headroomPercent: 25, vsamHeadroomPercent: 50,
  };
}

function assertAllocationInput(label: string, file: PlanInputFile): void {
  if (!file.valid || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_UPLOAD_BYTES || !Number.isSafeInteger(file.recordCount) || file.recordCount <= 0 || file.recordCount > Math.floor(MAX_UPLOAD_BYTES / 38) + 1 || file.size < file.recordCount * 38 || file.size > file.recordCount * 40) {
    throw new Error(`${label} upload metadata is invalid for the 38-byte fixed-width contract or the ${MAX_UPLOAD_BYTES}-byte maximum.`);
  }
}

export type PlanInputFile = { originalName: string; size: number; recordCount: number; valid: boolean };
export type ExecutionPlanPreview = {
  runId: string;
  organization: { id: string; name: string };
  profile: 'SMOKE' | 'VOLUME_10K' | 'NEGATIVE';
  inputs: { transaction: PlanInputFile; settlement: PlanInputFile };
  executable: false;
  plan: RunExecutionPlan;
  datasets: Array<{ name: string; purpose: string; format: string; space: string; state: 'PLANNED_NOT_CREATED' }>;
  steps: Array<{ order: number; name: string; purpose: string; dependencies: string[]; jobName?: string; jcl: string | null; jclUnavailableReason?: string; expectedDd: string[]; checks: string[]; state: 'PLAN_ONLY' | 'BLOCKED' }>;
  cleanupManifest: { state: 'PLANNED_NOT_CREATED'; automaticCleanupEnabled: false; temporaryDatasetCandidates: string[]; retainedDatasetCandidates: string[]; policy: string };
  limitations: string[];
};

function validateGeneratedJcl(jcl: string, plan: RunExecutionPlan): void {
  if (!jcl || jcl.includes('\0') || jcl.includes('\r')) throw new Error('Generated JCL contains invalid control characters.');
  const approvedDatasets = new Set(Object.values(plan.datasets));
  for (const line of jcl.split('\n')) {
    if (line.length > 71) throw new Error('Generated JCL statement exceeds the 71-column statement area.');
    const match = line.match(/\bDSN=([^,\s]+)/);
    if (match && !approvedDatasets.has(match[1]) && match[1] !== plan.config.loadLibrary) throw new Error('Generated JCL references a dataset outside the run plan allowlist.');
  }
}

/** Creates a display-only plan. It never allocates datasets or submits generated JCL. */
export function buildExecutionPlanPreview(input: {
  runId: string;
  organization: { id: string; name: string };
  profile: 'SMOKE' | 'VOLUME_10K' | 'NEGATIVE';
  transaction: PlanInputFile;
  settlement: PlanInputFile;
  config: MainframePlanConfig;
  token?: string;
  maxUploadBytes?: number;
}): ExecutionPlanPreview {
  const maximum = Math.min(input.maxUploadBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Configured maximum upload size is invalid.');
  for (const [label, file] of [['Transaction', input.transaction], ['Settlement', input.settlement]] as const) {
    assertAllocationInput(label, file);
    if (file.size > maximum) throw new Error(`${label} upload exceeds the configured upload-size limit.`);
    if (typeof file.originalName !== 'string' || file.originalName.length < 1 || file.originalName.length > 255 || /[\r\n\0]/.test(file.originalName)) throw new Error(`${label} filename is invalid.`);
  }
  if (!input.organization.id || !input.organization.name.trim()) throw new Error('Organization metadata is required.');
  const plan = buildRunExecutionPlan(input.runId, input.config, input.token ?? createDatasetToken(), { transaction: input.transaction, settlement: input.settlement });
  const allocation = generateAllocationJcl(plan);
  const preflight = generatePreflightJcl(plan);
  const reconciliation = generateReconciliationJcl(plan);
  [allocation, preflight, reconciliation].forEach((jcl) => validateGeneratedJcl(jcl, plan));
  const datasets: ExecutionPlanPreview['datasets'] = [
    ['TXNIN', 'Uploaded transaction records before sort', 'PS · FB · LRECL 38', `TRK(${plan.allocation.transactionInputTracks})`],
    ['SETIN', 'Uploaded settlement records before sort', 'PS · FB · LRECL 38', `TRK(${plan.allocation.settlementInputTracks})`],
    ['TXNSORT', 'Transaction records sorted by transaction ID; existing SUM FIELDS=NONE policy', 'PS · FB · LRECL 38', `TRK(${plan.allocation.transactionSortTracks})`],
    ['SETSORT', 'Settlement records sorted by settlement key; duplicates preserved for detection', 'PS · FB · LRECL 38', `TRK(${plan.allocation.settlementSortTracks})`],
    ['DUPES', 'Duplicate settlement keys; any record blocks VSAM load', 'PS · FB · LRECL 38', `TRK(${plan.allocation.duplicateTracks})`],
    ['SETTLE', 'Run-specific unique-key settlement KSDS', 'VSAM KSDS · key offset 0 length 10 · record 38', `TRACKS(${plan.allocation.settlementVsamPrimaryTracks} ${plan.allocation.settlementVsamSecondaryTracks})`],
    ['SETTLE_DATA', 'VSAM KSDS data component', 'VSAM DATA', `TRACKS(${plan.allocation.settlementVsamPrimaryTracks} ${plan.allocation.settlementVsamSecondaryTracks})`],
    ['SETTLE_INDEX', 'VSAM KSDS index component', 'VSAM INDEX', `TRACKS(${plan.allocation.settlementVsamPrimaryTracks} ${plan.allocation.settlementVsamSecondaryTracks})`],
    ['MATCHOUT', 'Matched transaction records', 'PS · FB · LRECL 38', `TRK(${plan.allocation.matchTracks})`],
    ['MISMOUT', 'Field-level mismatches', 'PS · FB · LRECL 120', `TRK(${plan.allocation.mismatchTracks})`],
    ['TXNMISS', 'Transaction-only records', 'PS · FB · LRECL 120', `TRK(${plan.allocation.transactionOnlyTracks})`],
    ['SETMISS', 'Settlement-only records', 'PS · FB · LRECL 120', `TRK(${plan.allocation.settlementOnlyTracks})`],
    ['FINAL', 'Published final output, only after verified EOD gates', 'PS · FB · LRECL 38', `TRK(${plan.allocation.finalTracks})`],
    ['EODERROR', 'EOD failure diagnostic marker', 'PS · FB · LRECL 80', 'TRK(1)'],
  ].map(([key, purpose, format, space]) => ({ name: plan.datasets[key as keyof RunDatasets], purpose, format, space, state: 'PLANNED_NOT_CREATED' }));
  const steps: ExecutionPlanPreview['steps'] = [
    { order: 1, name: 'Allocate run inputs', purpose: 'Allocate new run-specific PS datasets with DISP=NEW; collision check required first.', dependencies: [], jobName: plan.jobName, jcl: allocation, expectedDd: ['TXNIN: PS FB 38', 'SETIN: PS FB 38'], checks: ['IEFBR14 return code must be 0.', 'Both datasets must be absent before allocation; no overwrite is permitted.'], state: 'PLAN_ONLY' },
    { order: 2, name: 'Transfer and verify uploaded records', purpose: 'The run adapter uses the allowlisted Zowe text-transfer and read-back operations; preview does not upload or rewrite data.', dependencies: ['Allocate run inputs'], jobName: undefined, jcl: null, jclUnavailableReason: 'This is an allowlisted Zowe file operation rather than JCL; no remote transfer occurs in preview.', expectedDd: ['TXNIN', 'SETIN'], checks: ['Transferred byte and record counts must match the uploaded metadata exactly.'], state: 'PLAN_ONLY' },
    { order: 3, name: 'Sort and settlement duplicate preflight', purpose: 'Sort transactions using existing duplicate-elimination behavior; preserve settlement duplicates and fail before KSDS load when any duplicate key exists.', dependencies: ['Transfer uploaded records'], jobName: plan.jobName, jcl: preflight, expectedDd: ['SORTIN → SORTOUT', 'SETIN → DUPES'], checks: ['SETSORT runs only when TXNSORT RC=0; DUPSEL only when SETSORT RC=0; DUPCNT only when DUPSEL RC=0.', 'TXNSORT, SETSORT and DUPSEL require RC=0; DUPCNT RC=0 means zero duplicates and RC8 fails the preflight.', 'The backend must wait for JES OUTPUT and RC=0 before submitting any following job.', 'Actual sorted counts must be recorded; uploaded counts are not treated as post-deduplication counts.'], state: 'PLAN_ONLY' },
    { order: 4, name: 'Validate run-specific sort outputs', purpose: 'Read back the actual generated datasets and verify record format, count, and sort ordering; do not call the checked-in REXX member because it names shared smoke datasets.', dependencies: ['Sort and settlement duplicate preflight'], jobName: undefined, jcl: null, jclUnavailableReason: 'This is a post-sort Zowe dataset read-back and validation stage, not a JCL job; no remote operation occurs in preview.', expectedDd: ['TXNSORT', 'SETSORT', 'DUPES'], checks: ['Transaction rows may be reduced by the existing SUM FIELDS=NONE policy; settlement rows remain present for duplicate detection.', 'Records must be FB/38 and ordered by the first 10 bytes; settlement duplicate evidence must be empty before VSAM creation.'], state: 'PLAN_ONLY' },
    { order: 5, name: 'VSAM load and COBOL reconciliation', purpose: `Create a run-specific KSDS, load unique settlement keys, then invoke ${plan.config.loadModule}.`, dependencies: ['Validate run-specific sort outputs'], jobName: plan.jobName, jcl: reconciliation, expectedDd: ['TRANIN · PS/FB/38', 'SETTIN · indexed VSAM KSDS, key SETTLE-ID (offset 0, length 10)', 'MATCHOUT · PS/FB/38', 'MISMOUT · PS/FB/120', 'TXNMISS · PS/FB/120', 'SETMISS · PS/FB/120'], checks: ['VSAMLOAD executes only for VSAMCRT RC=0; RECONCIL executes only for VSAMLOAD RC=0. Any nonzero code, including an unexpected pre-existing-cluster failure, blocks downstream steps.', 'The backend must wait for each submitted job’s actual JES OUTPUT status and RC=0 before advancing to another separately submitted job.', 'COBOL RC=0 is clean; RC=4 is a business exception; RC≥8 is technical failure.', 'All six COBOL counts and physical output counts must agree.'], state: 'BLOCKED' },
    { order: 6, name: 'EOD validation and publication gate', purpose: 'Generate count comparisons from actual COBOL SYSOUT and physical output counts, then publish only if every required gate passes.', dependencies: ['VSAM load and COBOL reconciliation'], jobName: undefined, jcl: null, jclUnavailableReason: 'The COBOL report and physical output counts do not exist until a real job completes; count-specific EOD JCL cannot be formed in a preview.', expectedDd: ['TXNSORT', 'SETSORT', 'MATCHOUT', 'MISMOUT', 'TXNMISS', 'SETMISS'], checks: ['Expected values must come from this run’s actual COBOL output, never smoke-test constants.', 'Publication requires clean return codes, zero duplicate settlement keys and consistent counts.'], state: 'BLOCKED' },
  ];
  const temporary = ['TXNIN','SETIN','TXNSORT','SETSORT','DUPES','SETTLE','SETTLE_DATA','SETTLE_INDEX','MATCHOUT','MISMOUT','TXNMISS','SETMISS'] as const;
  return {
    runId: input.runId, organization: input.organization, profile: input.profile,
    inputs: { transaction: input.transaction, settlement: input.settlement }, executable: false, plan, datasets, steps,
    cleanupManifest: { state: 'PLANNED_NOT_CREATED', automaticCleanupEnabled: false, temporaryDatasetCandidates: temporary.map((key) => plan.datasets[key]), retainedDatasetCandidates: [plan.datasets.FINAL, plan.datasets.EODERROR], policy: 'No cleanup occurs in preview. Future cleanup must use only the exact run manifest after verified report persistence; failed-run diagnostics must be retained.' },
    limitations: [
      'This preview is non-mutating: no dataset is created, no file is transferred, no JCL is submitted, and no reconciliation is run.',
      `Existing ${plan.config.sourceLibrary}(${plan.config.rexxMember}) hardcodes shared TXNSORT/SETSORT names; the orchestrator skips it and uses validated run-specific dataset read-back instead.`,
      'MASTER.jcl and standalone EOD_VALIDATION.jcl contain fixed baseline dataset references and five-record smoke-test assumptions; neither is used as a production-ready arbitrary-size pipeline.',
      'The generated plan templates have not been submitted or validated on z/OS. VSAM creation/load behavior and JCL syntax require mainframe-owner review.',
      `Sequential allocation uses 3390 track sizing (${TRACK_BYTES_3390} bytes/track) with 25% headroom; each upload is capped at ${MAX_UPLOAD_BYTES} bytes. VSAM space uses 50% headroom split across primary/secondary tracks. Confirm the target storage unit and site space policy before use.`,
      'Duplicate settlement keys are preserved by sort and must block VSAM loading; transaction duplicates retain the existing SUM FIELDS=NONE first-record policy.',
      'The deployed COBOL output has no financial totals; no monetary values are calculated or shown by this plan.',
      'The local orchestration state machine, Zowe operation adapter, JES polling, output checks, dynamic EOD planning, persistence mapping, and manifest cleanup are implemented with offline mocks; none has been validated through a real processing job on z/OS, and the API live-execution adapter remains unconfigured.',
    ],
  };
}

function assertDatasetName(value: string, label: string): string {
  const parts = value.split('.');
  if (value.length > 44 || parts.some((part) => part.length < 1 || part.length > 8 || !/^[A-Z#$@][A-Z0-9#$@]*$/i.test(part))) {
    throw new Error(`${label} is not a valid z/OS dataset name.`);
  }
  return value.toUpperCase();
}

export function createRunId(now = new Date()): string {
  return `REC-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(10).toString('hex').toUpperCase()}`;
}

export function createDatasetToken(): string {
  let value = randomInt(TOKEN_SPACE);
  let suffix = '';
  for (let i = 0; i < 7; i += 1) {
    suffix = TOKEN_ALPHABET[value % 36] + suffix;
    value = Math.floor(value / 36);
  }
  return `${TOKEN_LETTERS[randomInt(TOKEN_LETTERS.length)]}${suffix}`;
}

export function buildRunExecutionPlan(runId: string, config: MainframePlanConfig, token: string, inputFiles: { transaction: PlanInputFile; settlement: PlanInputFile }): RunExecutionPlan {
  if (!/^REC-\d{8}-[A-F0-9]{20}$/.test(runId)) throw new Error('Run ID is invalid.');
  if (!/^[A-Z][A-Z0-9]{7}$/.test(token)) throw new Error('Run dataset token is invalid.');
  const hlq = assertDatasetName(config.hlq, 'HLQ');
  if (hlq.includes('.')) throw new Error('HLQ must be one approved dataset qualifier.');
  if (hlq !== PROJECT_RECONCILIATION_HLQ) throw new Error(`Reconciliation datasets must use the assigned ${PROJECT_RECONCILIATION_HLQ} HLQ.`);
  if (!/^[0-9A-Z]$/i.test(config.jobClass)) throw new Error('Job class must be one approved character.');
  const sourceLibrary = assertDatasetName(config.sourceLibrary, 'Source library');
  const loadLibrary = assertDatasetName(config.loadLibrary, 'Load library');
  if (!/^[A-Z0-9#$@]{1,8}$/i.test(config.loadModule) || !/^[A-Z0-9#$@]{1,8}$/i.test(config.rexxMember)) throw new Error('Mainframe member name is invalid.');
  assertAllocationInput('Transaction', inputFiles.transaction);
  assertAllocationInput('Settlement', inputFiles.settlement);
  const datasets = Object.fromEntries(Object.entries(DATASET_SUFFIXES).map(([key, suffix]) => [key, assertDatasetName(`${hlq}.${token}.${suffix}`, `${key} dataset`)])) as RunDatasets;
  return {
    runId,
    token,
    jobName: token,
    config: { ...config, hlq, jobClass: config.jobClass.toUpperCase(), sourceLibrary, loadLibrary, loadModule: config.loadModule.toUpperCase(), rexxMember: config.rexxMember.toUpperCase() },
    inputs: { transaction: { ...inputFiles.transaction }, settlement: { ...inputFiles.settlement } },
    datasets,
    allocation: { ...computeAllocation(inputFiles.transaction, inputFiles.settlement), maximumUploadBytes: MAX_UPLOAD_BYTES },
    duplicatePolicy: { transaction: 'DEDUPLICATE_BY_ID_KEEP_FIRST_AS_EXISTING_MASTER', settlement: 'FAIL_ON_DUPLICATE_KEY_BEFORE_VSAM_LOAD' },
    collisionCheckRequired: true,
    cleanupPolicy: 'RETAIN_PENDING_APPROVAL',
  };
}

function jobCard(name: string, plan: RunExecutionPlan): string {
  return `//${name} JOB ,MSGLEVEL=(2,0),CLASS=${plan.config.jobClass}`;
}

/** JCL for first-stage, run-scoped allocation only. It never deletes an existing dataset. */
export function generateAllocationJcl(plan: RunExecutionPlan): string {
  const allocation = (dd: string, dsn: string, lrecl: 38 | 120 | 80, tracks: number) => [
    `//${dd.padEnd(8)} DD DSN=${dsn},DISP=(NEW,CATLG,KEEP),`,
    `//         SPACE=(TRK,(${tracks})),UNIT=SYSDA,`,
    `//         DCB=(DSORG=PS,RECFM=FB,LRECL=${lrecl},BLKSIZE=0)`,
  ].join('\n');
  return [
    jobCard(plan.jobName, plan),
    '//ALLOC    EXEC PGM=IEFBR14',
    allocation('TXNIN', plan.datasets.TXNIN, 38, plan.allocation.transactionInputTracks),
    allocation('SETIN', plan.datasets.SETIN, 38, plan.allocation.settlementInputTracks),
  ].join('\n');
}

/**
 * First compute stage. The settlement duplicate listing is an explicit gate and
 * the subsequent VSAM load must not be submitted unless this job returns RC=0.
 */
export function generatePreflightJcl(plan: RunExecutionPlan): string {
  const outputDd = (dd: string, dsn: string, lrecl: number, tracks: number) => [
    `//${dd.padEnd(8)} DD DSN=${dsn},DISP=(NEW,CATLG,KEEP),`,
    `//         SPACE=(TRK,(${tracks})),UNIT=SYSDA,`,
    `//         DCB=(DSORG=PS,RECFM=FB,LRECL=${lrecl},BLKSIZE=0)`,
  ].join('\n');
  return [
    jobCard(plan.jobName, plan),
    '//TXNSORT  EXEC PGM=SORT',
    '//SYSOUT   DD SYSOUT=*',
    `//SORTIN   DD DSN=${plan.datasets.TXNIN},DISP=SHR`,
    outputDd('SORTOUT', plan.datasets.TXNSORT, 38, plan.allocation.transactionSortTracks),
    '//SYSIN    DD *',
    '  SORT FIELDS=(1,10,CH,A)',
    '  SUM FIELDS=NONE',
    '/*',
    '//IFTXN    IF (TXNSORT.RC = 0) THEN',
    '//SETSORT  EXEC PGM=SORT',
    '//SYSOUT   DD SYSOUT=*',
    `//SORTIN   DD DSN=${plan.datasets.SETIN},DISP=SHR`,
    outputDd('SORTOUT', plan.datasets.SETSORT, 38, plan.allocation.settlementSortTracks),
    '//SYSIN    DD *',
    '  SORT FIELDS=(1,10,CH,A)',
    '/*',
    '//IFSET    IF (SETSORT.RC = 0) THEN',
    '//DUPSEL   EXEC PGM=ICETOOL',
    '//TOOLMSG  DD SYSOUT=*',
    '//DFSMSG   DD SYSOUT=*',
    `//SETIN    DD DSN=${plan.datasets.SETSORT},DISP=SHR`,
    outputDd('DUPES', plan.datasets.DUPES, 38, plan.allocation.duplicateTracks),
    '//TOOLIN   DD *',
    '  SELECT FROM(SETIN) TO(DUPES) ON(1,10,CH) ALLDUPS',
    '/*',
    '//IFDUP    IF (DUPSEL.RC = 0) THEN',
    '//DUPCNT   EXEC PGM=ICETOOL',
    '//TOOLMSG  DD SYSOUT=*',
    '//DFSMSG   DD SYSOUT=*',
    `//DUPIN    DD DSN=${plan.datasets.DUPES},DISP=SHR`,
    '//TOOLIN   DD *',
    '  COUNT FROM(DUPIN) NOTEQUAL(0) RC8',
    '/*',
    '//ENDIFDP  ENDIF',
    '//ENDIFST  ENDIF',
    '//ENDIFTX  ENDIF',
  ].join('\n');
}

/** Run-specific VSAM and COBOL stage. Submit only after preflight RC=0. */
export function generateReconciliationJcl(plan: RunExecutionPlan): string {
  const output = (dd: string, dsn: string, lrecl: 38 | 120, tracks: number) => [
    `//${dd.padEnd(8)} DD DSN=${dsn},DISP=(NEW,CATLG,KEEP),`,
    `//         SPACE=(TRK,(${tracks})),UNIT=SYSDA,`,
    `//         DCB=(DSORG=PS,RECFM=FB,LRECL=${lrecl},BLKSIZE=0)`,
  ].join('\n');
  return [
    jobCard(plan.jobName, plan),
    '//VSAMCRT  EXEC PGM=IDCAMS',
    '//SYSPRINT DD SYSOUT=*',
    '//SYSIN    DD *',
    '  DEFINE CLUSTER ( -',
    `    NAME(${plan.datasets.SETTLE}) -`,
    `    INDEXED KEYS(10 0) RECORDSIZE(38 38) TRACKS(${plan.allocation.settlementVsamPrimaryTracks} ${plan.allocation.settlementVsamSecondaryTracks}) -`,
    `    DATA (NAME(${plan.datasets.SETTLE_DATA})) -`,
    `    INDEX (NAME(${plan.datasets.SETTLE_INDEX})) )`,
    '/*',
    '//IFCRT    IF (VSAMCRT.RC = 0) THEN',
    '//VSAMLOAD EXEC PGM=IDCAMS',
    '//SYSPRINT DD SYSOUT=*',
    `//INPUT    DD DSN=${plan.datasets.SETSORT},DISP=SHR`,
    '//SYSIN    DD *',
    '  REPRO INFILE(INPUT) OUTDATASET(' + plan.datasets.SETTLE + ')',
    '/*',
    '//IFLOAD   IF (VSAMLOAD.RC = 0) THEN',
    `//RECONCIL EXEC PGM=${plan.config.loadModule}`,
    `//STEPLIB  DD DSN=${plan.config.loadLibrary},DISP=SHR`,
    `//TRANIN   DD DSN=${plan.datasets.TXNSORT},DISP=SHR`,
    `//SETTIN   DD DSN=${plan.datasets.SETTLE},DISP=SHR`,
    output('MATCHOUT', plan.datasets.MATCHOUT, 38, plan.allocation.matchTracks),
    output('MISMOUT', plan.datasets.MISMOUT, 120, plan.allocation.mismatchTracks),
    output('TXNMISS', plan.datasets.TXNMISS, 120, plan.allocation.transactionOnlyTracks),
    output('SETMISS', plan.datasets.SETMISS, 120, plan.allocation.settlementOnlyTracks),
    '//ENDIFLD  ENDIF',
    '//ENDIFCR  ENDIF',
  ].join('\n');
}

export function parseCobolCounts(spool: string): CobolCounts {
  const labels: Array<[keyof CobolCounts, string]> = [
    ['transactionCount', 'TRANSACTION INPUT COUNT'],
    ['settlementCount', 'SETTLEMENT INPUT COUNT'],
    ['matchedCount', 'MATCHED COUNT'],
    ['mismatchedCount', 'MISMATCHED COUNT'],
    ['transactionOnlyCount', 'TRANSACTION-ONLY COUNT'],
    ['settlementOnlyCount', 'SETTLEMENT-ONLY COUNT'],
  ];
  const counts = {} as CobolCounts;
  for (const [key, label] of labels) {
    const match = spool.match(new RegExp(`^\\s*${label}:\\s*(\\d+)\\s*$`, 'im'));
    if (!match) throw new Error(`Required COBOL count is missing: ${label}.`);
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`COBOL count is invalid: ${label}.`);
    counts[key] = value;
  }
  return counts;
}

/** Post-processing helper for verified mainframe MATCHOUT bytes only (not input reconciliation). */
export function aggregateMatchedAmountCents(matchedOutput: Buffer): bigint {
  if (!Buffer.isBuffer(matchedOutput) || matchedOutput.length === 0) throw new Error('Verified MATCHOUT output is empty or unavailable.');
  const text = matchedOutput.toString('ascii');
  const records = text.split('\n');
  if (records.at(-1) === '') records.pop();
  let total = 0n;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!.endsWith('\r') ? records[index]!.slice(0, -1) : records[index]!;
    if (Buffer.byteLength(record, 'ascii') !== 38 || !/^[\x20-\x7e]{20}\d{9}[\x20-\x7e]{9}$/u.test(record)) throw new Error(`MATCHOUT record ${index + 1} does not satisfy the deployed 38-byte output contract.`);
    total += BigInt(record.slice(20, 29));
  }
  return total;
}

/** Counts a downloaded fixed-block data set represented as newline-delimited text, rejecting malformed records. */
export function countDownloadedRecords(downloaded: Buffer, recordLength: 38 | 120): number {
  if (!Buffer.isBuffer(downloaded) || downloaded.length === 0) return 0;
  const records = downloaded.toString('ascii').split('\n');
  if (records.at(-1) === '') records.pop();
  for (const [index, raw] of records.entries()) {
    const record = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (Buffer.byteLength(record, 'ascii') !== recordLength || /[^\x20-\x7e]/u.test(record)) throw new Error(`Downloaded output record ${index + 1} does not satisfy the expected FB/${recordLength} contract.`);
  }
  return records.length;
}

export function countConsistencyError(counts: CobolCounts): string | undefined {
  if (counts.transactionCount !== counts.matchedCount + counts.mismatchedCount + counts.transactionOnlyCount) return 'Transaction count does not equal matched, mismatched and transaction-only counts.';
  if (counts.settlementCount !== counts.matchedCount + counts.mismatchedCount + counts.settlementOnlyCount) return 'Settlement count does not equal matched, mismatched and settlement-only counts.';
  return undefined;
}

export function eodPublicationAllowed(returnCode: number, counts: CobolCounts, actualOutputCounts: Omit<CobolCounts, 'transactionCount' | 'settlementCount'>, duplicateSettlementCount: number): boolean {
  const allCounts = [...Object.values(counts), ...Object.values(actualOutputCounts), duplicateSettlementCount];
  return Number.isInteger(returnCode) && returnCode === 0
    && allCounts.every((count) => Number.isSafeInteger(count) && count >= 0)
    && duplicateSettlementCount === 0
    && !countConsistencyError(counts)
    && counts.matchedCount === actualOutputCounts.matchedCount
    && counts.mismatchedCount === actualOutputCounts.mismatchedCount
    && counts.transactionOnlyCount === actualOutputCounts.transactionOnlyCount
    && counts.settlementOnlyCount === actualOutputCounts.settlementOnlyCount;
}

/** EOD checks compare datasets with values captured from actual COBOL SYSOUT. */
export function generateEodJcl(plan: RunExecutionPlan, counts: CobolCounts, reconciliationReturnCode: number): string {
  if (countConsistencyError(counts)) throw new Error('Cannot generate EOD JCL from inconsistent COBOL counts.');
  if (!Number.isInteger(reconciliationReturnCode) || reconciliationReturnCode < 0) throw new Error('Reconciliation return code is invalid.');
  const countStep = (step: string, dd: string, dsn: string, expected: number) => [
    `//${step.padEnd(8)} EXEC PGM=ICETOOL`,
    '//TOOLMSG  DD SYSOUT=*',
    '//DFSMSG   DD SYSOUT=*',
    `//${dd.padEnd(8)} DD DSN=${dsn},DISP=SHR`,
    '//TOOLIN   DD *',
    `  COUNT FROM(${dd}) NOTEQUAL(${expected}) RC8`,
    '/*',
  ].join('\n');
  const outputs: Array<[string, string, string, number]> = [
    ['TXNCHK', 'TXNIN', plan.datasets.TXNSORT, counts.transactionCount],
    ['SETCHK', 'SETIN', plan.datasets.SETSORT, counts.settlementCount],
    ['MATCHCT', 'MATCHIN', plan.datasets.MATCHOUT, counts.matchedCount],
    ['MISCT', 'MISM', plan.datasets.MISMOUT, counts.mismatchedCount],
    ['TNMCT', 'TNMIN', plan.datasets.TXNMISS, counts.transactionOnlyCount],
    ['STMCT', 'STMIN', plan.datasets.SETMISS, counts.settlementOnlyCount],
  ];
  const finalGate = `//PUBOK    IF (&RECONRC = 0 & TXNCHK.RC = 0 & SETCHK.RC = 0 &\n//            MATCHCT.RC = 0 & MISCT.RC = 0 & TNMCT.RC = 0 &\n//            STMCT.RC = 0) THEN\n//FINALCP  EXEC PGM=IEBGENER\n//SYSUT1   DD DSN=${plan.datasets.MATCHOUT},DISP=SHR\n//SYSUT2   DD DSN=${plan.datasets.FINAL},DISP=(NEW,CATLG,KEEP),\n//            SPACE=(TRK,(${plan.allocation.finalTracks})),UNIT=SYSDA,\n//            DCB=(DSORG=PS,RECFM=FB,LRECL=38,BLKSIZE=0)\n//SYSPRINT DD SYSOUT=*\n//SYSIN    DD DUMMY\n//PUBEND   ENDIF`;
  const failureMarker = `//EODFAIL  IF (&RECONRC > 0 | TXNCHK.RC > 0 | SETCHK.RC > 0 |\n//            MATCHCT.RC > 0 | MISCT.RC > 0 | TNMCT.RC > 0 |\n//            STMCT.RC > 0 | FINALCP.RC > 0) THEN\n//ERRWRITE EXEC PGM=IEBGENER\n//SYSUT1   DD *\nEOD VALIDATION FAILED - FINAL OUTPUT NOT PUBLISHED\n/*\n//SYSUT2   DD DSN=${plan.datasets.EODERROR},DISP=(NEW,CATLG,KEEP),\n//            SPACE=(TRK,(1)),UNIT=SYSDA,\n//            DCB=(DSORG=PS,RECFM=FB,LRECL=80,BLKSIZE=0)\n//SYSPRINT DD SYSOUT=*\n//SYSIN    DD DUMMY\n//FAILEND  ENDIF`;
  return [
    jobCard(plan.jobName, plan),
    `// SET RECONRC=${reconciliationReturnCode}`,
    ...outputs.map(([step, dd, dsn, expected]) => countStep(step, dd, dsn, expected)),
    finalGate,
    failureMarker,
  ].join('\n');
}

export const RUN_DATASET_SUFFIXES = Object.keys(DATASET_SUFFIXES) as Array<keyof typeof DATASET_SUFFIXES>;
