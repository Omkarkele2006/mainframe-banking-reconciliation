import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeText, type LogLevel } from './observability.js';

export const ZOWE_PROFILE = 'zosmf' as const;
export const TEST_DATASET = 'Z73968.BANK.TXN10K' as const;
const OUTPUT_LIMIT = 1024 * 1024;
export const DEFAULT_ZOWE_TIMEOUT_MS = 45_000;
const CONNECTION_ARGS = ['zosmf', 'check', 'status', '--zosmf-profile', ZOWE_PROFILE, '--rfj'] as const;
const DATASET_ARGS = ['zos-files', 'list', 'data-set', TEST_DATASET, '--zosmf-profile', ZOWE_PROFILE, '--attributes', '--rfj'] as const;

export type ZoweOperation =
  | { kind: 'datasetAttributes'; dataset: string }
  | { kind: 'datasetMemberList'; dataset: string; member: string }
  | { kind: 'datasetList'; scope: string }
  | { kind: 'createSequential'; dataset: string; primaryTracks: number; secondaryTracks: number }
  | { kind: 'uploadSequential'; dataset: string; localPath: string }
  | { kind: 'submitJcl'; localPath: string }
  | { kind: 'jobStatus'; jobId: string }
  | { kind: 'jobSpool'; jobId: string }
  | { kind: 'downloadDataset'; dataset: string; localPath: string }
  | { kind: 'deleteDataset'; dataset: string }
  | { kind: 'deleteVsamCluster'; dataset: string };

