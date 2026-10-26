import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  aggregateMatchedAmountCents,
  countConsistencyError,
  countDownloadedRecords,
  eodPublicationAllowed,
  generateAllocationJcl,
  generateEodJcl,
  generatePreflightJcl,
  generateReconciliationJcl,
  parseCobolCounts,
  type CobolCounts,
  type ExecutionPlanPreview,
  type RunExecutionPlan,
} from './executionPlan.js';
import type { RunStatus, TestProfile } from './types.js';
import { sanitizeText } from './observability.js';

export type OrchestrationDataset = { name: string; purpose: string; retained?: boolean; state: 'PLANNED' | 'CREATING' | 'CREATED' | 'UNKNOWN' | 'CLEANING' | 'CLEANED' | 'CLEANUP_FAILED' };
export type OrchestrationJob = { stage: string; jobId?: string; submittedAt?: Date; status?: string; returnCode?: number | null; conditionCode?: string; completedAt?: Date; spoolRetrieved?: boolean };
export type OrchestrationInput = { uploadId: string; stagedPath?: string; originalName: string; size: number; sha256: string; recordCount: number; valid: boolean };
export type ReconciliationOutputReference = { key: string; dataset: string; localPath: string; recordLength: number; recordCount: number; sha256: string };
export type ReconciliationOperation = {
  runId: string; operationId: string; idempotencyKey: string; organizationId: string; organizationName: string; actorId: string; profile: TestProfile;
  status: RunStatus; stage: string; createdAt: Date; updatedAt: Date; completedAt?: Date;
  inputs: { transaction: OrchestrationInput; settlement: OrchestrationInput }; plan: RunExecutionPlan;
  datasets: OrchestrationDataset[]; transitions: Array<{ status: RunStatus; stage: string; at: Date }>;
  jobs: OrchestrationJob[]; stageResults: Record<string, unknown>; summary?: CobolCounts & { matchedAmountCents?: string };
  outputReferences: ReconciliationOutputReference[];
  diagnostics: string[]; failure?: { stage: string; category: string; message: string }; cleanup: { status: 'NOT_STARTED' | 'COMPLETED' | 'WARNING' | 'RETAINED'; failedDatasets: string[] };
};

export interface ReconciliationStore {
  createIfAbsent(operation: ReconciliationOperation): Promise<boolean>;
  save(operation: ReconciliationOperation): Promise<void>;
  get(runId: string): Promise<ReconciliationOperation | undefined>;
}

export type RemoteJobStatus = { jobId: string; status: string; returnCode: number | null; conditionCode?: string };
export interface ReconciliationRemote {
  attributes(dataset: string): Promise<{ dsname: string; dsorg?: string; recfm?: string; lrecl?: number }>;
  createSequential(dataset: string, primaryTracks: number, secondaryTracks: number): Promise<void>;
  uploadSequential(dataset: string, localPath: string): Promise<void>;
  downloadDataset(dataset: string, localPath: string): Promise<void>;
  deleteDataset(dataset: string): Promise<void>;
  deleteVsamCluster(dataset: string): Promise<void>;
  submitJcl(localPath: string): Promise<{ jobId: string }>;
  jobStatus(jobId: string): Promise<RemoteJobStatus>;
  jobSpool(jobId: string): Promise<string>;
}

export type OrchestrationDependencies = {
  store: ReconciliationStore; remote: ReconciliationRemote; stagingRoot: string; reportRoot?: string; now?: () => Date;
  executionGate: () => { canExecute: boolean; blockers: string[] };
  readiness: () => Promise<{ state: string; message?: string }>;
  /** Must positively verify the configured program member; a present load library alone is insufficient. */
  verifyLoadModule?: (library: string, member: string) => Promise<{ verified: boolean; evidence?: string; message?: string }>;
  maxJobWaitMs?: number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void>;
};

const TERMINAL = new Set<RunStatus>(['COMPLETED', 'COMPLETED_WITH_EXCEPTIONS', 'BUSINESS_EXCEPTION', 'FAILED', 'NOT_CONFIGURED', 'AWAITING_RECOVERY']);
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const RECONCILIATION_INPUT_KEYS = ['TXNSORT', 'SETSORT'] as const;
const RECONCILIATION_OUTPUT_KEYS = ['SETTLE', 'SETTLE_DATA', 'SETTLE_INDEX', 'MATCHOUT', 'MISMOUT', 'TXNMISS', 'SETMISS'] as const;

export type ReconciliationReadinessEvidence = {
  sortedInputs: Partial<Record<typeof RECONCILIATION_INPUT_KEYS[number], { dataset: string; state: 'PRESENT' | 'ABSENT' | 'UNKNOWN'; dsorg?: string; recfm?: string; lrecl?: number }>>;
  loadModule: { library: string; member: string; verified: boolean; evidence?: string };
  outputConflicts: Partial<Record<typeof RECONCILIATION_OUTPUT_KEYS[number], 'ABSENT' | 'PRESENT' | 'UNKNOWN'>>;
};

/** Readiness requires actual run-specific sort inputs, a positively verified module,
 * and confirmed absence of every VSAM/COBOL output name before the JCL is submitted. */
export function reconciliationReadinessBlockers(plan: RunExecutionPlan, evidence: ReconciliationReadinessEvidence): string[] {
  validateOwnedPlan(plan);
  const blockers: string[] = [];
  for (const key of RECONCILIATION_INPUT_KEYS) {
    const item = evidence.sortedInputs[key]; const expected = plan.datasets[key];
    if (!item || item.state !== 'PRESENT' || item.dataset.toUpperCase() !== expected || item.dsorg?.toUpperCase() !== 'PS' || item.recfm?.toUpperCase() !== 'FB' || item.lrecl !== 38) {
      blockers.push(`${expected} must be confirmed present as PS/FB/LRECL=38 before reconciliation.`);
    }
  }
  const module = evidence.loadModule;
  if (!module.verified || module.library.toUpperCase() !== plan.config.loadLibrary || module.member.toUpperCase() !== plan.config.loadModule || !module.evidence?.trim()) {
    blockers.push(`${plan.config.loadLibrary}(${plan.config.loadModule}) must be positively verified; load-library existence alone is insufficient.`);
  }
  for (const key of RECONCILIATION_OUTPUT_KEYS) {
    const state = evidence.outputConflicts[key];
    if (state !== 'ABSENT') blockers.push(`${plan.datasets[key]} must be confirmed absent before the reconciliation JCL can allocate or define it${state === 'PRESENT' ? ' (name conflict)' : ''}.`);
  }
  return blockers;
}

