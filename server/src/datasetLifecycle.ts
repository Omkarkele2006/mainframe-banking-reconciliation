import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateFixedWidthFile } from './validation.js';

const QUALIFIER = /^[A-Z#$@][A-Z0-9#$@]{0,7}$/;
const RUN_QUALIFIER = /^U[A-Z0-9]{7}$/;

export function datasetMutationBlockers(env: NodeJS.ProcessEnv = process.env): string[] {
  const blockers: string[] = [];
  if (env.MAINFRAME_DATASET_MUTATIONS_ENABLED !== 'true') blockers.push('MAINFRAME_DATASET_MUTATIONS_ENABLED is false.');
  const scope = (env.MAINFRAME_DATASET_MUTATION_SCOPE ?? '').trim().toUpperCase();
  const hlq = (env.MAINFRAME_HLQ ?? '').trim().toUpperCase();
  if (scope !== 'Z73968' || hlq !== scope) blockers.push('Set MAINFRAME_DATASET_MUTATION_SCOPE and MAINFRAME_HLQ to the assigned project namespace Z73968.');
  return blockers;
}

export function datasetAllowedForMutation(dataset: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const scope = (env.MAINFRAME_DATASET_MUTATION_SCOPE ?? '').trim().toUpperCase();
  const hlq = (env.MAINFRAME_HLQ ?? '').trim().toUpperCase();
  return scope === 'Z73968' && hlq === scope && validateOwnedDatasetName(dataset) && dataset.toUpperCase().startsWith(`${scope}.`);
}

export function jobSubmissionBlockers(env: NodeJS.ProcessEnv = process.env): string[] {
  const blockers: string[] = [];
  if (env.MAINFRAME_JOB_SUBMISSION_ENABLED !== 'true') blockers.push('MAINFRAME_JOB_SUBMISSION_ENABLED is false.');
  if (!/^[A-Z0-9]$/.test((env.MAINFRAME_JOB_CLASS ?? '').trim().toUpperCase())) blockers.push('MAINFRAME_JOB_CLASS must contain one approved alphanumeric job-class character.');
  return blockers;
}
export const datasetJobSubmissionBlockers = jobSubmissionBlockers;

export function assertDatasetUploadableState(state: string): void {
  if (state !== 'CREATED' && state !== 'ACTIVE') throw Object.assign(new Error('This dataset is deleted or is not in a state that accepts uploads.'), { code: 'OWNED_DATASET_NOT_READY' });
}

export function makeOwnedSequentialDataset(qualifier: string): string {
  const token = qualifier.trim().toUpperCase();
  if (!RUN_QUALIFIER.test(token)) throw new Error('Invalid run qualifier for project dataset.');
  const name = `Z73968.${token}.DATA`;
  if (name.length > 44 || name.split('.').some((part) => !QUALIFIER.test(part))) throw new Error('Generated dataset name exceeds z/OS naming limits.');
  return name;
}

export function validateOwnedDatasetName(dataset: string): boolean {
  const parts = dataset.toUpperCase().split('.');
  return dataset.length <= 44 && parts.length === 3 && parts[0] === 'Z73968' && RUN_QUALIFIER.test(parts[1] ?? '') && parts[2] === 'DATA';
}

export function validateDatasetUpload(bytes: Buffer): { records: string[]; recordCount: number } {
  const checked = validateFixedWidthFile(bytes);
  if (!checked.valid) throw Object.assign(new Error(checked.errors[0] ?? 'File does not satisfy the 38-byte record contract.'), { code: 'FILE_CONTRACT_INVALID' });
  // Input validation is byte-based; this conversion is safe only after the
  // strict ASCII-compatible record contract has passed.
  const lines = bytes.toString('ascii').split('\n');
  const trailingLf = lines.at(-1) === '';
  if (trailingLf) lines.pop();
  const records = lines.map((line, index) => (index < lines.length - 1 || trailingLf) && line.endsWith('\r') ? line.slice(0, -1) : line);
  if (!records.length || records.some((record) => Buffer.byteLength(record, 'ascii') !== 38)) throw Object.assign(new Error('File contains an empty or invalid fixed-width record.'), { code: 'FILE_CONTRACT_INVALID' });
  return { records, recordCount: records.length };
}

export async function writeTransferCopy(records: readonly string[], stagingRoot: string): Promise<string> {
  if (!records.length || records.some((record) => Buffer.byteLength(record, 'ascii') !== 38 || /[^\x20-\x7e]/.test(record))) throw new Error('Transfer records do not match the supported text format.');
  const root = path.resolve(stagingRoot);
  const file = path.join(root, `${crypto.randomUUID()}.txt`);
  await fs.writeFile(file, Buffer.from(`${records.join('\n')}\n`, 'ascii'), { flag: 'wx', mode: 0o600 });
  return file;
}

export function sameRecords(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length && expected.every((record, index) => record === actual[index]);
}

export function canonicalRecordsSha256(records: readonly string[]): string {
  return crypto.createHash('sha256').update(Buffer.from(`${records.join('\n')}\n`, 'ascii')).digest('hex');
}

export function decideDatasetRecovery(action: 'CREATE'|'UPLOAD'|'REPLACE'|'DELETE', evidence: { exists: boolean; attributesMatch: boolean; contentMatch?: boolean; createCommandSucceeded?: boolean }, previousState?: 'CREATED'|'ACTIVE'):
  | { resolved: true; ownershipState: 'CREATED'|'ACTIVE'|'DELETED'; operationStatus: 'SUCCEEDED'|'FAILED'; message: string }
  | { resolved: false; message: string } {
  if (!evidence.exists) {
    if (action === 'CREATE') return { resolved: true, ownershipState: 'DELETED', operationStatus: 'FAILED', message: 'The exact generated dataset is absent; creation did not produce a resource.' };
    if (action === 'DELETE') return { resolved: true, ownershipState: 'DELETED', operationStatus: 'SUCCEEDED', message: 'The exact owned dataset is absent after the prior delete attempt.' };
    return { resolved: false, message: 'The expected uploaded dataset is absent; preserve the uncertain manifest for manual review.' };
  }
  if (!evidence.attributesMatch) return { resolved: false, message: 'The remote dataset attributes do not match the owned resource contract.' };
  if (action === 'CREATE') {
    if (evidence.createCommandSucceeded === true) return { resolved: true, ownershipState: 'CREATED', operationStatus: 'SUCCEEDED', message: 'The allocation command succeeded and the exact generated PS/FB/LRECL=38 dataset is present.' };
    return { resolved: false, message: 'Dataset presence alone cannot prove ownership after an uncertain allocation result.' };
  }
  if (action === 'UPLOAD' || action === 'REPLACE') {
    if (evidence.contentMatch === true) return { resolved: true, ownershipState: 'ACTIVE', operationStatus: 'SUCCEEDED', message: 'The remote fixed-width records match the persisted upload hash and count.' };
    return { resolved: false, message: 'Remote content does not match the persisted upload evidence; the dataset remains locked for manual review.' };
  }
  if ((action === 'DELETE') && previousState) return { resolved: true, ownershipState: previousState, operationStatus: 'FAILED', message: 'The exact dataset is still present; the prior delete did not complete.' };
  return { resolved: false, message: 'The operation state cannot be safely inferred from the available remote evidence.' };
}

export const datasetLifecycleInternals = { RUN_QUALIFIER };