function validDatasetName(dataset: string): boolean {
  const parts = dataset.split('.');
  return dataset.length <= 44 && parts.length >= 2 && parts.every((part) => /^[A-Z#$@][A-Z0-9#$@]{0,7}$/i.test(part));
}
export function validDatasetScope(scope: string, authorizedHlq = 'Z73968'): boolean {
  const parts = scope.split('.');
  if (scope.length > 44 || parts.length < 2 || parts.at(-1) !== '*' || !parts.slice(0, -1).every((part) => /^[A-Z#$@][A-Z0-9#$@]{0,7}$/i.test(part))) return false;
  const prefix=scope.slice(0,-2).toUpperCase();const hlq=authorizedHlq.toUpperCase();
  return prefix===hlq||prefix.startsWith(`${hlq}.`);
}
export function datasetMatchesScope(dataset: string, scope: string): boolean {
  if (!validDatasetName(dataset) || !validDatasetScope(scope)) return false;
  const prefix = scope.slice(0, -1).toUpperCase();
  return dataset.toUpperCase().startsWith(prefix);
}
function normalizeDatasetName(dataset: string): string | undefined {
  return validDatasetName(dataset) ? dataset.toUpperCase() : undefined;
}
function validJobId(jobId: string): boolean { return /^(?:JOB|STC|TSU)[0-9]{1,8}$/i.test(jobId); }
function validCommandPath(value: string): boolean { return /^[A-Za-z]:\\[A-Za-z0-9 _.-]+(?:\\[A-Za-z0-9 _.-]+)*$/.test(value) && !value.includes('..'); }

/** Typed, fixed-operation command construction; no API accepts this union directly. */
export function buildZoweOperationArgs(operation: ZoweOperation): string[] {
  switch (operation.kind) {
    case 'datasetAttributes':
      if (!validDatasetName(operation.dataset)) throw new Error('Invalid data set name.');
      return ['zos-files','list','data-set',operation.dataset.toUpperCase(),'--zosmf-profile',ZOWE_PROFILE,'--attributes','--rfj'];
    case 'datasetMemberList':
      if (operation.dataset.toUpperCase() !== 'Z73968.LOAD' || operation.member.toUpperCase() !== 'RECONCIL') throw new Error('Invalid data set member query.');
      return ['zos-files','list','all-members',operation.dataset.toUpperCase(),'--pattern',operation.member.toUpperCase(),'--attributes','--zosmf-profile',ZOWE_PROFILE,'--rfj'];
    case 'datasetList':
      if (!validDatasetScope(operation.scope)) throw new Error('Invalid authorized data set scope.');
      return ['zos-files','list','data-set',operation.scope.toUpperCase(),'--zosmf-profile',ZOWE_PROFILE,'--attributes','--rfj'];
    case 'createSequential':
      if (!validDatasetName(operation.dataset) || !Number.isInteger(operation.primaryTracks) || operation.primaryTracks < 1 || operation.primaryTracks > 500 || !Number.isInteger(operation.secondaryTracks) || operation.secondaryTracks < 0 || operation.secondaryTracks > 500) throw new Error('Invalid sequential data set allocation parameters.');
      return ['zos-files','create','data-set-sequential',operation.dataset.toUpperCase(),'--size',`${operation.primaryTracks}TRK`,'--secondary-space',String(operation.secondaryTracks),'--record-format','FB','--record-length','38','--block-size','27968','--attributes','--zosmf-profile',ZOWE_PROFILE,'--rfj'];
    case 'uploadSequential':
      if (!validDatasetName(operation.dataset) || !validCommandPath(operation.localPath)) throw new Error('Invalid staged upload parameters.');
      return ['zos-files','upload','file-to-data-set',operation.localPath,operation.dataset.toUpperCase(),'--encoding','IBM-1047','--zosmf-profile',ZOWE_PROFILE,'--rfj'];
    case 'submitJcl':
      if (!validCommandPath(operation.localPath)) throw new Error('Invalid staged JCL path.');
      return ['zos-jobs','submit','local-file',operation.localPath,'--zosmf-profile',ZOWE_PROFILE,'--rfj'];
    case 'jobStatus':
      if (!validJobId(operation.jobId)) throw new Error('Invalid JES job ID.');
      return ['zos-jobs','view','job-status-by-jobid',operation.jobId.toUpperCase(),'--zosmf-profile',ZOWE_PROFILE,'--rfj'];
    case 'jobSpool':
      if (!validJobId(operation.jobId)) throw new Error('Invalid JES job ID.');
      // Zowe CLI 8.36.1 uses `all-spool-content <jobid>`; the old
      // `all-spool-content-by-jobid` spelling is not a registered command.
      return ['zos-jobs','view','all-spool-content',operation.jobId.toUpperCase(),'--zosmf-profile',ZOWE_PROFILE,'--rfj'];
    case 'downloadDataset':
      if (!validDatasetName(operation.dataset) || !validCommandPath(operation.localPath)) throw new Error('Invalid staged download parameters.');
      return ['zos-files','download','data-set',operation.dataset.toUpperCase(),'--file',operation.localPath,'--zosmf-profile',ZOWE_PROFILE,'--rfj'];
    case 'deleteDataset':
      if (!validDatasetName(operation.dataset)) throw new Error('Invalid data set name.');
      return ['zos-files','delete','data-set',operation.dataset.toUpperCase(),'--for-sure','--zosmf-profile',ZOWE_PROFILE,'--rfj'];
    case 'deleteVsamCluster':
      if (!validDatasetName(operation.dataset) || !/^Z73968\.[A-Z][A-Z0-9]{7}\.SETTLE$/i.test(operation.dataset)) throw new Error('Invalid run-owned VSAM cluster name.');
      return ['zos-files','delete','data-set',operation.dataset.toUpperCase(),'--for-sure','--zosmf-profile',ZOWE_PROFILE,'--rfj'];
    default: throw new Error('Unsupported Zowe operation.');
  }
}

export function buildWindowsZoweInvocation(args: string[], commandInterpreter = 'cmd.exe'): { executable: string; args: string[] } {
  const isAllowed = [CONNECTION_ARGS, DATASET_ARGS].some((allowed) => allowed.length === args.length && allowed.every((part, index) => part === args[index]))
    || (['datasetAttributes','datasetMemberList','datasetList','createSequential','uploadSequential','submitJcl','jobStatus','jobSpool','downloadDataset','deleteDataset','deleteVsamCluster'] as const).some((kind) => {
      try { return JSON.stringify(buildZoweOperationArgsFromCommand(kind,args)) === JSON.stringify(args); } catch { return false; }
    });
  if (!isAllowed) {
    throw new Error('Unsupported Zowe CLI invocation.');
  }
  // Invoke the PATH-resolved command by name as verified on Windows. In particular,
  // do not quote the dataset level or wrap an absolute .cmd path in cmd.exe syntax.
  const rendered = args.map((part) => part.includes('\\') && /^[A-Za-z]:\\/.test(part) ? `"${part}"` : part).join(' ');
  return { executable: commandInterpreter, args: ['/d', '/c', `zowe ${rendered}`] };
}

export function buildWindowsZoweSpawnInvocation(args: string[], commandInterpreter = 'cmd.exe'): {
  executable: string;
  args: string[];
  options: { windowsVerbatimArguments: true };
} {
  return {
    ...buildWindowsZoweInvocation(args, commandInterpreter),
    options: { windowsVerbatimArguments: true },
  };
}

function buildZoweOperationArgsFromCommand(kind: ZoweOperation['kind'], args: string[]): string[] {
  if (kind === 'createSequential' && args[0] === 'zos-files' && args[1] === 'create' && args[2] === 'data-set-sequential') {
    const value = (flag: string) => args[args.indexOf(flag) + 1] ?? '';
    const size = /^([1-9][0-9]*)TRK$/.exec(value('--size'));
    return buildZoweOperationArgs({ kind, dataset: args[3] ?? '', primaryTracks: Number(size?.[1]), secondaryTracks: Number(value('--secondary-space')) });
  }
  const at = args.indexOf('--zosmf-profile');
  if (at < 0 || args[at + 1] !== ZOWE_PROFILE || args.at(-1) !== '--rfj') throw new Error('Invalid fixed command.');
  const command = args.slice(0, at);
  if (kind === 'datasetAttributes' && command[0] === 'zos-files' && command[1] === 'list' && command[2] === 'data-set') return buildZoweOperationArgs({kind,dataset:command[3] ?? ''});
  if (kind === 'datasetMemberList' && command[0] === 'zos-files' && command[1] === 'list' && command[2] === 'all-members' && command[4] === '--pattern' && command[6] === '--attributes') return buildZoweOperationArgs({kind,dataset:command[3] ?? '',member:command[5] ?? ''});
  if (kind === 'datasetList' && command[0] === 'zos-files' && command[1] === 'list' && command[2] === 'data-set') return buildZoweOperationArgs({kind,scope:command[3] ?? ''});
  if (kind === 'uploadSequential' && command[0] === 'zos-files' && command[1] === 'upload' && command[2] === 'file-to-data-set') return buildZoweOperationArgs({kind,localPath:command[3] ?? '',dataset:command[4] ?? ''});
  if (kind === 'submitJcl' && command[0] === 'zos-jobs' && command[1] === 'submit' && command[2] === 'local-file') return buildZoweOperationArgs({kind,localPath:command[3] ?? ''});
  if (kind === 'jobStatus' && command[0] === 'zos-jobs' && command[1] === 'view' && command[2] === 'job-status-by-jobid') return buildZoweOperationArgs({kind,jobId:command[3] ?? ''});
  if (kind === 'jobSpool' && command[0] === 'zos-jobs' && command[1] === 'view' && command[2] === 'all-spool-content') return buildZoweOperationArgs({kind,jobId:command[3] ?? ''});
  if (kind === 'downloadDataset' && command[0] === 'zos-files' && command[1] === 'download' && command[2] === 'data-set' && command[4] === '--file') return buildZoweOperationArgs({kind,dataset:command[3] ?? '',localPath:command[5] ?? ''});
  if (kind === 'deleteDataset' && command[0] === 'zos-files' && command[1] === 'delete' && command[2] === 'data-set' && command[4] === '--for-sure') return buildZoweOperationArgs({kind,dataset:command[3] ?? ''});
  if (kind === 'deleteVsamCluster' && command[0] === 'zos-files' && command[1] === 'delete' && command[2] === 'data-set' && command[4] === '--for-sure') return buildZoweOperationArgs({kind,dataset:command[3] ?? ''});
  throw new Error('Unsupported Zowe operation.');
}

export type ZoweErrorCategory = 'CLI_UNAVAILABLE' | 'AUTHENTICATION' | 'AUTHORIZATION' | 'NETWORK' | 'TLS' | 'TIMEOUT' | 'DATASET_ACCESS' | 'DATASET_NOT_FOUND' | 'OUTPUT_MALFORMED' | 'CLI_ERROR';
export type ZoweConnectionResult = {
  profile: typeof ZOWE_PROFILE;
  state: 'CLI_UNAVAILABLE' | 'CONNECTION_FAILED' | 'CONNECTION_VERIFIED' | 'DATASET_ACCESS_FAILED' | 'DATASET_ACCESS_VERIFIED';
  connectionStatus: 'NOT_TESTED' | 'VERIFIED' | 'FAILED';
  datasetAccessStatus: 'NOT_TESTED' | 'VERIFIED' | 'DENIED' | 'FAILED';
  message: string;
  errorCategory?: ZoweErrorCategory;
  dataset?: typeof TEST_DATASET;
  datasetAttributes?: { dsorg?: string; recfm?: string; lrecl?: number };
  executionEnabled: false;
};
export type ProcessResult = { exitCode: number | null; stdout: string; stderr: string };
type RfjEnvelope = { success: boolean; exitCode: number; message?: string; stdout?: string; stderr?: string; data?: unknown };
export type ProcessInvoker = (executable: string, args: string[], options: { timeoutMs: number; maxOutputBytes: number; env: NodeJS.ProcessEnv; cwd: string }) => Promise<ProcessResult>;
export type ZoweDependencies = {
  locate?: () => Promise<string | undefined>;
  invoke?: ProcessInvoker;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  log?: (level: LogLevel, stage: string, details?: Record<string, unknown>) => void;
};

export function resolveZoweTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.ZOWE_CLI_TIMEOUT_MS;
  if (configured === undefined || configured.trim() === '') return DEFAULT_ZOWE_TIMEOUT_MS;
  const timeout = Number(configured);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60_000) throw Object.assign(new Error('ZOWE_CLI_TIMEOUT_MS must be an integer between 1000 and 60000.'), { code: 'ZOWE_TIMEOUT_CONFIGURATION_INVALID' });
  return timeout;
}

function windowsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'TEMP', 'TMP', 'NODE_EXTRA_CA_CERTS', 'ComSpec', 'COMSPEC'];
  return Object.fromEntries(allowed.flatMap((key) => env[key] ? [[key, env[key]]] : []));
}

export async function locateZoweExecutable(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const windows = platform === 'win32';
  const exeNames = windows ? ['zowe.cmd', 'zowe.exe', 'zowe.bat'] : ['zowe'];
  const pathValue = env.PATH ?? env.Path ?? '';
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  if (windows) {
    const appData = env.APPDATA ?? (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming') : undefined);
    if (appData) directories.push(path.join(appData, 'npm'));
  }
  for (const directory of [...new Set(directories)]) {
    for (const name of exeNames) {
      const candidate = path.resolve(directory, name);
      try { await fs.access(candidate); return candidate; } catch { /* continue through trusted PATH locations */ }
    }
  }
  return undefined;
}

function invokeProcess(executable: string, args: string[], options: { timeoutMs: number; maxOutputBytes: number; env: NodeJS.ProcessEnv; cwd: string }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    // The only arguments passed here come from fixed command definitions below. No request data reaches a shell.
    const isWindows = process.platform === 'win32';
    const windowsInvocation = isWindows ? buildWindowsZoweSpawnInvocation(args, options.env.ComSpec ?? options.env.COMSPEC ?? 'cmd.exe') : undefined;
    const child = windowsInvocation
      ? spawn(windowsInvocation.executable, windowsInvocation.args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, ...windowsInvocation.options, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let receivedBytes = 0;
    let settled = false;
    let timedOut = false;
    const settleReject = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.unref();
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
      settleReject(Object.assign(new Error('Zowe command timed out.'), { code: 'ZOWE_TIMEOUT' }));
    }, options.timeoutMs);
    const terminate = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.unref();
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
    };
    child.stdout.on('data', (chunk: Buffer) => { if (settled) return; receivedBytes += chunk.length; if (receivedBytes > options.maxOutputBytes) { terminate(); settleReject(Object.assign(new Error('Zowe output exceeded the configured limit.'), { code: 'ZOWE_OUTPUT_LIMIT' })); } else stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { if (settled) return; receivedBytes += chunk.length; if (receivedBytes > options.maxOutputBytes) { terminate(); settleReject(Object.assign(new Error('Zowe output exceeded the configured limit.'), { code: 'ZOWE_OUTPUT_LIMIT' })); } else stderr += chunk.toString('utf8'); });
    child.once('error', (error) => { clearTimeout(timer); settleReject(Object.assign(new Error('Zowe CLI could not be started.'), { code: 'ZOWE_SPAWN_ERROR', cause: error })); });
    child.once('close', (exitCode) => { clearTimeout(timer); if (!settled && !timedOut) { settled = true; resolve({ exitCode, stdout, stderr }); } });
  });
}