function fail(category: string, message: string): Error { return Object.assign(new Error(message), { code: category }); }

/** Allocation and output capacity are derived from these same uploaded-file facts. */
function validatePlanInputMetadata(plan: RunExecutionPlan, inputs: { transaction: OrchestrationInput; settlement: OrchestrationInput }): void {
  for (const kind of ['transaction', 'settlement'] as const) {
    const planned = plan.inputs?.[kind]; const supplied = inputs[kind];
    if (!planned || planned.originalName !== supplied.originalName || planned.size !== supplied.size || planned.recordCount !== supplied.recordCount || planned.valid !== supplied.valid) {
      throw fail('PLAN_INPUT_MISMATCH', `The ${kind} upload metadata does not match the input metadata used to create this run's dataset allocation plan.`);
    }
  }
}

function validateOwnedPlan(plan: RunExecutionPlan): void {
  if (plan.config.hlq !== 'Z73968' || !/^[A-Z][A-Z0-9]{7}$/.test(plan.token)) throw fail('NAMESPACE_REJECTED', 'Project reconciliation resources must use the assigned Z73968 namespace and a valid unique run qualifier.');
  const values = Object.values(plan.datasets);
  if (new Set(values).size !== values.length || values.some((name) => {
    const parts = name.split('.');
    return name.startsWith('ZXP.PUBLIC.') || !name.startsWith(`Z73968.${plan.token}.`) || name.length > 44 || parts.some((part) => !/^[A-Z#$@][A-Z0-9#$@]{0,7}$/.test(part));
  })) throw fail('NAMESPACE_REJECTED', 'The run dataset manifest is invalid or escapes its unique Z73968 run namespace.');
}

function validateGeneratedJcl(jcl: string, plan: RunExecutionPlan): void {
  const allow = new Set([...Object.values(plan.datasets), plan.config.loadLibrary]);
  if (!jcl || jcl.includes('\0') || jcl.includes('\r')) throw fail('JCL_INVALID', 'Generated JCL contains invalid control characters.');
  for (const line of jcl.split('\n')) {
    if (line.length > 71) throw fail('JCL_INVALID', 'Generated JCL exceeds the 71-column statement area.');
    for (const match of line.matchAll(/(?:DSN=|NAME\(|OUTDATASET\()([A-Z0-9#$@.]+)/gi)) {
      const dsn = match[1]!.toUpperCase();
      const parts = dsn.split('.');
      if (!allow.has(dsn) || dsn.startsWith('ZXP.PUBLIC.') || parts.some((part) => !/^[A-Z#$@][A-Z0-9#$@]{0,7}$/.test(part))) throw fail('JCL_DATASET_REJECTED', 'Generated JCL references a dataset outside the exact run manifest and approved read-only load library.');
    }
  }
}

/** Static source-contract check only; it does not validate z/OS JCL syntax. */
export function assertRunScopedJclContract(plan: RunExecutionPlan, stage: 'allocation' | 'preflight' | 'reconciliation' | 'eod', jcl: string): void {
  validateOwnedPlan(plan);
  if (/ZXP\.PUBLIC\.|Z73968\.BANK\.|\bREPLACE\b/i.test(jcl)) throw fail('JCL_SHARED_RESOURCE_REJECTED', 'Generated JCL contains a shared/baseline namespace or replacement operation.');
  validateGeneratedJcl(jcl, plan);
  const requireText = (text: string) => { if (!jcl.includes(text)) throw fail('JCL_CONTRACT_INVALID', `Generated ${stage} JCL is missing a required source-backed contract: ${text}.`); };
  if (stage === 'allocation') {
    requireText(`DSN=${plan.datasets.TXNIN}`); requireText(`DSN=${plan.datasets.SETIN}`); requireText('DISP=(NEW,CATLG,KEEP)');
  } else if (stage === 'preflight') {
    requireText(`SORTIN   DD DSN=${plan.datasets.TXNIN}`); requireText(`SORTIN   DD DSN=${plan.datasets.SETIN}`);
    requireText('SORT FIELDS=(1,10,CH,A)'); requireText('SUM FIELDS=NONE');
    requireText('IF (TXNSORT.RC = 0) THEN'); requireText('IF (SETSORT.RC = 0) THEN'); requireText('IF (DUPSEL.RC = 0) THEN');
  } else if (stage === 'reconciliation') {
    requireText(`IF (VSAMCRT.RC = 0) THEN`); requireText(`IF (VSAMLOAD.RC = 0) THEN`);
    requireText(`TRANIN   DD DSN=${plan.datasets.TXNSORT}`); requireText(`SETTIN   DD DSN=${plan.datasets.SETTLE}`);
    for (const dd of ['MATCHOUT','MISMOUT','TXNMISS','SETMISS']) requireText(`//${dd.padEnd(8)} DD DSN=${plan.datasets[dd as keyof typeof plan.datasets]}`);
    requireText(`STEPLIB  DD DSN=${plan.config.loadLibrary},DISP=SHR`);
  } else {
    requireText(`// SET RECONRC=`); requireText(`DSN=${plan.datasets.FINAL}`); requireText('COUNT FROM(');
    if (jcl.includes('NOTEQUAL(5)')) throw fail('JCL_FIXED_COUNT_REJECTED', 'EOD JCL must use counts derived from the actual run.');
  }
}

function buildOwnedManifest(plan: RunExecutionPlan): OrchestrationDataset[] {
  return Object.entries(plan.datasets).map(([key, name]) => ({ name, purpose: key, ...(key === 'FINAL' ? { retained: true } : {}), state: 'PLANNED' as const }));
}

export function createReconciliationOperation(input: {
  runId: string; idempotencyKey: string; organizationId: string; organizationName: string; actorId: string; profile: TestProfile;
  transaction: OrchestrationInput; settlement: OrchestrationInput; plan: RunExecutionPlan; now?: Date;
}): ReconciliationOperation {
  validateOwnedPlan(input.plan);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey) || !input.organizationId || !input.organizationName.trim() || !input.actorId) throw fail('REQUEST_INVALID', 'A valid idempotency key, organization and authenticated actor are required.');
  for (const [kind, file] of [['transaction', input.transaction], ['settlement', input.settlement]] as const) {
    if (!file.valid || !/^[0-9a-f-]{36}$/i.test(file.uploadId) || !/^[a-f0-9]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 10 * 1024 * 1024 || !Number.isSafeInteger(file.recordCount) || file.recordCount < 1 || file.size < file.recordCount * 38 || file.size > file.recordCount * 40 || typeof file.stagedPath !== 'string' || !/^[0-9a-f-]{36}\.txt$/i.test(path.basename(file.stagedPath))) throw fail('INPUT_METADATA_INVALID', `${kind} upload metadata is invalid.`);
  }
  validatePlanInputMetadata(input.plan, { transaction: input.transaction, settlement: input.settlement });
  const at = input.now ?? new Date();
  return { runId: input.runId, operationId: input.runId, idempotencyKey: input.idempotencyKey, organizationId: input.organizationId, organizationName: input.organizationName, actorId: input.actorId, profile: input.profile, status: 'RECEIVED', stage: 'REQUEST_VALIDATION', createdAt: at, updatedAt: at, inputs: { transaction: input.transaction, settlement: input.settlement }, plan: input.plan, datasets: buildOwnedManifest(input.plan), transitions: [{ status: 'RECEIVED', stage: 'REQUEST_VALIDATION', at }], jobs: [], stageResults: {}, outputReferences: [], diagnostics: [], cleanup: { status: 'NOT_STARTED', failedDatasets: [] } };
}

async function persistStage(operation: ReconciliationOperation, deps: OrchestrationDependencies, status: RunStatus, stage: string): Promise<void> {
  const at = (deps.now ?? (() => new Date()))(); operation.status = status; operation.stage = stage; operation.updatedAt = at; operation.transitions.push({ status, stage, at }); await deps.store.save(operation);
}

async function verifyInput(input: OrchestrationInput, root: string): Promise<{ original: Buffer; transfer: string }> {
  if (!input.stagedPath) throw fail('STAGED_INPUT_UNAVAILABLE', 'The staged source file is no longer available; recovery cannot resubmit this run.');
  const file = path.resolve(input.stagedPath); const staging = path.resolve(root); const relative = path.relative(staging, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(file) !== staging || path.basename(file) !== `${input.uploadId}.txt`) throw fail('STAGED_INPUT_INVALID', 'An input file is outside its approved temporary staging directory.');
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try { stat = await fs.lstat(file); }
  catch (error) { throw stagedInputUnavailable(error); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.size || stat.size > 10 * 1024 * 1024) throw fail('STAGED_INPUT_CHANGED', 'An input file is missing or its saved size changed.');
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); }
  catch (error) { throw stagedInputUnavailable(error); }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw fail('STAGED_INPUT_CHANGED', 'An input file no longer matches its saved SHA-256.');
  const source = bytes.toString('utf8'); if (source.startsWith('\uFEFF') || source.includes('\uFFFD') || !Buffer.from(source, 'utf8').equals(bytes)) throw fail('INPUT_ENCODING_INVALID', 'Inputs must be UTF-8/ASCII fixed-width records without a BOM.');
  const records = source.split('\n'); const trailingLineFeed = records.at(-1) === ''; if (trailingLineFeed) records.pop();
  const normalized = records.map((record, index) => (index < records.length - 1 || trailingLineFeed) && record.endsWith('\r') ? record.slice(0, -1) : record);
  if (!normalized.length || normalized.some((record) => record.length !== 38 || /[^\x20-\x7e]/.test(record)) || normalized.length !== input.recordCount) throw fail('INPUT_RECORD_CONTRACT_INVALID', 'Input records must be non-empty printable 38-byte records matching the saved count.');
  const transfer = path.join(staging, `${crypto.randomUUID()}.txt`); await fs.writeFile(transfer, `${normalized.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  return { original: bytes, transfer };
}

function stagedInputUnavailable(error: unknown): Error {
  const rawCode = (error as NodeJS.ErrnoException | undefined)?.code;
  const code = typeof rawCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(rawCode) ? rawCode : 'FILE_ACCESS_ERROR';
  return fail('STAGED_INPUT_UNAVAILABLE', `The staged source file could not be verified (${code}); no remote operation was started.`);
}

async function submitAndWait(operation: ReconciliationOperation, deps: OrchestrationDependencies, stage: string, jcl: string, acceptedRc: number[]): Promise<{ status: RemoteJobStatus; spool: string }> {
  validateGeneratedJcl(jcl, operation.plan);
  const jclPath = path.join(path.resolve(deps.stagingRoot), `${crypto.randomUUID()}.jcl`); await fs.writeFile(jclPath, jcl, { flag: 'wx', mode: 0o600 });
  let submitted: { jobId: string };
  try {
    submitted = await deps.remote.submitJcl(jclPath);
  } catch (error) {
    operation.status = 'AWAITING_RECOVERY'; operation.stage = `${stage}_SUBMISSION_UNCERTAIN`; operation.failure = { stage, category: safeCategory(error), message: 'Submission outcome is unknown; inspect JES before any retry.' }; operation.updatedAt = (deps.now ?? (() => new Date()))(); operation.transitions.push({ status: operation.status, stage: operation.stage, at: operation.updatedAt }); await deps.store.save(operation); throw fail('SUBMISSION_UNCERTAIN', 'JCL submission outcome is unknown; the operation was not resubmitted.');
  } finally { await fs.unlink(jclPath).catch(() => undefined); }
  const job: OrchestrationJob = { stage, jobId: submitted.jobId, submittedAt: (deps.now ?? (() => new Date()))(), status: 'SUBMITTED' };
  operation.jobs.push(job); operation.updatedAt = job.submittedAt!; await deps.store.save(operation); // Persist real ID before polling.
  const waitMs = deps.maxJobWaitMs ?? 15 * 60_000; const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = Date.now(); let delay = deps.pollIntervalMs ?? 1000; let status: RemoteJobStatus | undefined;
  while (Date.now() - started < waitMs) {
    try { status = await deps.remote.jobStatus(submitted.jobId); }
    catch {
      operation.status = 'AWAITING_RECOVERY'; operation.stage = `${stage}_STATUS_UNRESOLVED`; operation.failure = { stage, category: 'JES_STATUS_UNAVAILABLE', message: 'The submitted job status could not be confirmed. Inspect JES; this run will not be resubmitted.' }; operation.updatedAt = (deps.now ?? (() => new Date()))(); operation.transitions.push({ status: operation.status, stage: operation.stage, at: operation.updatedAt }); await deps.store.save(operation); throw fail('JES_STATUS_UNAVAILABLE', 'The submitted job status is unresolved; do not resubmit.');
    }
    if (status.jobId !== submitted.jobId) throw fail('JES_JOB_MISMATCH', 'JES returned a different job identifier.');
    job.status = sanitizeText(status.status, 40); job.returnCode = status.returnCode; job.conditionCode = status.conditionCode; operation.updatedAt = (deps.now ?? (() => new Date()))(); await deps.store.save(operation);
    if (status.status === 'OUTPUT') break;
    if (['ABEND','CANCELED','CANCELLED','JCL ERROR'].includes(status.status.toUpperCase())) break;
    await sleep(Math.min(delay, Math.max(1, waitMs - (Date.now() - started)))); delay = Math.min(delay * 2, 10_000);
  }
    if (status && ['ABEND','CANCELED','CANCELLED','JCL ERROR'].includes(status.status.toUpperCase())) {
      job.status = status.status; job.returnCode = status.returnCode; job.completedAt = (deps.now ?? (() => new Date()))(); await deps.store.save(operation);
      throw fail('JES_JOB_FAILED', `${stage} ended in JES status ${status.status}.`);
    }
    if (!status || status.status !== 'OUTPUT') {
    operation.status = 'AWAITING_RECOVERY'; operation.stage = `${stage}_STATUS_UNRESOLVED`; operation.failure = { stage, category: 'JES_UNRESOLVED', message: 'JES did not confirm terminal OUTPUT within the bounded wait; do not resubmit.' }; operation.updatedAt = (deps.now ?? (() => new Date()))(); operation.transitions.push({ status: operation.status, stage: operation.stage, at: operation.updatedAt }); await deps.store.save(operation); throw fail('JES_UNRESOLVED', 'JES completion was not established within the bounded wait.');
  }
  if (status.returnCode === null || !acceptedRc.includes(status.returnCode)) throw fail('JES_RETURN_CODE_REJECTED', `${stage} completed with a return code that is not accepted for the next stage.`);
  const spool = await deps.remote.jobSpool(submitted.jobId); if (!spool.trim()) throw fail('JES_SPOOL_MISSING', `${stage} completed without retrievable spool evidence.`);
  job.spoolRetrieved = true; job.completedAt = (deps.now ?? (() => new Date()))(); await deps.store.save(operation);
  return { status, spool };
}

function checkInputFile(pathname: string, expectedCount: number | undefined, length: 38 | 120): Promise<{ bytes: Buffer; count: number; sha256: string; records: string[] }> {
  return fs.readFile(pathname).then((bytes) => {
    if (bytes.length > MAX_DOWNLOAD_BYTES || (expectedCount !== undefined && expectedCount > 0 && !bytes.length)) throw fail('OUTPUT_INVALID', 'A downloaded mainframe output is empty or exceeds its size limit.');
    const count = countDownloadedRecords(bytes, length); if (expectedCount !== undefined && count !== expectedCount) throw fail('OUTPUT_COUNT_MISMATCH', `Downloaded output record count (${count}) did not match verified JES summary (${expectedCount}).`);
    const records = bytes.toString('ascii').split('\n'); if (records.at(-1) === '') records.pop();
    return { bytes, count, records: records.map((row) => row.endsWith('\r') ? row.slice(0, -1) : row), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
}

async function retainVerifiedOutput(operation: ReconciliationOperation, deps: OrchestrationDependencies, key: string, dataset: string, temporaryPath: string, recordLength: number, recordCount: number, sha256: string): Promise<ReconciliationOutputReference> {
  if (!/^(?:DUPES|MATCHOUT|MISMOUT|TXNMISS|SETMISS|FINAL)$/.test(key) || !/^REC-\d{8}-[A-F0-9]{20}$/.test(operation.runId)) throw fail('OUTPUT_REFERENCE_INVALID', 'Run output type or identifier is invalid for report storage.');
  const root = path.resolve(deps.reportRoot ?? path.join(deps.stagingRoot, '.reports'));
  const directory = path.resolve(root, operation.runId); const relative = path.relative(root, directory);
  if (relative !== operation.runId || path.isAbsolute(relative) || relative.startsWith('..')) throw fail('OUTPUT_REFERENCE_INVALID', 'Report output path escaped its configured root.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const localPath = path.join(directory, `${key}.txt`);
  await fs.copyFile(temporaryPath, localPath, fsConstants.COPYFILE_EXCL); await fs.chmod(localPath, 0o600);
  return { key, dataset, localPath, recordLength, recordCount, sha256 };
}

/**
 * Durable multi-job execution. It is dependency-injected for offline tests. The
 * production API must additionally pass the administrator gate; the installed
 * adapter intentionally remains unconfigured until generated JCL is target-verified.
 */
export async function executeReconciliation(operation: ReconciliationOperation, deps: OrchestrationDependencies): Promise<ReconciliationOperation> {
  const existing = await deps.store.get(operation.runId);
  if (existing) {
    if (existing.idempotencyKey !== operation.idempotencyKey) throw fail('DUPLICATE_RUN', 'This run identifier is already owned by a different request.');
    if (existing.status === 'AWAITING_RECOVERY' || existing.jobs.some((job) => job.jobId && !job.spoolRetrieved)) return existing;
    if (TERMINAL.has(existing.status)) return existing;
    throw fail('OPERATION_IN_PROGRESS', 'An operation with this run identifier is already in progress.');
  }
  validateOwnedPlan(operation.plan);
  validatePlanInputMetadata(operation.plan, operation.inputs);
  if (!await deps.store.createIfAbsent(operation)) {
    const durable = await deps.store.get(operation.runId);
    if (!durable) throw fail('DURABLE_RUN_UNAVAILABLE', 'A run with this identifier already exists but its durable state could not be reloaded; no remote work was started.');
    return durable;
  }
  const copies: string[] = []; const downloads: string[] = [];
  try {
    await persistStage(operation, deps, 'PREFLIGHT', 'INPUT_VALIDATION');
    const gate = deps.executionGate(); if (!gate.canExecute) { operation.diagnostics.push(...gate.blockers.map((item) => sanitizeText(item, 180))); throw fail('MAINFRAME_NOT_CONFIGURED', 'Reconciliation execution is blocked by server-side configuration or validation gates.'); }
    const verified = {
      transaction: await verifyInput(operation.inputs.transaction, deps.stagingRoot),
      settlement: await verifyInput(operation.inputs.settlement, deps.stagingRoot),
    };
    copies.push(verified.transaction.transfer, verified.settlement.transfer);
    await persistStage(operation, deps, 'PREFLIGHT', 'EXECUTION_READINESS');
    const ready = await deps.readiness(); if (ready.state !== 'DATASET_ACCESS_VERIFIED') throw fail('MAINFRAME_NOT_READY', ready.message ?? 'Read-only mainframe readiness did not pass.');
    const moduleCheck = deps.verifyLoadModule
      ? await deps.verifyLoadModule(operation.plan.config.loadLibrary, operation.plan.config.loadModule)
      : { verified: false, message: 'No approved read-only load-module member verifier is configured.' };
    const loadModuleVerified = moduleCheck.verified === true && Boolean(moduleCheck.evidence?.trim());
    operation.stageResults.readinessPrerequisites = {
      loadModule: { library: operation.plan.config.loadLibrary, member: operation.plan.config.loadModule, verified: loadModuleVerified, evidence: moduleCheck.evidence ? sanitizeText(moduleCheck.evidence, 160) : undefined },
      state: loadModuleVerified ? 'PENDING_DATASET_CHECKS' : 'BLOCKED',
      blockers: loadModuleVerified ? [] : [sanitizeText(moduleCheck.message ?? 'RECONCIL load module is not verified.', 180)],
    };
    await deps.store.save(operation);
    if (!loadModuleVerified) throw fail('RECONCILIATION_READINESS_BLOCKED', `Required load module ${operation.plan.config.loadLibrary}(${operation.plan.config.loadModule}) is not positively verified.`);
    const plannedNames = Object.values(operation.plan.datasets);
    await persistStage(operation, deps, 'PREFLIGHT', 'DATASET_COLLISION_CHECK');
    for (const dataset of plannedNames) {
      try { await deps.remote.attributes(dataset); throw fail('DATASET_COLLISION', `Run dataset ${dataset} already exists; it was not overwritten.`); }
      catch (error) { if ((error as { code?: string }).code !== 'DATASET_NOT_FOUND') throw error; }
    }
    operation.stageResults.initialDatasetPreflight = { status: 'ABSENCE_CONFIRMED', checkedDatasets: plannedNames };
    await deps.store.save(operation);
    // Allocation JCL itself is run-specific and DISP=NEW. Only its two input
    // data sets are created here; later stages create outputs through their JCL.
    await persistStage(operation, deps, 'ALLOCATING', 'ALLOCATING_INPUTS');
    const allocation = generateAllocationJcl(operation.plan); assertRunScopedJclContract(operation.plan, 'allocation', allocation);
    operation.datasets.filter((item) => ['TXNIN','SETIN'].some((s) => item.name.endsWith(`.${s}`))).forEach((item) => { item.state = 'CREATING'; }); await deps.store.save(operation);
    const allocated = await submitAndWait(operation, deps, 'ALLOCATING_INPUTS', allocation, [0]);
    operation.stageResults.allocationJob = { jobId: operation.jobs.at(-1)?.jobId, status: allocated.status.status, returnCode: allocated.status.returnCode };
    for (const item of operation.datasets.filter((candidate) => ['TXNIN','SETIN'].some((s) => candidate.name.endsWith(`.${s}`)))) {
      const attributes = await deps.remote.attributes(item.name);
      if (attributes.dsname.toUpperCase() !== item.name || attributes.dsorg?.toUpperCase() !== 'PS' || attributes.recfm?.toUpperCase() !== 'FB' || attributes.lrecl !== 38) { item.state = 'UNKNOWN'; await deps.store.save(operation); throw fail('ALLOCATED_DATASET_INVALID', 'Allocated input dataset attributes were not verified as PS/FB/38.'); }
      item.state = 'CREATED'; await deps.store.save(operation);
    }
    await deps.store.save(operation);
    for (const [kind, dataset, input] of [['transaction', operation.plan.datasets.TXNIN, verified.transaction], ['settlement', operation.plan.datasets.SETIN, verified.settlement]] as const) {
      await persistStage(operation, deps, 'UPLOADING', `UPLOAD_${kind.toUpperCase()}`); await deps.remote.uploadSequential(dataset, input.transfer);
      const localReadback = path.join(path.resolve(deps.stagingRoot), `${crypto.randomUUID()}.out`); downloads.push(localReadback); await deps.remote.downloadDataset(dataset, localReadback);
      const readback = await checkInputFile(localReadback, operation.inputs[kind].recordCount, 38);
      const expected = kind === 'transaction' ? verified.transaction.original : verified.settlement.original;
      const normalized = expected.toString('utf8').replace(/\r\n?/g, '\n').replace(/\n?$/, '\n');
      const returned = readback.bytes.toString('utf8').replace(/\r\n?/g, '\n').replace(/\n?$/, '\n');
      if (normalized !== returned) throw fail('UPLOAD_READBACK_MISMATCH', `${kind} mainframe read-back differs from its validated staged records.`);
      operation.stageResults[`upload_${kind}`] = { verified: true, recordCount: readback.count, sha256: readback.sha256, remoteDataset: dataset }; await deps.store.save(operation);
    }
    // REXX VALIDATE is not called: its checked-in source hardcodes shared BANK datasets.
    // Remote read-back validates inputs; post-sort checks below validate the generated run outputs.
    await persistStage(operation, deps, 'SORTING', 'SORT_AND_DUPLICATE_PREFLIGHT');
    operation.datasets.filter((item) => ['TXNSORT','SETSORT','DUPES'].some((s) => item.name.endsWith(`.${s}`))).forEach((item) => { item.state = 'CREATING'; }); await deps.store.save(operation);
    const preflightJcl = generatePreflightJcl(operation.plan); assertRunScopedJclContract(operation.plan, 'preflight', preflightJcl);
    const preflight = await submitAndWait(operation, deps, 'SORT_AND_DUPLICATE_PREFLIGHT', preflightJcl, [0, 8]);
    const sortedTxnPath = path.join(path.resolve(deps.stagingRoot), `${crypto.randomUUID()}.out`); const sortedSetPath = path.join(path.resolve(deps.stagingRoot), `${crypto.randomUUID()}.out`); const dupPath = path.join(path.resolve(deps.stagingRoot), `${crypto.randomUUID()}.out`); downloads.push(sortedTxnPath, sortedSetPath, dupPath);
    await deps.remote.downloadDataset(operation.plan.datasets.TXNSORT, sortedTxnPath); await deps.remote.downloadDataset(operation.plan.datasets.SETSORT, sortedSetPath); await deps.remote.downloadDataset(operation.plan.datasets.DUPES, dupPath);
    const sortedTransactions = await checkInputFile(sortedTxnPath, undefined, 38);
    const sortedSettlements = await checkInputFile(sortedSetPath, operation.inputs.settlement.recordCount, 38);
    const txCount = sortedTransactions.count; const setCount = sortedSettlements.count;
    if (txCount < 1 || txCount > operation.inputs.transaction.recordCount || sortedTransactions.records.some((record, index, rows) => index > 0 && rows[index - 1]!.slice(0, 10) > record.slice(0, 10))) throw fail('TRANSACTION_SORT_OUTPUT_INVALID', 'Sorted transaction output count or transaction-ID ordering is invalid.');
    if (sortedSettlements.records.some((record, index, rows) => index > 0 && rows[index - 1]!.slice(0, 10) > record.slice(0, 10))) throw fail('SETTLEMENT_SORT_OUTPUT_INVALID', 'Sorted settlement output ordering is invalid.');
    const duplicateStat = await fs.stat(dupPath); if (duplicateStat.size > MAX_DOWNLOAD_BYTES) throw fail('DUPLICATE_EVIDENCE_INVALID', 'Duplicate evidence exceeds its configured size limit.');
    const duplicateCount = duplicateStat.size ? countDownloadedRecords(await fs.readFile(dupPath), 38) : 0;
    operation.stageResults.sort = { jobId: operation.jobs.at(-1)?.jobId, status: preflight.status.status, returnCode: preflight.status.returnCode, transactionSortedCount: txCount, settlementSortedCount: setCount, duplicateSettlementCount: duplicateCount };
    await deps.store.save(operation);
    if (duplicateCount > 0) { const evidence = await retainVerifiedOutput(operation, deps, 'DUPES', operation.plan.datasets.DUPES, dupPath, 38, duplicateCount, crypto.createHash('sha256').update(await fs.readFile(dupPath)).digest('hex')); operation.outputReferences.push(evidence); operation.status = 'BUSINESS_EXCEPTION'; operation.stage = 'DUPLICATE_SETTLEMENT_KEYS'; operation.failure = { stage: operation.stage, category: 'DUPLICATE_SETTLEMENT_KEYS', message: `${duplicateCount} duplicate settlement key record(s) prevent VSAM loading.` }; operation.completedAt = (deps.now ?? (() => new Date()))(); operation.transitions.push({ status: operation.status, stage: operation.stage, at: operation.completedAt }); await deps.store.save(operation); return operation; }
    if (preflight.status.returnCode !== 0) throw fail('PREFLIGHT_FAILED', 'Sort or duplicate preflight returned nonzero without verified duplicate evidence.');
    await persistStage(operation, deps, 'PREFLIGHT', 'RECONCILIATION_READINESS');
    const sortedInputEvidence: ReconciliationReadinessEvidence['sortedInputs'] = {};
    for (const item of operation.datasets.filter((candidate) => ['TXNSORT','SETSORT','DUPES'].some((s) => candidate.name.endsWith(`.${s}`)))) {
      const attributes = await deps.remote.attributes(item.name);
      if (attributes.dsname.toUpperCase() !== item.name || attributes.dsorg?.toUpperCase() !== 'PS' || attributes.recfm?.toUpperCase() !== 'FB' || attributes.lrecl !== 38) { item.state = 'UNKNOWN'; await deps.store.save(operation); throw fail('SORT_OUTPUT_INVALID', 'A run-specific sort output dataset did not verify as PS/FB/38.'); }
      item.state = 'CREATED'; await deps.store.save(operation);
      if (item.name === operation.plan.datasets.TXNSORT || item.name === operation.plan.datasets.SETSORT) {
        const key = item.name === operation.plan.datasets.TXNSORT ? 'TXNSORT' : 'SETSORT';
        sortedInputEvidence[key] = { dataset: attributes.dsname, state: 'PRESENT', dsorg: attributes.dsorg, recfm: attributes.recfm, lrecl: attributes.lrecl };
      }
    }
    const outputConflicts: ReconciliationReadinessEvidence['outputConflicts'] = {};
    for (const key of RECONCILIATION_OUTPUT_KEYS) {
      try { await deps.remote.attributes(operation.plan.datasets[key]); outputConflicts[key] = 'PRESENT'; }
      catch (error) { if ((error as { code?: string }).code === 'DATASET_NOT_FOUND') outputConflicts[key] = 'ABSENT'; else outputConflicts[key] = 'UNKNOWN'; }
    }
    const readinessEvidence: ReconciliationReadinessEvidence = {
      sortedInputs: sortedInputEvidence,
      loadModule: { library: operation.plan.config.loadLibrary, member: operation.plan.config.loadModule, verified: true, evidence: moduleCheck.evidence },
      outputConflicts,
    };
    const prerequisiteBlockers = reconciliationReadinessBlockers(operation.plan, readinessEvidence);
    operation.stageResults.readinessPrerequisites = {
      state: prerequisiteBlockers.length ? 'BLOCKED' : 'READY',
      loadModule: { library: readinessEvidence.loadModule.library, member: readinessEvidence.loadModule.member, verified: true, evidence: sanitizeText(readinessEvidence.loadModule.evidence!, 160) },
      sortedInputs: sortedInputEvidence,
      outputConflicts,
      blockers: prerequisiteBlockers,
    };
    await deps.store.save(operation);
    if (prerequisiteBlockers.length) throw fail('RECONCILIATION_READINESS_BLOCKED', prerequisiteBlockers.join(' '));
    await persistStage(operation, deps, 'VSAM_SETUP', 'VSAM_AND_RECONCILIATION');
    operation.datasets.filter((item) => ['SETTLE','SETDATA','SETIDX','MATCHOUT','MISMOUT','TXNMISS','SETMISS'].some((s) => item.name.endsWith(`.${s}`))).forEach((item) => { item.state = 'CREATING'; }); await deps.store.save(operation);
    const reconciliationJcl = generateReconciliationJcl(operation.plan); assertRunScopedJclContract(operation.plan, 'reconciliation', reconciliationJcl);
    const recon = await submitAndWait(operation, deps, 'VSAM_AND_RECONCILIATION', reconciliationJcl, [0, 4]);
    for (const item of operation.datasets.filter((candidate) => ['SETTLE','SETDATA','SETIDX','MATCHOUT','MISMOUT','TXNMISS','SETMISS'].some((s) => candidate.name.endsWith(`.${s}`)))) {
      const attributes = await deps.remote.attributes(item.name);
      if (attributes.dsname.toUpperCase() !== item.name) { item.state = 'UNKNOWN'; await deps.store.save(operation); throw fail('RECONCILIATION_OUTPUT_MISSING', 'A required run-specific reconciliation dataset was not found.'); }
      item.state = 'CREATED'; await deps.store.save(operation);
    }
    const counts = parseCobolCounts(recon.spool); if (countConsistencyError(counts)) throw fail('COBOL_COUNT_INCONSISTENT', countConsistencyError(counts)!);
    if (counts.transactionCount !== txCount || counts.settlementCount !== setCount) throw fail('COBOL_INPUT_COUNT_MISMATCH', 'COBOL input counts do not match verified sorted dataset counts.');
    await persistStage(operation, deps, 'RETRIEVING_RESULTS', 'OUTPUT_RETRIEVAL');
    const outputSpecs = [
      ['MATCHOUT', operation.plan.datasets.MATCHOUT, 38, counts.matchedCount], ['MISMOUT', operation.plan.datasets.MISMOUT, 120, counts.mismatchedCount],
      ['TXNMISS', operation.plan.datasets.TXNMISS, 120, counts.transactionOnlyCount], ['SETMISS', operation.plan.datasets.SETMISS, 120, counts.settlementOnlyCount],
    ] as const;
    const actual: { matchedCount: number; mismatchedCount: number; transactionOnlyCount: number; settlementOnlyCount: number } = { matchedCount: 0, mismatchedCount: 0, transactionOnlyCount: 0, settlementOnlyCount: 0 };
    let matchedAmountCents: bigint | undefined;
    for (const [key, dataset, recordLength, expectedCount] of outputSpecs) {
      const localPath = path.join(path.resolve(deps.stagingRoot), `${crypto.randomUUID()}.out`); downloads.push(localPath); await deps.remote.downloadDataset(dataset, localPath);
      const output = await checkInputFile(localPath, expectedCount, recordLength);
      const summaryKey = ({ MATCHOUT: 'matchedCount', MISMOUT: 'mismatchedCount', TXNMISS: 'transactionOnlyCount', SETMISS: 'settlementOnlyCount' } as const)[key]; actual[summaryKey] = output.count;
      if (key === 'MATCHOUT') matchedAmountCents = output.count === 0 ? 0n : aggregateMatchedAmountCents(output.bytes);
      operation.outputReferences.push(await retainVerifiedOutput(operation, deps, key, dataset, localPath, recordLength, output.count, output.sha256)); await deps.store.save(operation);
    }
    operation.summary = { ...counts, ...(matchedAmountCents !== undefined ? { matchedAmountCents: matchedAmountCents.toString() } : {}) };
    await persistStage(operation, deps, 'EOD_VALIDATING', 'EOD_COUNT_VALIDATION');
    const eodJcl = generateEodJcl(operation.plan, counts, recon.status.returnCode ?? 8); assertRunScopedJclContract(operation.plan, 'eod', eodJcl);
    const publicationExpected = eodPublicationAllowed(recon.status.returnCode ?? 8, counts, actual, duplicateCount);
    const finalManifest = operation.datasets.find((item) => item.name === operation.plan.datasets.FINAL);
    if (publicationExpected && finalManifest) { finalManifest.state = 'CREATING'; await deps.store.save(operation); }
    const eodError = operation.datasets.find((item) => item.name.endsWith('.EODERROR')); if (eodError) { eodError.state = 'CREATING'; await deps.store.save(operation); }
    const eod = await submitAndWait(operation, deps, 'EOD_COUNT_VALIDATION', eodJcl, [0]);
    const publicationAllowed = publicationExpected;
    let finalExists = false;
    try { const attributes = await deps.remote.attributes(operation.plan.datasets.FINAL); finalExists = attributes.dsname.toUpperCase() === operation.plan.datasets.FINAL && attributes.dsorg?.toUpperCase() === 'PS' && attributes.recfm?.toUpperCase() === 'FB' && attributes.lrecl === 38; }
    catch (error) { if ((error as { code?: string }).code !== 'DATASET_NOT_FOUND') throw error; }
    if (finalManifest) { finalManifest.state = finalExists ? 'CREATED' : publicationAllowed ? 'UNKNOWN' : 'PLANNED'; await deps.store.save(operation); }
    if (publicationAllowed !== finalExists) throw fail('EOD_PUBLICATION_MISMATCH', 'The actual final dataset presence did not agree with the verified count and publication gates.');
    if (publicationAllowed) {
      const finalPath = path.join(path.resolve(deps.stagingRoot), `${crypto.randomUUID()}.out`); downloads.push(finalPath); await deps.remote.downloadDataset(operation.plan.datasets.FINAL, finalPath); const final = await checkInputFile(finalPath, counts.matchedCount, 38);
      operation.outputReferences.push(await retainVerifiedOutput(operation, deps, 'FINAL', operation.plan.datasets.FINAL, finalPath, 38, final.count, final.sha256)); await deps.store.save(operation);
    }
    if (eodError) {
      try { await deps.remote.attributes(eodError.name); eodError.state = 'CREATED'; }
      catch (error) { if ((error as { code?: string }).code === 'DATASET_NOT_FOUND') eodError.state = 'PLANNED'; else { eodError.state = 'UNKNOWN'; throw error; } }
      await deps.store.save(operation);
    }
    operation.stageResults.eod = { jobId: operation.jobs.at(-1)?.jobId, status: eod.status.status, returnCode: eod.status.returnCode, publicationAllowed, finalDatasetPresent: finalExists };
    await persistStage(operation, deps, 'REPORT_GENERATION', 'RESULTS_PERSISTED');
    operation.status = counts.mismatchedCount || counts.transactionOnlyCount || counts.settlementOnlyCount ? 'COMPLETED_WITH_EXCEPTIONS' : 'COMPLETED';
    operation.stage = 'CLEANUP'; operation.completedAt = (deps.now ?? (() => new Date()))(); operation.transitions.push({ status: operation.status, stage: 'CLEANUP', at: operation.completedAt }); await deps.store.save(operation);
    // Output copies and results are durable before remote temporary cleanup begins.
    operation.cleanup.status = 'NOT_STARTED'; await deps.store.save(operation);
    const vsamCluster = operation.datasets.find((item) => item.name === operation.plan.datasets.SETTLE);
    if (vsamCluster?.state === 'CREATED') {
      for (const component of operation.datasets.filter((item) => item.name === operation.plan.datasets.SETTLE_DATA || item.name === operation.plan.datasets.SETTLE_INDEX)) component.state = 'CLEANING';
      vsamCluster.state = 'CLEANING'; await deps.store.save(operation);
      try {
        await deps.remote.deleteVsamCluster(vsamCluster.name); vsamCluster.state = 'CLEANED';
        for (const component of operation.datasets.filter((item) => item.name === operation.plan.datasets.SETTLE_DATA || item.name === operation.plan.datasets.SETTLE_INDEX)) component.state = 'CLEANED';
      } catch {
        vsamCluster.state = 'CLEANUP_FAILED'; operation.cleanup.failedDatasets.push(vsamCluster.name);
        for (const component of operation.datasets.filter((item) => item.name === operation.plan.datasets.SETTLE_DATA || item.name === operation.plan.datasets.SETTLE_INDEX)) component.state = 'UNKNOWN';
      }
      await deps.store.save(operation);
    }
    for (const item of operation.datasets) {
      if (item.name === operation.plan.datasets.SETTLE_DATA || item.name === operation.plan.datasets.SETTLE_INDEX) continue;
      if (item.state !== 'CREATED' || item.retained) continue;
      item.state = 'CLEANING'; await deps.store.save(operation);
      try { await deps.remote.deleteDataset(item.name); item.state = 'CLEANED'; }
      catch { item.state = 'CLEANUP_FAILED'; operation.cleanup.failedDatasets.push(item.name); }
      await deps.store.save(operation);
    }
    operation.cleanup.status = operation.cleanup.failedDatasets.length ? 'WARNING' : 'COMPLETED'; operation.stage = 'COMPLETED'; operation.updatedAt = (deps.now ?? (() => new Date()))(); await deps.store.save(operation);
    return operation;
  } catch (error) {
    if (operation.status !== 'AWAITING_RECOVERY') {
      const code = safeCategory(error); const message = sanitizeText((error as Error)?.message ?? 'Reconciliation processing failed.', 240);
      operation.datasets.filter((item) => item.state === 'CREATING' || item.state === 'CLEANING').forEach((item) => { item.state = 'UNKNOWN'; });
      operation.status = code === 'MAINFRAME_NOT_READY' || code === 'MAINFRAME_NOT_CONFIGURED' || code.endsWith('_BLOCKED') ? 'NOT_CONFIGURED' : 'FAILED'; operation.stage = operation.stage || 'FAILED'; operation.failure = { stage: operation.stage, category: code, message }; operation.diagnostics.push(`${operation.stage}: ${code}`); operation.updatedAt = (deps.now ?? (() => new Date()))(); operation.transitions.push({ status: operation.status, stage: operation.stage, at: operation.updatedAt }); await deps.store.save(operation);
    }
    return operation;
  } finally {
    const retainedOutputs = operation.status === 'COMPLETED' || operation.status === 'COMPLETED_WITH_EXCEPTIONS' || operation.status === 'BUSINESS_EXCEPTION' ? new Set(operation.outputReferences.map((reference) => path.resolve(reference.localPath))) : new Set<string>();
    for (const file of [...copies, ...downloads]) if (!retainedOutputs.has(path.resolve(file))) await fs.unlink(file).catch(() => undefined);
  }
}

function safeCategory(error: unknown): string {
  const code = String((error as { code?: unknown })?.code ?? 'ORCHESTRATION_ERROR');
  return /^[A-Z0-9_]{1,60}$/.test(code) ? code : 'ORCHESTRATION_ERROR';
}

export function assertPreviewNotMisrepresented(preview: ExecutionPlanPreview): void {
  if (preview.executable || preview.datasets.some((item) => item.state !== 'PLANNED_NOT_CREATED')) throw fail('PREVIEW_INVALID', 'A display-only preview cannot be used as evidence that datasets were created.');
}
