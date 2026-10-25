import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_UPLOAD_BYTES, TRACK_BYTES_3390 } from './executionPlan.js';
import { validateFixedWidthFile } from './validation.js';
import { sanitizeText } from './observability.js';

export type SmokeInput = {
  uploadId: string; kind: 'transaction' | 'settlement'; originalName: string; size: number;
  sha256: string; recordCount: number; valid: boolean; stagedPath: string;
};
export type SmokeDataset = { name: string; kind: 'transaction' | 'settlement'; state: 'PLANNED' | 'CREATING' | 'CREATED' | 'UNKNOWN' | 'CLEANING' | 'CLEANED' | 'ALREADY_ABSENT' | 'CLEANUP_FAILED'; errorCategory?: string };
export type UploadVerificationRecord = {
  operationId: string; organizationId: string; organizationName: string; actorId: string;
  transaction: SmokeInput; settlement: SmokeInput; runQualifier: string;
  datasets: SmokeDataset[]; status: 'PREPARED' | 'RUNNING' | 'VERIFIED' | 'VERIFIED_WITH_CLEANUP_WARNING' | 'FAILED' | 'CLEANUP_FAILED';
  stage: string; stageResults: Record<string, unknown>; errorCategory?: string; errorMessage?: string;
};
export type SmokeConfig = { hlq: string; jobClass: string; sourceLibrary: string; loadLibrary: string; profile: 'zosmf'; primaryTracks: { transaction: number; settlement: number } };
export type DatasetAttributes = { dsname: string; dsorg?: string; recfm?: string; lrecl?: number; allocationEvidence?: Record<string, number | string> };
export type DatasetAllocationResult = { primaryTracks: number; secondaryTracks: number; unit: 'TRK'; returned?: Record<string, number | string> };
export type SmokeAdapter = {
  attributes(dataset: string): Promise<DatasetAttributes>;
  create(dataset: string, primaryTracks: number, secondaryTracks: number): Promise<DatasetAllocationResult>;
  upload(dataset: string, stagedPath: string): Promise<void>;
  download(dataset: string, localPath: string): Promise<void>;
  delete(dataset: string): Promise<void>;
};
export type SmokeDependencies = {
  env?: NodeJS.ProcessEnv;
  stagingRoot: string;
  adapter: SmokeAdapter;
  checkReadiness: () => Promise<{ state: string; message?: string }>;
  persist: (record: UploadVerificationRecord) => Promise<void>;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
};