function parseRfj(output: string): RfjEnvelope {
  const normalized = output.replace(/^\uFEFF/, '').trim();
  let value: unknown;
  try { value = JSON.parse(normalized); } catch { throw Object.assign(new Error('Zowe CLI returned malformed machine-readable output.'), { code: 'RFJ_JSON_INVALID' }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Zowe CLI output did not match the expected machine-readable response.'), { code: 'RFJ_ENVELOPE_INVALID' });
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.success !== 'boolean' || typeof envelope.exitCode !== 'number' || !Number.isInteger(envelope.exitCode) || (envelope.message !== undefined && typeof envelope.message !== 'string') || (envelope.stdout !== undefined && typeof envelope.stdout !== 'string') || (envelope.stderr !== undefined && typeof envelope.stderr !== 'string')) {
    throw Object.assign(new Error('Zowe CLI response did not match the RFJ envelope.'), { code: 'RFJ_ENVELOPE_INVALID' });
  }
  return envelope as RfjEnvelope;
}

function normalizeMemberListData(value: unknown, requestedMember: string): { success: true; apiResponse: { items: unknown[]; returnedRows?: number } } {
  let current: unknown = value;
  for (let depth = 0; depth < 3; depth++) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) break;
    const row = current as Record<string, unknown>;
    if (Object.hasOwn(row, 'success') && row.success !== true) throw Object.assign(new Error('Zowe member query contained an unsuccessful nested result.'), { code: 'RFJ_RESOURCE_INVALID' });
    if (Object.hasOwn(row, 'exitCode') && row.exitCode !== 0) throw Object.assign(new Error('Zowe member query contained a nonzero nested exit code.'), { code: 'RFJ_RESOURCE_INVALID' });
    if (Object.hasOwn(row, 'apiResponse')) {
      const response = row.apiResponse;
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw Object.assign(new Error('Zowe member query API response was malformed.'), { code: 'RFJ_RESOURCE_INVALID' });
      const api = response as Record<string, unknown>;
      if (Object.hasOwn(api, 'success') && api.success !== true) throw Object.assign(new Error('Zowe member query API response was unsuccessful.'), { code: 'RFJ_RESOURCE_INVALID' });
      if (!Array.isArray(api.items) || (api.returnedRows !== undefined && (!Number.isInteger(api.returnedRows) || api.returnedRows !== api.items.length))) throw Object.assign(new Error('Zowe member query did not return a consistent item list.'), { code: 'RFJ_RESOURCE_INVALID' });
      if (api.items.length > 1) throw Object.assign(new Error('Zowe member query returned an ambiguous item list.'), { code: 'RFJ_RESOURCE_INVALID' });
      for (const item of api.items) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as { member?: unknown }).member !== 'string' || (item as { member: string }).member.toUpperCase() !== requestedMember.toUpperCase()) {
          throw Object.assign(new Error('Zowe member list did not verify the requested exact member.'), { code: 'RFJ_RESOURCE_INVALID' });
        }
      }
      return { success: true, apiResponse: { items: api.items, ...(api.returnedRows === undefined ? {} : { returnedRows: api.returnedRows as number }) } };
    }
    if (!Object.hasOwn(row, 'data')) break;
    current = row.data;
  }
  throw Object.assign(new Error('Zowe member query response did not contain a validated API item list.'), { code: 'RFJ_RESOURCE_INVALID' });
}

