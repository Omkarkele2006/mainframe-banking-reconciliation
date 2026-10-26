import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeText } from './observability.js';
import type { RemoteJobStatus } from './reconciliationOrchestrator.js';

export type SmokeJobState = 'PREPARED'|'SUBMITTING'|'SUBMISSION_UNCERTAIN'|'SUBMITTED'|'RUNNING'|'UNRESOLVED'|'COMPLETED'|'FAILED';
export type SmokeJobOperation = {
  operationId: string; actorId: string; idempotencyKey: string; template: 'NOOP_SMOKE'; jobName: string; state: SmokeJobState;
  activeLock?: string;
  jobId?: string; jobStatus?: string; returnCode?: number | null; conditionCode?: string; createdAt: Date; submittedAt?: Date;
  lastCheckedAt?: Date; completedAt?: Date; spoolText?: string; spoolTruncated?: boolean; spoolRetrievedAt?: Date;
  errorCategory?: string; errorMessage?: string;
};
export interface SmokeJobStore {
  findByIdempotency(actorId: string, key: string): Promise<SmokeJobOperation | undefined>;
  create(operation: SmokeJobOperation): Promise<void>;
  save(operation: SmokeJobOperation): Promise<void>;
  getForActor(operationId: string, actorId: string): Promise<SmokeJobOperation | undefined>;
  listForActor(actorId: string): Promise<SmokeJobOperation[]>;
}
export interface SmokeJobRemote {
  submitJcl(localPath: string): Promise<{ jobId: string }>;
  jobStatus(jobId: string): Promise<RemoteJobStatus>;
  jobSpool(jobId: string): Promise<string>;
}
export type SmokeJobDependencies = {
  store: SmokeJobStore; remote: SmokeJobRemote; stagingRoot: string; enabled: boolean; jobClass: string;
  readiness: () => Promise<{ connectionStatus: string; message: string }>;
  now?: () => Date; makeJobName?: () => string; sleep?: (milliseconds: number) => Promise<void>;
};

const ACTIVE_STATES = new Set<SmokeJobState>(['PREPARED','SUBMITTING','SUBMISSION_UNCERTAIN','SUBMITTED','RUNNING','UNRESOLVED']);
const TERMINAL_STATES = new Set<SmokeJobState>(['COMPLETED','FAILED']);
const JOB_ID = /^(?:JOB|STC|TSU)\d{1,8}$/i;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createNoopSmokeJcl(jobName: string, jobClass: string): string {
  const normalizedName = jobName.toUpperCase();
  const normalizedClass = jobClass.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(normalizedName)) throw new Error('Generated JES job name is invalid.');
  if (!/^[A-Z0-9]$/.test(normalizedClass)) throw new Error('MAINFRAME_JOB_CLASS must contain one approved alphanumeric job-class character.');
  const jcl = `//${normalizedName} JOB ,MSGLEVEL=(2,0),CLASS=${normalizedClass}\n//SMOKE    EXEC PGM=IEFBR14\n`;
  validateNoopSmokeJcl(jcl, normalizedName, normalizedClass);
  return jcl;
}

export function validateNoopSmokeJcl(jcl: string, jobName: string, jobClass: string): void {
  const expected = `//${jobName} JOB ,MSGLEVEL=(2,0),CLASS=${jobClass}\n//SMOKE    EXEC PGM=IEFBR14\n`;
  if (jcl !== expected || /\bDD\b|\bDSN\s*=|ZXP\.PUBLIC|Z73968\.BANK/i.test(jcl)) throw new Error('NOOP_SMOKE JCL does not match the approved no-DD template.');
}

function sanitizedFailure(error: unknown): { category: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown };
  const category = sanitizeText(typeof candidate?.code === 'string' ? candidate.code : 'JES_OPERATION_FAILED', 80);
  return { category, message: sanitizeText(typeof candidate?.message === 'string' ? candidate.message : 'The JES operation failed.', 240) };
}