const TRACK_HEADROOM = 1.25;
const MAX_TRACKS = Math.ceil(MAX_UPLOAD_BYTES * TRACK_HEADROOM / TRACK_BYTES_3390);
const DATASET_QUALIFIER = /^[A-Z#$@][A-Z0-9#$@]{0,7}$/;

export function validateSmokeConfiguration(env: NodeJS.ProcessEnv = process.env): SmokeConfig {
  if (env.MAINFRAME_ENABLED !== 'true' || env.MAINFRAME_AUTH_READY !== 'true') throw Object.assign(new Error('Upload-verification execution is disabled by the administrator.'), { code: 'EXECUTION_DISABLED' });
  if (env.MAINFRAME_LOCAL_UPLOAD_TLS_RISK_ACCEPTED !== 'true') throw Object.assign(new Error('The administrator must explicitly accept the local zosmf profile TLS risk for this upload-verification smoke test.'), { code: 'LOCAL_UPLOAD_TLS_RISK_NOT_ACCEPTED' });
  if (env.MAINFRAME_UPLOAD_TEST_REVIEWED !== 'true') throw Object.assign(new Error('The mainframe owner must approve the installed Zowe CLI allocation and text-transfer commands before this test can run.'), { code: 'UPLOAD_TEST_REVIEW_REQUIRED' });
  const hlq = (env.MAINFRAME_HLQ ?? '').trim().toUpperCase();
  const jobClass = (env.MAINFRAME_JOB_CLASS ?? '').trim().toUpperCase();
  const sourceLibrary = (env.MAINFRAME_SOURCE_LIBRARY ?? '').trim().toUpperCase();
  const loadLibrary = (env.MAINFRAME_LOAD_LIBRARY ?? '').trim().toUpperCase();
  const endpoint = (env.MAINFRAME_ENDPOINT ?? '').trim();
  if (!DATASET_QUALIFIER.test(hlq) || !/^[A-Z0-9]$/.test(jobClass) || !validDataset(sourceLibrary) || !validDataset(loadLibrary) || !sourceLibrary.startsWith(`${hlq}.`) || !loadLibrary.startsWith(`${hlq}.`)) throw Object.assign(new Error('Mainframe HLQ, job class, source library, or load library configuration is missing or invalid.'), { code: 'MAINFRAME_CONFIGURATION_INVALID' });
  try { const url = new URL(endpoint); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(); }
  catch { throw Object.assign(new Error('A valid HTTPS mainframe endpoint is required for upload verification.'), { code: 'MAINFRAME_CONFIGURATION_INVALID' }); }
  return { hlq, jobClass, sourceLibrary, loadLibrary, profile: 'zosmf', primaryTracks: { transaction: 1, settlement: 1 } };
}

function validDataset(value: string): boolean {
  return value.length <= 44 && value.split('.').length >= 2 && value.split('.').every((part) => DATASET_QUALIFIER.test(part));
}
function validateManifest(record: UploadVerificationRecord, hlq: string): void {
  if (!/^[A-Z][A-Z0-9]{7}$/.test(record.runQualifier) || record.datasets.length !== 2) throw new Error('Upload-test manifest failed ownership validation.');
  const expected = new Map([['transaction', `${hlq}.${record.runQualifier}.TXNIN`], ['settlement', `${hlq}.${record.runQualifier}.SETIN`]]);
  if (record.datasets.some((item) => !validDataset(item.name) || expected.get(item.kind) !== item.name || !['PLANNED','CREATING','CREATED','UNKNOWN','CLEANING','CLEANED','ALREADY_ABSENT','CLEANUP_FAILED'].includes(item.state)) || new Set(record.datasets.map((item) => item.kind)).size !== 2) throw new Error('Upload-test manifest failed ownership validation.');
}

export function buildUploadVerificationPlan(input: { hlq: string; transaction: Pick<SmokeInput, 'size' | 'recordCount'>; settlement: Pick<SmokeInput, 'size' | 'recordCount'>; randomBytes?: (size: number) => Buffer }): { runQualifier: string; datasets: SmokeDataset[]; primaryTracks: { transaction: number; settlement: number } } {
  const hlq = input.hlq.toUpperCase();
  if (!DATASET_QUALIFIER.test(hlq)) throw new Error('Configured HLQ is not a valid one-level qualifier.');
  for (const [label, file] of [['Transaction', input.transaction], ['Settlement', input.settlement]] as const) {
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_UPLOAD_BYTES || !Number.isSafeInteger(file.recordCount) || file.recordCount < 1 || file.size < file.recordCount * 38 || file.size > file.recordCount * 40) throw new Error(`${label} input metadata is invalid.`);
  }
  const random = input.randomBytes ?? crypto.randomBytes;
  const entropy = random(8);
  if (entropy.length !== 8) throw new Error('Run-token generator returned invalid entropy.');
  const runQualifier = `U${(entropy.readBigUInt64BE() % (36n ** 7n)).toString(36).toUpperCase().padStart(7, '0')}`;
  if (!/^[A-Z][A-Z0-9]{7}$/.test(runQualifier)) throw new Error('Generated upload-test qualifier is invalid.');
  const datasets: SmokeDataset[] = [
    { name: `${hlq}.${runQualifier}.TXNIN`, kind: 'transaction', state: 'PLANNED' },
    { name: `${hlq}.${runQualifier}.SETIN`, kind: 'settlement', state: 'PLANNED' },
  ];
  if (datasets.some((item) => !validDataset(item.name))) throw new Error('Generated upload-test dataset name exceeds z/OS naming limits.');
  const tracks = (size: number) => Math.min(MAX_TRACKS, Math.max(1, Math.ceil(size * TRACK_HEADROOM / TRACK_BYTES_3390)));
  return { runQualifier, datasets, primaryTracks: { transaction: tracks(input.transaction.size), settlement: tracks(input.settlement.size) } };
}

export function normalizeFixedWidthRecords(bytes: Buffer): string[] {
  if (bytes.length === 0) throw new Error('Remote dataset read-back was empty.');
  const records = bytes.toString('utf8').split('\n');
  const hasTrailingLineFeed = records.at(-1) === '';
  if (hasTrailingLineFeed) records.pop();
  const normalized = records.map((record, index) => (index < records.length - 1 || hasTrailingLineFeed) && record.endsWith('\r') ? record.slice(0, -1) : record);
  if (!normalized.length || normalized.some((record) => Buffer.byteLength(record, 'utf8') !== 38)) throw new Error('Remote read-back contains an unexpected record length or count.');
  return normalized;
}