export type ZoweOperationResult = { data: unknown; message?: string; envelope: { success: true; exitCode: 0 } };

export type ZoweOperationFailure = Error & {
  code: string;
  diagnostic?: string;
  httpStatus?: number;
};

function failureEvidence(text: string): { diagnostic?: string; httpStatus?: number; category?: string } {
  const status = /\bHTTP(?:\/\d(?:\.\d)?)?\s*[: ]\s*([45]\d\d)\b/i.exec(text)?.[1]
    ?? /\bstatus(?:\s+code)?\s*[:= ]\s*([45]\d\d)\b/i.exec(text)?.[1];
  const markers = new Set<string>();
  for (const match of text.matchAll(/\bEDC\d{4}[A-Z]?\b/gi)) markers.add(match[0].toUpperCase());
  for (const match of text.matchAll(/\bD\d{2}-\d{2}\b/gi)) markers.add(match[0].toUpperCase());
  for (const match of text.matchAll(/\berrno2\s*=\s*0x[0-9a-f]+/gi)) markers.add(match[0].replace(/\s+/g, '').toLowerCase());
  for (const match of text.matchAll(/\b__last_op\s*=\s*\d+/gi)) markers.add(match[0].replace(/\s+/g, '').toLowerCase());
  for (const match of text.matchAll(/\b__code\s*=\s*0x[0-9a-f]+/gi)) markers.add(match[0].replace(/\s+/g, '').toLowerCase());
  if (/\b__code\s*=\s*0x0d370004\b/i.test(text) && !/\bD37-04\b/i.test(text)) markers.add('D37-04');
  if (/\bfwrite\(\)\s*error\b/i.test(text)) markers.add('fwrite() error');
  if (status) markers.add(`HTTP ${status}`);
  const items = [...markers].slice(0, 8);
  const normalizedStatus = status ? Number(status) : undefined;
  const category = /\bD37-04\b/i.test(text) || /\b__code\s*=\s*0x0d370004\b/i.test(text) ? 'DATASET_SPACE_ERROR'
    : normalizedStatus !== undefined ? 'REMOTE_HTTP_ERROR' : undefined;
  return { ...(items.length ? { diagnostic: sanitizeText(items.join('; '), 240) } : {}), ...(normalizedStatus ? { httpStatus: normalizedStatus } : {}), ...(category ? { category } : {}) };
}