export async function startNoopSmokeJob(actorId: string, idempotencyKey: string, deps: SmokeJobDependencies): Promise<{ operation: SmokeJobOperation; replayed: boolean }> {
  if (!/^[\w.@-]{1,120}$/.test(actorId)) throw Object.assign(new Error('Authenticated operator identity is invalid.'), { code: 'ACTOR_INVALID' });
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) throw Object.assign(new Error('A unique Idempotency-Key is required.'), { code: 'IDEMPOTENCY_KEY_REQUIRED' });
  const prior = await deps.store.findByIdempotency(actorId, idempotencyKey);
  if (prior) return { operation: prior, replayed: true };
  if (!deps.enabled) throw Object.assign(new Error('NOOP_SMOKE submission is disabled by MAINFRAME_JOB_SUBMISSION_ENABLED.'), { code: 'JOB_SUBMISSION_DISABLED' });
  const jobClass = deps.jobClass.trim().toUpperCase();
  if (!/^[A-Z0-9]$/.test(jobClass)) throw Object.assign(new Error('MAINFRAME_JOB_CLASS must contain one approved alphanumeric job-class character.'), { code: 'JOB_CLASS_INVALID' });

  const now = deps.now ?? (() => new Date());
  const jobName = (deps.makeJobName ?? (() => `LS${crypto.randomBytes(3).toString('hex').toUpperCase()}`))().toUpperCase();
  const operation: SmokeJobOperation = { operationId: crypto.randomUUID(), actorId, idempotencyKey, template: 'NOOP_SMOKE', jobName, state: 'PREPARED', activeLock: actorId, createdAt: now() };
  try { await deps.store.create(operation); }
  catch {
    const duplicate = await deps.store.findByIdempotency(actorId, idempotencyKey);
    if (duplicate) return { operation: duplicate, replayed: true };
    throw Object.assign(new Error('Another smoke job is active or the idempotency key was already used.'), { code: 'JOB_OPERATION_CONFLICT' });
  }

  let localPath: string | undefined;
  let submissionInvoked = false;
  try {
    const readiness = await deps.readiness();
    if (readiness.connectionStatus !== 'VERIFIED') throw Object.assign(new Error(readiness.message || 'The local Zowe profile connection was not verified.'), { code: 'ZOWE_NOT_READY' });
    const jcl = createNoopSmokeJcl(jobName, jobClass);
    await fs.mkdir(deps.stagingRoot, { recursive: true });
    localPath = path.join(path.resolve(deps.stagingRoot), `${operation.operationId}.jcl`);
    await fs.writeFile(localPath, jcl, { flag: 'wx', mode: 0o600 });
    operation.state = 'SUBMITTING';
    await deps.store.save(operation);
    submissionInvoked = true;
    const result = await deps.remote.submitJcl(localPath);
    if (!JOB_ID.test(result.jobId)) throw Object.assign(new Error('Submission did not return a validated JES job ID.'), { code: 'JES_JOB_ID_MISSING' });
    operation.jobId = result.jobId.toUpperCase();
    operation.state = 'SUBMITTED';
    operation.submittedAt = now();
    await deps.store.save(operation);
    return { operation, replayed: false };
  } catch (error) {
    const failure = sanitizedFailure(error);
    // Once submitJcl has been invoked, a missing/failed response is ambiguous.
    // Persist the uncertainty and never resubmit this operation automatically.
    operation.state = submissionInvoked ? (operation.jobId ? 'UNRESOLVED' : 'SUBMISSION_UNCERTAIN') : 'FAILED';
    operation.errorCategory = failure.category;
    operation.errorMessage = failure.message;
    if (operation.state === 'FAILED') operation.completedAt = now();
    await deps.store.save(operation);
    return { operation, replayed: false };
  } finally {
    if (localPath) await fs.unlink(localPath).catch(() => undefined);
  }
}

export async function refreshNoopSmokeJob(operation: SmokeJobOperation, deps: SmokeJobDependencies): Promise<SmokeJobOperation> {
  if (!operation.jobId || !JOB_ID.test(operation.jobId)) throw Object.assign(new Error('No confirmed JES job ID is stored; status will not be queried.'), { code: 'JES_JOB_ID_UNAVAILABLE' });
  if (TERMINAL_STATES.has(operation.state) && operation.spoolRetrievedAt) return operation;
  const now = deps.now ?? (() => new Date());
  operation.lastCheckedAt = now();
  try {
    const status = await deps.remote.jobStatus(operation.jobId);
    if (status.jobId.toUpperCase() !== operation.jobId.toUpperCase()) throw Object.assign(new Error('JES status response did not match the persisted job ID.'), { code: 'JES_JOB_MISMATCH' });
    operation.jobStatus = sanitizeText(status.status, 40).toUpperCase();
    operation.returnCode = status.returnCode;
    operation.conditionCode = status.conditionCode ? sanitizeText(status.conditionCode, 40) : undefined;
    if (operation.jobStatus !== 'OUTPUT') {
      operation.state = 'RUNNING';
      await deps.store.save(operation);
      return operation;
    }
    if (status.returnCode === null || status.returnCode === undefined) throw Object.assign(new Error('JES reports OUTPUT without a validated return code.'), { code: 'JES_RETURN_CODE_MISSING' });
    const spool = await deps.remote.jobSpool(operation.jobId);
    const sanitized = spool.split(/\r?\n/).map((line) => sanitizeText(line, 4000)).join('\n');
    if (!sanitized.trim()) throw Object.assign(new Error('The completed JES job returned no readable spool evidence.'), { code: 'JES_SPOOL_MISSING' });
    const limit = 1024 * 1024;
    operation.spoolText = sanitized.slice(0, limit);
    operation.spoolTruncated = sanitized.length > limit;
    operation.spoolRetrievedAt = now();
    operation.state = status.returnCode === 0 ? 'COMPLETED' : 'FAILED';
    operation.completedAt = now();
    operation.errorCategory = status.returnCode === 0 ? undefined : 'JES_NONZERO_RETURN_CODE';
    operation.errorMessage = status.returnCode === 0 ? undefined : `The approved smoke job completed with return code ${status.returnCode}.`;
  } catch (error) {
    const failure = sanitizedFailure(error);
    operation.state = 'UNRESOLVED';
    operation.errorCategory = failure.category;
    operation.errorMessage = failure.message;
  }
  await deps.store.save(operation);
  return operation;
}

export async function pollNoopSmokeJob(operation: SmokeJobOperation, deps: SmokeJobDependencies, attempts = 4, intervalMs = 1500): Promise<SmokeJobOperation> {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10 || !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 5000) throw new Error('Smoke-job polling bounds are invalid.');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await refreshNoopSmokeJob(operation, deps);
    if (TERMINAL_STATES.has(operation.state) || operation.state === 'UNRESOLVED') return operation;
    if (attempt + 1 < attempts) await (deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(intervalMs);
  }
  operation.state = 'UNRESOLVED';
  operation.errorCategory = 'JES_POLL_WINDOW_EXPIRED';
  operation.errorMessage = 'The bounded JES polling window elapsed. Refresh this saved job to query its existing JES ID; do not resubmit.';
  await deps.store.save(operation);
  return operation;
}

export const smokeJobInternals = { ACTIVE_STATES, TERMINAL_STATES, OPERATION_ID, sanitizedFailure };