function expectedRecords(bytes: Buffer): string[] {
  const checked = validateFixedWidthFile(bytes);
  if (!checked.valid) throw Object.assign(new Error('Staged input no longer satisfies the fixed-width file contract.'), { code: 'STAGED_INPUT_INVALID' });
  return normalizeFixedWidthRecords(bytes);
}

async function createTextTransferCopy(records: readonly string[], stagingRoot: string): Promise<string> {
  const filePath = path.join(stagingRoot, `${crypto.randomUUID()}.txt`);
  const contents = Buffer.from(`${records.join('\n')}\n`, 'ascii');
  // The source file remains byte-for-byte intact. Only this private, run-scoped
  // copy is canonicalized to LF-delimited ASCII records for Zowe text upload.
  await fs.writeFile(filePath, contents, { flag: 'wx', mode: 0o600 });
  return filePath;
}

async function verifyStagedInput(input: SmokeInput, stagingRoot: string): Promise<Buffer> {
  if (!input.valid || !/^[0-9a-f-]{36}$/.test(input.uploadId) || !/^[a-f0-9]{64}$/i.test(input.sha256) || !/^[0-9a-f-]{36}\.txt$/i.test(path.basename(input.stagedPath))) throw Object.assign(new Error('Stored upload metadata is invalid.'), { code: 'STAGED_INPUT_INVALID' });
  const root = path.resolve(stagingRoot); const file = path.resolve(input.stagedPath); const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(file) !== root || path.basename(file) !== `${input.uploadId}.txt`) throw Object.assign(new Error('Stored upload reference is outside the approved staging directory.'), { code: 'STAGED_INPUT_INVALID' });
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.size || stat.size > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Staged input is missing or its size changed.'), { code: 'STAGED_INPUT_CHANGED' });
  const bytes = await fs.readFile(file);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw Object.assign(new Error('Staged input hash no longer matches the saved upload.'), { code: 'STAGED_INPUT_CHANGED' });
  if (expectedRecords(bytes).length !== input.recordCount) throw Object.assign(new Error('Staged input record count no longer matches the saved upload.'), { code: 'STAGED_INPUT_CHANGED' });
  return bytes;
}

function errorCategory(error: unknown): string {
  const code = String((error as { code?: unknown })?.code ?? 'CLI_ERROR');
  return /^[A-Z0-9_]{1,60}$/.test(code) ? code : 'CLI_ERROR';
}
export function safeSmokeErrorMessage(error: unknown): string {
  const category = errorCategory(error);
  const messages: Record<string, string> = {
    ENOENT: 'A staged input or temporary read-back file is missing.',
    EACCES: 'The API process cannot access a required staged file or local Zowe resource.',
    EPERM: 'The API process lacks permission for a required local file or Zowe resource.',
    STAGED_INPUT_INVALID: 'Stored upload metadata or fixed-width records are invalid.',
    STAGED_INPUT_CHANGED: 'Staged input is missing or no longer matches its saved size and hash.',
    DATASET_COLLISION: 'A generated test dataset already exists; no dataset was overwritten.',
    DATASET_ATTRIBUTES_MISMATCH: 'The remote dataset did not verify as PS/FB/LRECL=38.',
    DATASET_SPACE_ERROR: 'The mainframe reported a dataset space exhaustion condition (D37-04). Review the allocation evidence and available storage before retrying.',
    REMOTE_HTTP_ERROR: 'The remote z/OSMF operation returned an HTTP error. Review the sanitized diagnostic evidence before retrying.',
    READBACK_INVALID: 'The remote dataset read-back was missing or outside the expected size bound.',
    READBACK_COUNT_MISMATCH: 'The remote read-back record count differs from the validated upload.',
    READBACK_CONTENT_MISMATCH: 'The remote read-back records differ from the staged upload.',
    TIMEOUT: 'A Zowe operation timed out. Inspect the persisted dataset manifest before retrying.',
    AUTHENTICATION: 'The local zosmf profile could not authenticate. Check the profile under the API Windows account.',
    AUTHORIZATION: 'The local zosmf profile is not authorized for this dataset operation.',
    NETWORK: 'The z/OSMF endpoint could not be reached. Check DNS and network access.',
    TLS: 'The Zowe CLI reported a TLS connection error. Review the local zosmf profile and endpoint; this application does not change profile TLS settings.',
    LOCAL_UPLOAD_TLS_RISK_NOT_ACCEPTED: 'The administrator has not explicitly accepted the local zosmf profile TLS risk for this upload-verification smoke test.',
    UPLOAD_TEST_REVIEW_REQUIRED: 'The mainframe owner has not approved the installed Zowe CLI mutation and text-transfer commands.',
    DATASET_NOT_FOUND: 'A required run-specific dataset was not found during verification.',
    CLI_UNAVAILABLE: 'Zowe CLI is unavailable to the API process.',
    MAINFRAME_NOT_READY: 'The read-only Zowe connection and dataset check did not pass.',
    MAINFRAME_CONFIGURATION_INVALID: 'Required server-only mainframe configuration is missing or invalid.',
    EXECUTION_DISABLED: 'Upload-verification execution is disabled by the administrator.',
  };
  if (messages[category]) return messages[category]!;
  const raw = sanitizeText((error as Error)?.message ?? 'Mainframe operation failed.', 200);
  if (/(?:[A-Za-z]:\\|\\\\|(?:^|\s)\/(?:[A-Za-z0-9_.-]+\/)+)/.test(raw)) return `Upload verification failed (${category}). Check the API log by request ID.`;
  return raw || `Upload verification failed (${category}).`;
}
function safeError(error: unknown): string { return safeSmokeErrorMessage(error); }