function operationFailure(category: string, raw = ''): ZoweOperationFailure {
  const evidence = failureEvidence(raw);
  const finalCategory = evidence.category ?? category;
  const detail = evidence.diagnostic ? ` Diagnostic: ${evidence.diagnostic}.` : '';
  return Object.assign(new Error(`Zowe operation failed (${finalCategory}).${detail}`), {
    code: finalCategory,
    ...(evidence.diagnostic ? { diagnostic: evidence.diagnostic } : {}),
    ...(evidence.httpStatus ? { httpStatus: evidence.httpStatus } : {}),
  });
}
export type ZoweOperationDependencies = Pick<ZoweDependencies, 'locate' | 'invoke' | 'timeoutMs' | 'platform' | 'env'> & { stagingRoot?: string; memberDiagnostic?: (summary: Record<string, unknown>) => void };

/** Executes one of the fixed typed operations above and returns only validated RFJ data. */
export async function invokeZoweOperation(operation: ZoweOperation, dependencies: ZoweOperationDependencies = {}): Promise<ZoweOperationResult> {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const locate = dependencies.locate ?? (() => locateZoweExecutable(platform, env));
  const executable = await locate();
  if (!executable) throw Object.assign(new Error('Zowe CLI is unavailable to the API process.'), { code: 'CLI_UNAVAILABLE' });
  const sourcePath = 'localPath' in operation ? path.resolve(operation.localPath) : undefined;
  if (sourcePath) {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(moduleDirectory, '../../');
    const stagingRoot = path.resolve(dependencies.stagingRoot ?? path.resolve(projectRoot, env.UPLOAD_DIR ?? 'server/.uploads'));
    const relative = path.relative(stagingRoot, sourcePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !/^[0-9a-f-]{36}\.(?:txt|jcl|out)$/i.test(path.basename(sourcePath))) throw new Error('Zowe local file path is outside the approved run staging area.');
    if (operation.kind === 'uploadSequential' || operation.kind === 'submitJcl') {
      const stat = await fs.lstat(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Zowe source file must be an ordinary staged file.');
    } else if (operation.kind === 'downloadDataset') {
      try { await fs.lstat(sourcePath); throw new Error('Zowe download target already exists.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const args = buildZoweOperationArgs(operation);
  const invocationName = platform === 'win32' ? 'zowe' : executable;
  const invoke = dependencies.invoke ?? invokeProcess;
  let result: ProcessResult;
  try { result = await invoke(invocationName, args, { timeoutMs: dependencies.timeoutMs ?? resolveZoweTimeoutMs(env), maxOutputBytes: OUTPUT_LIMIT, env: windowsEnv(env), cwd: os.homedir() }); }
  catch (error) {
    const category = safeFailureCategory(error);
    throw operationFailure(category, (error as Error)?.message ?? '');
  }
  if (operation.kind === 'datasetMemberList') {
    const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    let raw: unknown; try { raw = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()); } catch { /* record shape only */ }
    const top = obj(raw), nested = obj(top.data), api = obj(nested.apiResponse), first = obj(Array.isArray(api.items) ? api.items[0] : undefined);
    const keys = (v: Record<string, unknown>) => Object.keys(v).slice(0, 30).map(key => sanitizeText(key, 48));
    const indicator = (v: unknown) => typeof v === 'boolean' || typeof v === 'number' ? v : v === undefined ? 'ABSENT' : 'INVALID';
    dependencies.memberDiagnostic?.({library: operation.dataset.toUpperCase(), member: operation.member.toUpperCase(), processExitCode: result.exitCode, processSuccess: result.exitCode === 0, topKeys: keys(top), dataKeys: keys(nested), apiResponseKeys: keys(api), outerSuccess: indicator(top.success), outerExitCode: indicator(top.exitCode), nestedSuccess: indicator(nested.success), nestedExitCode: indicator(nested.exitCode), apiSuccess: indicator(api.success), itemsArray: Array.isArray(api.items), itemCount: Array.isArray(api.items) ? api.items.length : null, returnedRows: indicator(api.returnedRows), firstItemKeys: keys(first), firstMember: typeof first.member === 'string' && /^[A-Z0-9#$@]{1,8}$/i.test(first.member) ? first.member : null});
  }
  if (result.exitCode !== 0) {
    let detail = result.stderr;
    try {
      const failedEnvelope = parseRfj(result.stdout);
      detail = `${failedEnvelope.message ?? ''} ${failedEnvelope.stderr ?? ''} ${detail}`;
    } catch { /* the sanitized process failure classification also handles non-RFJ CLI output */ }
    const category = safeFailureCategory(undefined, detail);
    throw operationFailure(category, detail);
  }
  const envelope = parseRfj(result.stdout);
  if (envelope.success !== true || envelope.exitCode !== 0) {
    const category = safeFailureCategory(undefined, `${envelope.message ?? ''} ${envelope.stderr ?? ''}`);
    throw operationFailure(category, `${envelope.message ?? ''} ${envelope.stderr ?? ''}`);
  }
  let data = envelope.data;
  if (operation.kind === 'datasetMemberList') data = normalizeMemberListData(data, operation.member);
  if (operation.kind === 'datasetAttributes' || operation.kind === 'datasetList' || operation.kind === 'datasetMemberList') {
    const nested = data as { success?: unknown; message?: unknown; error?: unknown; apiResponse?: { items?: unknown } } | undefined;
    const items = nested?.apiResponse?.items;
    if (nested?.success !== true || !Array.isArray(items)) {
      const detail = [envelope.stderr, nested?.message, nested?.error]
        .filter((value): value is string => typeof value === 'string').join(' ');
      const classified = safeFailureCategory(undefined, detail);
      const category = classified === 'CLI_ERROR' ? 'RFJ_RESOURCE_INVALID' : classified;
      throw Object.assign(new Error(`Zowe data set query failed (${category}).`), { code: category });
    }
    const returnedNames = items.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof (row as { dsname?: unknown }).dsname !== 'string') return undefined;
      return normalizeDatasetName((row as { dsname: string }).dsname);
    });
    if (operation.kind === 'datasetMemberList') {
      const exact = (data as { apiResponse?: { items?: unknown[] } }).apiResponse!.items!;
      for (const row of exact) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || typeof (row as { member?: unknown }).member !== 'string' || (row as { member: string }).member.toUpperCase() !== operation.member.toUpperCase()) {
          throw Object.assign(new Error('Zowe member list did not verify the requested exact member.'), { code: 'RFJ_RESOURCE_INVALID' });
        }
      }
    } else if (operation.kind === 'datasetList') {
      if (returnedNames.some((name) => name === undefined || !datasetMatchesScope(name, operation.scope))) throw Object.assign(new Error('Zowe data set list contained a resource outside the authorized scope.'), { code: 'RFJ_RESOURCE_INVALID' });
    } else {
    // An empty, successful exact-name query is the only proof of absence. Any
    // unexpected row makes the result inconclusive and must stop allocation.
    const expectedName = normalizeDatasetName(operation.dataset)!;
    if (returnedNames.some(name=>name===undefined) || returnedNames.filter(name=>name===expectedName).length!==1 && items.length!==0 || returnedNames.some(name=>name!==expectedName && (!expectedName.endsWith('.SETTLE') || ![expectedName.replace(/SETTLE$/, 'SETDATA'),expectedName.replace(/SETTLE$/, 'SETIDX')].includes(name!)))) {
      throw Object.assign(new Error('Zowe data set response did not verify the requested resource.'), { code: 'RFJ_RESOURCE_INVALID' });
    }
    }
  }
  if (operation.kind === 'uploadSequential' || operation.kind === 'deleteDataset' || operation.kind === 'deleteVsamCluster') {
    const nested = data as { success?: unknown } | undefined;
    if (nested?.success !== true) throw Object.assign(new Error('Zowe mutation response did not confirm operation success.'), { code: 'RFJ_RESOURCE_INVALID' });
  }
  if (operation.kind === 'submitJcl') {
    const jobId = data && typeof data === 'object' ? (data as Record<string, unknown>).jobid ?? (data as Record<string, unknown>).jobId : undefined;
    if (typeof jobId !== 'string' || !validJobId(jobId)) throw Object.assign(new Error('Zowe submission response did not contain a valid JES job ID.'), { code: 'RFJ_RESOURCE_INVALID' });
  }
  if (operation.kind === 'jobStatus') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('Zowe job status response was malformed.'), { code: 'RFJ_RESOURCE_INVALID' });
    const row = data as Record<string, unknown>;
    const returnedId = row.jobid ?? row.jobId;
    if (typeof returnedId !== 'string' || returnedId.toUpperCase() !== operation.jobId.toUpperCase() || typeof row.status !== 'string') throw Object.assign(new Error('Zowe job status response did not match the requested JES job.'), { code: 'RFJ_RESOURCE_INVALID' });
  }
  if (operation.kind === 'jobSpool' && (!Array.isArray(data) || data.length === 0)) throw Object.assign(new Error('Zowe spool response contained no output records.'), { code: 'SPOOL_MISSING' });
  if (operation.kind === 'downloadDataset' && sourcePath) {
    const stat = await fs.lstat(sourcePath);
    // A valid fixed-block output can contain zero records (for example MISMOUT
    // on a clean run). Input/read-back validation applies its own non-empty rule.
    if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('Zowe download did not produce a regular file.'), { code: 'DOWNLOAD_INVALID' });
  }
  return { data, ...(envelope.message ? { message: sanitizeText(envelope.message, 160) } : {}), envelope: { success: true, exitCode: 0 } };
}

function validConnectionData(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const hostname = data.zosmf_hostname;
  const port = data.zosmf_port;
  const zosVersion = data.zos_version;
  const zosmfVersion = data.zosmf_version;
  return typeof hostname === 'string' && hostname.trim().length > 0
    && ((typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535) || (typeof port === 'string' && /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535))
    && typeof zosVersion === 'string' && zosVersion.trim().length > 0
    // Some supported Zowe CLI releases omit zosmf_version from the status RFJ data.
    && (zosmfVersion === undefined || (typeof zosmfVersion === 'string' && zosmfVersion.trim().length > 0))
    && (Array.isArray(data.plugins) || (Boolean(data.plugins) && typeof data.plugins === 'object'));
}

function safeFailureCategory(error: unknown, output = ''): ZoweErrorCategory {
  const code = String((error as { code?: unknown })?.code ?? '').toUpperCase();
  const text = `${code} ${output}`.toLowerCase();
  if (code.includes('SPAWN')) return 'CLI_UNAVAILABLE';
  if (/certificate|tls|ssl|self.signed|unable to verify/.test(text)) return 'TLS';
  if (code.includes('TIMEOUT') || /timed out|timeout|etimedout/.test(text)) return 'TIMEOUT';
  if (/eperm|eacces|operation not permitted|error initializing zowe/.test(text)) return 'CLI_ERROR';
  if (code.includes('OUTPUT') || code.startsWith('RFJ_')) return 'OUTPUT_MALFORMED';
  if (/unauthorized|authentication|invalid credentials|401|not authenticated/.test(text)) return 'AUTHENTICATION';
  if (/forbidden|permission denied|not authorized|403/.test(text)) return 'AUTHORIZATION';
  if (/(?:dataset|data set).*(?:not found|does not exist)|(?:not found|does not exist).*(?:dataset|data set)/.test(text)) return 'DATASET_NOT_FOUND';
  if (/dataset|data set/.test(text) && /denied|not found|access|permission/.test(text)) return 'DATASET_ACCESS';
  if (/econn|enotfound|network|socket|connect/.test(text)) return 'NETWORK';
  return 'CLI_ERROR';
}