async function save(record: UploadVerificationRecord, deps: SmokeDependencies): Promise<void> { await deps.persist(record); }

async function cleanup(record: UploadVerificationRecord, deps: SmokeDependencies): Promise<void> {
  record.stageResults.cleanup = { status: 'RUNNING', attemptedDatasets: [] as string[], failedDatasets: [] as string[] };
  await save(record, deps);
  const attemptedDatasets: string[] = [];
  const failedDatasets: string[] = [];
  for (const item of record.datasets) {
    if (item.state !== 'CREATED' && item.state !== 'CLEANUP_FAILED' && item.state !== 'CLEANING') continue;
    try {
      // A persisted manifest entry and exact generated data set name are both required.
      attemptedDatasets.push(item.name); item.state = 'CLEANING'; await save(record, deps);
      try { await deps.adapter.attributes(item.name); }
      catch (error) {
        if (errorCategory(error) === 'DATASET_NOT_FOUND') item.state = 'ALREADY_ABSENT';
        else throw error;
      }
      if (item.state === 'CLEANING') {
        await deps.adapter.delete(item.name);
        item.state = 'CLEANED'; delete item.errorCategory;
      }
    } catch (error) {
      item.state = 'CLEANUP_FAILED'; item.errorCategory = errorCategory(error);
      failedDatasets.push(item.name);
    }
    record.stageResults.cleanup = { status: 'RUNNING', attemptedDatasets: [...attemptedDatasets], failedDatasets: [...failedDatasets] };
    await save(record, deps);
  }
  record.stageResults.cleanup = {
    status: failedDatasets.length ? 'WARNING' : 'COMPLETED',
    attemptedDatasets,
    failedDatasets,
    ...(failedDatasets.length ? { warning: `Could not confirm cleanup of ${failedDatasets.length} run-owned dataset(s).` } : {}),
  };
  await save(record, deps);
}

export async function retryUploadVerificationCleanup(record: UploadVerificationRecord, deps: SmokeDependencies): Promise<UploadVerificationRecord> {
  if (!record || !Array.isArray(record.datasets)) throw new Error('Upload-test manifest failed ownership validation.');
  const hlq = (deps.env ?? process.env).MAINFRAME_HLQ?.trim().toUpperCase() ?? '';
  if (!DATASET_QUALIFIER.test(hlq)) throw new Error('Upload-test manifest failed ownership validation.');
  validateManifest(record, hlq);
  if (record.datasets.some((item) => item.state === 'CREATED' || item.state === 'CLEANUP_FAILED' || item.state === 'CLEANING')) {
    await cleanup(record, deps);
  }
  const verification = record.stageResults.verification as { success?: boolean } | undefined;
  record.status = record.datasets.some((item) => item.state === 'CLEANUP_FAILED' || item.state === 'UNKNOWN' || item.state === 'CREATING' || item.state === 'CLEANING') ? 'CLEANUP_FAILED' : verification?.success === true ? 'VERIFIED' : 'FAILED';
  await save(record, deps);
  return record;
}