function actionable(category: ZoweErrorCategory, stage: 'connection' | 'dataset'): string {
  switch (category) {
    case 'CLI_UNAVAILABLE': return 'Zowe CLI was not found for the API process. Install it or add its executable directory to the API process PATH, then restart the server.';
    case 'AUTHENTICATION': return 'The local zosmf profile could not authenticate. Refresh or correct that profile under the Windows account running the API, then retry.';
    case 'TLS': return 'The Zowe CLI reported a TLS connection error. Review the local Zowe profile and endpoint; this application does not change profile TLS settings.';
    case 'NETWORK': return 'The z/OSMF endpoint could not be reached. Check network access, DNS and the endpoint configured in the local Zowe profile.';
    case 'TIMEOUT': return 'The Zowe CLI operation timed out. Check z/OSMF availability and retry.';
    case 'AUTHORIZATION': return stage === 'dataset' ? `Connection succeeded, but access to ${TEST_DATASET} was denied. Ask the mainframe administrator to verify read access.` : 'The local Zowe profile is not authorized to check z/OSMF status. Verify its profile permissions.';
    case 'DATASET_ACCESS': return `The connection succeeded, but ${TEST_DATASET} could not be read. Verify that the dataset exists and the profile has read access.`;
    case 'OUTPUT_MALFORMED': return 'Zowe CLI returned malformed or unexpected machine-readable output. Verify the installed CLI version and retry.';
    default: return stage === 'dataset' ? `The connection succeeded, but the read-only check for ${TEST_DATASET} failed. Verify dataset access and inspect the local Zowe CLI configuration.` : 'Zowe CLI could not verify the local zosmf profile. Check local CLI/profile permissions and retry under the Windows account that owns the profile.';
  }
}

function findDataset(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.success !== true || !data.apiResponse || typeof data.apiResponse !== 'object' || Array.isArray(data.apiResponse)) return undefined;
  const items = (data.apiResponse as Record<string, unknown>).items;
  if (!Array.isArray(items)) return undefined;
  return items.find((item): item is Record<string, unknown> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const dsname = (item as Record<string, unknown>).dsname;
    return typeof dsname === 'string' && dsname.toUpperCase() === TEST_DATASET;
  });
}