export async function executeUploadVerification(record: UploadVerificationRecord, deps: SmokeDependencies): Promise<UploadVerificationRecord> {
  const env = deps.env ?? process.env;
  const config = validateSmokeConfiguration(env);
  validateManifest(record, config.hlq);
  const readiness = await deps.checkReadiness();
  if (readiness.state !== 'DATASET_ACCESS_VERIFIED') throw Object.assign(new Error(readiness.message ?? 'The approved local Zowe profile and read-only dataset check must pass first.'), { code: 'MAINFRAME_NOT_READY' });
  const stagingRoot = path.resolve(deps.stagingRoot);
  const localBytes = {
    transaction: await verifyStagedInput(record.transaction, stagingRoot),
    settlement: await verifyStagedInput(record.settlement, stagingRoot),
  };
  const expected = { transaction: expectedRecords(localBytes.transaction), settlement: expectedRecords(localBytes.settlement) };
  const downloads: string[] = [];
  const transferCopies: string[] = [];
  try {
    record.stage = 'DATASET_COLLISION_CHECK'; await save(record, deps);
    for (const item of record.datasets) {
      try { await deps.adapter.attributes(item.name); throw Object.assign(new Error(`Run-specific dataset ${item.name} already exists; no overwrite was attempted.`), { code: 'DATASET_COLLISION' }); }
      catch (error) { if (errorCategory(error) !== 'DATASET_NOT_FOUND') throw error; }
    }
    for (const item of record.datasets) {
      record.stage = `ALLOCATE_${item.kind.toUpperCase()}`; item.state = 'CREATING'; await save(record, deps);
      const size = record[item.kind].size;
      const primaryTracks = Math.min(MAX_TRACKS, Math.max(1, Math.ceil(size * TRACK_HEADROOM / TRACK_BYTES_3390)));
      const secondaryTracks = 1;
      const requestedAllocation = { primaryTracks, secondaryTracks, unit: 'TRK' as const };
      record.stageResults[`${item.kind}Allocation`] = { status: 'REQUESTED', requested: requestedAllocation };
      await save(record, deps);
      try {
        const allocation = await deps.adapter.create(item.name, primaryTracks, secondaryTracks);
        record.stageResults[`${item.kind}Allocation`] = {
          status: 'CLI_CONFIRMED',
          requested: requestedAllocation,
          ...(allocation.returned ? { returnedAllocationEvidence: allocation.returned } : {}),
        };
      } catch (error) {
        item.state = 'UNKNOWN'; item.errorCategory = errorCategory(error); await save(record, deps); throw error;
      }
      item.state = 'CREATED'; await save(record, deps);
      // Creation response is not enough: the exact dataset and FB/38 attributes must be read back.
      const attributes = await deps.adapter.attributes(item.name);
      if (attributes.dsname.toUpperCase() !== item.name.toUpperCase() || attributes.dsorg?.toUpperCase() !== 'PS' || attributes.recfm?.toUpperCase() !== 'FB' || Number(attributes.lrecl) !== 38) {
        item.errorCategory = 'DATASET_ATTRIBUTES_MISMATCH'; await save(record, deps);
        throw Object.assign(new Error(`Allocated dataset ${item.name} did not report the required PS/FB/38 attributes.`), { code: 'DATASET_ATTRIBUTES_MISMATCH' });
      }
      const previousAllocation = record.stageResults[`${item.kind}Allocation`] as Record<string, unknown>;
      record.stageResults[`${item.kind}Allocation`] = {
        ...previousAllocation,
        status: 'VERIFIED',
        success: true,
        attributes,
        ...(attributes.allocationEvidence ? { returnedDatasetSpaceEvidence: attributes.allocationEvidence } : {}),
      };
      await save(record, deps);
    }
    for (const item of record.datasets) {
      record.stage = `UPLOAD_${item.kind.toUpperCase()}`; await save(record, deps);
      const transferPath = await createTextTransferCopy(expected[item.kind], stagingRoot);
      transferCopies.push(transferPath);
      await deps.adapter.upload(item.name, transferPath);
      record.stageResults[`${item.kind}Upload`] = { success: true, mode: 'TEXT_RECORD_TRANSFER', encoding: 'IBM-1047', delimiter: 'LF' }; await save(record, deps);
    }
    for (const item of record.datasets) {
      record.stage = `VERIFY_${item.kind.toUpperCase()}`; await save(record, deps);
      const attributes = await deps.adapter.attributes(item.name);
      if (attributes.dsname.toUpperCase() !== item.name.toUpperCase() || attributes.dsorg?.toUpperCase() !== 'PS' || attributes.recfm?.toUpperCase() !== 'FB' || Number(attributes.lrecl) !== 38) throw Object.assign(new Error(`Uploaded dataset ${item.name} attributes do not match PS/FB/38.`), { code: 'DATASET_ATTRIBUTES_MISMATCH' });
      const localPath = path.join(stagingRoot, `${crypto.randomUUID()}.out`); downloads.push(localPath);
      await deps.adapter.download(item.name, localPath);
      const stat = await fs.lstat(localPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_UPLOAD_BYTES + 1024) throw Object.assign(new Error('Read-back file is missing or outside the expected size bound.'), { code: 'READBACK_INVALID' });
      const actual = normalizeFixedWidthRecords(await fs.readFile(localPath));
      const expectedRows = expected[item.kind];
      if (actual.length !== record[item.kind].recordCount || actual.length !== expectedRows.length) throw Object.assign(new Error(`${item.kind} read-back record count did not match the validated upload.`), { code: 'READBACK_COUNT_MISMATCH' });
      if (actual.some((row, index) => row !== expectedRows[index])) throw Object.assign(new Error(`${item.kind} read-back content did not match the staged input records.`), { code: 'READBACK_CONTENT_MISMATCH' });
      record.stageResults[`${item.kind}Verification`] = { success: true, attributes, readBackRecordCount: actual.length, contentMatch: true };
      await save(record, deps);
    }
    record.stageResults.verification = { success: true, message: 'Both remote datasets matched their staged fixed-width records.' };
    record.status = 'VERIFIED'; record.stage = 'VERIFIED'; await save(record, deps);
  } catch (error) {
    record.status = 'FAILED'; record.errorCategory = errorCategory(error); record.errorMessage = safeError(error);
    const failure = error as { diagnostic?: unknown; httpStatus?: unknown };
    const diagnostic = typeof failure?.diagnostic === 'string' ? sanitizeText(failure.diagnostic, 240) : undefined;
    const httpStatus = typeof failure?.httpStatus === 'number' && Number.isInteger(failure.httpStatus) ? failure.httpStatus : undefined;
    record.stageResults.failure = { stage: record.stage, category: record.errorCategory, message: record.errorMessage, ...(diagnostic ? { diagnostic } : {}), ...(httpStatus ? { httpStatus } : {}) };
    await save(record, deps);
  } finally {
    let localCleanupFailures = 0;
    for (const localPath of downloads) {
      try { await fs.unlink(localPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') localCleanupFailures += 1; }
    }
    for (const transferPath of transferCopies) {
      try { await fs.unlink(transferPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') localCleanupFailures += 1; }
    }
    if (localCleanupFailures > 0) {
      record.stageResults.localReadbackCleanup = { warning: true, outstandingTemporaryFiles: localCleanupFailures, message: 'A server-side transfer or read-back temporary file could not be removed immediately; hourly staging cleanup will retry.' };
      if (record.status === 'VERIFIED') record.status = 'VERIFIED_WITH_CLEANUP_WARNING';
      await save(record, deps);
    }
  }
  // A failed collision preflight has no run-owned remote resources to clean.
  // Keep its actual stage and PLANNED manifest intact instead of rewriting it
  // to CLEANUP/CLEANUP_FAILED.
  if (record.datasets.some((item) => item.state === 'CREATED' || item.state === 'CLEANUP_FAILED' || item.state === 'CLEANING')) {
    await cleanup(record, deps);
  }
  if (record.datasets.some((item) => item.state === 'CLEANUP_FAILED' || item.state === 'UNKNOWN' || item.state === 'CREATING' || item.state === 'CLEANING')) {
    if (record.status === 'VERIFIED') record.status = 'VERIFIED_WITH_CLEANUP_WARNING';
    else record.status = 'CLEANUP_FAILED';
  }
  await save(record, deps);
  return record;
}

export function safeUploadVerificationResponse(record: UploadVerificationRecord) {
  return {
    operationId: record.operationId, organizationId: record.organizationId, organizationName: record.organizationName,
    status: record.status, stage: record.stage, runQualifier: record.runQualifier,
    inputs: { transaction: { originalName: record.transaction.originalName, size: record.transaction.size, recordCount: record.transaction.recordCount }, settlement: { originalName: record.settlement.originalName, size: record.settlement.size, recordCount: record.settlement.recordCount } },
    datasets: record.datasets.map(({ name, kind, state, errorCategory: category }) => ({ name, kind, state, ...(category ? { errorCategory: category } : {}) })),
    stageResults: record.stageResults, ...(record.errorCategory ? { errorCategory: record.errorCategory, errorMessage: record.errorMessage } : {}),
  };
}