export async function testZoweProfile(dependencies: ZoweDependencies = {}): Promise<ZoweConnectionResult> {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const timeoutMs = dependencies.timeoutMs ?? resolveZoweTimeoutMs(env);
  const invoke = dependencies.invoke ?? invokeProcess;
  const log = dependencies.log ?? (() => undefined);
  const base = { profile: ZOWE_PROFILE, executionEnabled: false as const };
  log('info', 'cli_lookup');
  const executable = await (dependencies.locate ?? (() => locateZoweExecutable(platform, env)))();
  if (!executable) {
    log('warn', 'cli_unavailable', { errorCategory: 'CLI_UNAVAILABLE' });
    return { ...base, state: 'CLI_UNAVAILABLE', connectionStatus: 'NOT_TESTED', datasetAccessStatus: 'NOT_TESTED', message: actionable('CLI_UNAVAILABLE', 'connection'), errorCategory: 'CLI_UNAVAILABLE' };
  }
  // On Windows `locate` verifies PATH availability, while spawn deliberately asks
  // cmd.exe to resolve the `zowe` command in the inherited PATH/profile environment.
  const invocationName = platform === 'win32' ? 'zowe' : executable;
  const invokeFixed = async (stage: 'connection' | 'dataset', args: string[]) => {
    const startedAt = Date.now();
    log('info', `${stage}_started`, { profile: ZOWE_PROFILE, timeoutMs, ...(stage === 'dataset' ? { dataset: TEST_DATASET } : {}) });
    try {
      const result = await invoke(invocationName, args, { timeoutMs, maxOutputBytes: OUTPUT_LIMIT, env: windowsEnv(env), cwd: os.homedir() });
      let parsed: Record<string, unknown>;
      try { parsed = parseRfj(result.stdout); }
      catch (error) {
        const category = safeFailureCategory(error, `${result.stderr} ${result.stdout}`);
        const parseErrorCode = String((error as { code?: unknown })?.code ?? 'RFJ_PARSE_FAILED');
        log('warn', `${stage}_failed`, { durationMs: Date.now() - startedAt, processExitCode: result.exitCode, parseErrorCode, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), errorCategory: category });
        return { failed: true as const, category };
      }
      if (result.exitCode !== 0 || parsed.success !== true || parsed.exitCode !== 0) {
        const failure = safeFailureCategory(undefined, `${parsed.message ?? ''} ${parsed.stderr ?? ''} ${result.stderr}`);
        log('warn', `${stage}_failed`, { durationMs: Date.now() - startedAt, processExitCode: result.exitCode, rfjExitCode: parsed.exitCode, errorCategory: stage === 'dataset' && failure === 'AUTHORIZATION' ? 'DATASET_ACCESS' : failure });
        return { failed: true as const, category: failure };
      }
      if (stage === 'connection' && !validConnectionData(parsed.data)) {
        log('warn', 'connection_failed', { durationMs: Date.now() - startedAt, processExitCode: result.exitCode, rfjExitCode: parsed.exitCode, errorCategory: 'OUTPUT_MALFORMED' });
        return { failed: true as const, category: 'OUTPUT_MALFORMED' as const };
      }
      if (stage === 'dataset' && parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
        const data = parsed.data as Record<string, unknown>;
        if (data.success === false) {
          const detail = [parsed.message, parsed.stderr, data.message, data.error]
            .filter((value): value is string => typeof value === 'string')
            .join(' ');
          const category = safeFailureCategory(undefined, detail);
          log('warn', 'dataset_failed', { durationMs: Date.now() - startedAt, processExitCode: result.exitCode, rfjExitCode: parsed.exitCode, errorCategory: category });
          return { failed: true as const, category };
        }
      }
      log('info', `${stage}_succeeded`, { durationMs: Date.now() - startedAt, exitCode: result.exitCode });
      return { failed: false as const, parsed };
    } catch (error) {
      const category = safeFailureCategory(error);
      log('error', `${stage}_failed`, { durationMs: Date.now() - startedAt, errorCategory: category, errorMessage: sanitizeText((error as Error)?.message ?? 'Zowe command failed.', 160) });
      return { failed: true as const, category };
    }
  };
  const connection = await invokeFixed('connection', [...CONNECTION_ARGS]);
  if (connection.failed) {
    const category = connection.category;
    return { ...base, state: 'CONNECTION_FAILED', connectionStatus: 'FAILED', datasetAccessStatus: 'NOT_TESTED', message: actionable(category, 'connection'), errorCategory: category };
  }
  const dataset = await invokeFixed('dataset', [...DATASET_ARGS]);
  if (dataset.failed) {
    const accessDenied = dataset.category === 'AUTHORIZATION';
    const category = accessDenied ? 'DATASET_ACCESS' : dataset.category;
    return { ...base, state: 'DATASET_ACCESS_FAILED', connectionStatus: 'VERIFIED', datasetAccessStatus: accessDenied ? 'DENIED' : 'FAILED', message: actionable(accessDenied ? 'AUTHORIZATION' : category, 'dataset'), errorCategory: category };
  }
  const row = findDataset(dataset.parsed.data);
  if (!row) {
    log('error', 'dataset_response_invalid', { errorCategory: 'OUTPUT_MALFORMED' });
    return { ...base, state: 'DATASET_ACCESS_FAILED', connectionStatus: 'VERIFIED', datasetAccessStatus: 'FAILED', message: actionable('OUTPUT_MALFORMED', 'dataset'), errorCategory: 'OUTPUT_MALFORMED' };
  }
  const lreclValue = row.lrecl ?? row.LRECL;
  const lrecl = typeof lreclValue === 'number' ? lreclValue : typeof lreclValue === 'string' && /^\d+$/.test(lreclValue) ? Number(lreclValue) : undefined;
  const attr = row.dsorg ?? row.DSORG;
  const recfmValue = row.recfm ?? row.RECFM;
  const datasetAttributes = { ...(typeof attr === 'string' ? { dsorg: sanitizeText(attr, 16) } : {}), ...(typeof recfmValue === 'string' ? { recfm: sanitizeText(recfmValue, 16) } : {}), ...(lrecl !== undefined ? { lrecl } : {}) };
  return { ...base, state: 'DATASET_ACCESS_VERIFIED', connectionStatus: 'VERIFIED', datasetAccessStatus: 'VERIFIED', message: `Connection verified and read-only access to ${TEST_DATASET} succeeded. Live job execution remains disabled.`, dataset: TEST_DATASET, datasetAttributes };
}

export function createSingleFlightConnectionTest(run: (dependencies: ZoweDependencies) => Promise<ZoweConnectionResult> = testZoweProfile): (dependencies?: ZoweDependencies) => Promise<ZoweConnectionResult> {
  let active: Promise<ZoweConnectionResult> | undefined;
  return (dependencies = {}) => {
    if (active) {
      dependencies.log?.('info', 'connection_test_coalesced', { message: 'An equivalent read-only connection test is already running.' });
      return active;
    }
    const current = run(dependencies);
    const tracked = current.finally(() => { if (active === tracked) active = undefined; });
    active = tracked;
    return tracked;
  };
}

export const runZoweConnectionTest = createSingleFlightConnectionTest();
