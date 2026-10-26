import { invokeZoweOperation, type ZoweOperationDependencies } from './zoweCli.js';
import { datasetMatchesScope } from './zoweCli.js';
import type { ReconciliationRemote, RemoteJobStatus } from './reconciliationOrchestrator.js';

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const match = /^(?:CC\s*)?(\d{1,4})$/i.exec(value.trim());
    if (match) return Number(match[1]);
  }
  return undefined;
}
function parseReturnCode(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = numeric(value);
  if (parsed !== undefined) return parsed;
  // ABEND and other non-CC terminal codes remain distinguishable as a nonzero
  // failure; the original sanitized condition text is preserved separately.
  return /^ABEND\b/i.test(String(value)) ? 999 : null;
}
function spoolText(value: unknown, requestedJobId: string): string {
  if (!Array.isArray(value) || value.length === 0) throw Object.assign(new Error('JES spool response is empty or malformed.'), { code: 'JES_SPOOL_MISSING' });
  const lines: string[] = [];
  for (const item of value) {
    const row = object(item);
    if (!row) throw Object.assign(new Error('JES spool response contains an unexpected item.'), { code: 'JES_SPOOL_MALFORMED' });
    const returnedJobId = row.jobid ?? row.jobId;
    if (returnedJobId !== undefined && String(returnedJobId).toUpperCase() !== requestedJobId.toUpperCase()) throw Object.assign(new Error('JES spool response does not belong to the requested job.'), { code: 'JES_JOB_MISMATCH' });
    const records = row.records;
    if (Array.isArray(records) && records.every((record) => typeof record === 'string')) lines.push(...records);
    else if (typeof row.record === 'string') lines.push(row.record);
    else if (typeof row.content === 'string') lines.push(...row.content.split(/\r?\n/));
    else if (typeof row.data === 'string') lines.push(...row.data.split(/\r?\n/));
    else throw Object.assign(new Error('JES spool response did not contain readable records.'), { code: 'JES_SPOOL_MALFORMED' });
  }
  const result = [...lines.join('\n')].filter((character) => {
    const code = character.charCodeAt(0);
    return code === 0x0a || code >= 0x20;
  }).join('');
  if (!result.trim()) throw Object.assign(new Error('JES spool response contains no records.'), { code: 'JES_SPOOL_MISSING' });
  return result;
}

/** Fixed Zowe operations only. No caller-supplied CLI text is accepted. */
export type ZoweWorkbenchAdapter = ReconciliationRemote & {
  listDatasets(scope: string): Promise<Array<Record<string, unknown>>>;
  datasetAttributes(dataset: string): Promise<Record<string, unknown>>;
  downloadDataset(dataset: string, localPath: string): Promise<void>;
};
export function createZoweReconciliationAdapter(dependencies: ZoweOperationDependencies = {}): ZoweWorkbenchAdapter {
  return {
    async listDatasets(scope) {
      const result = await invokeZoweOperation({ kind: 'datasetList', scope }, dependencies);
      const data = object(result.data); const response = object(data?.apiResponse); const items = response?.items;
      if (!data || data.success !== true || !Array.isArray(items)) throw Object.assign(new Error('Dataset listing did not return a validated resource list.'), { code: 'DATASET_RESPONSE_INVALID' });
      return items.map((item) => {
        const row = object(item);
        if (!row || typeof row.dsname !== 'string' || !datasetMatchesScope(row.dsname, scope)) throw Object.assign(new Error('Dataset listing returned an unexpected resource.'), { code: 'DATASET_RESPONSE_INVALID' });
        return { dsname: row.dsname.toUpperCase(), ...(typeof row.dsorg === 'string' ? { dsorg: row.dsorg.toUpperCase() } : {}), ...(typeof row.recfm === 'string' ? { recfm: row.recfm.toUpperCase() } : {}), ...(numeric(row.lrecl) !== undefined ? { lrecl: numeric(row.lrecl) } : {}), ...(typeof row.volser === 'string' ? { volser: row.volser } : {}) };
      });
    },
    async datasetAttributes(dataset) {
      return await this.attributes(dataset) as unknown as Record<string, unknown>;
    },
    async attributes(dataset) {
      const result = await invokeZoweOperation({ kind: 'datasetAttributes', dataset }, dependencies);
      const data = object(result.data); const response = object(data?.apiResponse); const items = response?.items;
      if (!data || data.success !== true || !Array.isArray(items)) throw Object.assign(new Error('Dataset query did not return a validated resource list.'), { code: 'DATASET_RESPONSE_INVALID' });
      if (items.length === 0) throw Object.assign(new Error('Exact-name query confirmed the dataset is absent.'), { code: 'DATASET_NOT_FOUND' });
      if (items.length !== 1) throw Object.assign(new Error('Exact-name query returned an ambiguous resource list.'), { code: 'DATASET_RESPONSE_INVALID' });
      const row = object(items[0]);
      if (!row || typeof row.dsname !== 'string' || row.dsname.toUpperCase() !== dataset.toUpperCase()) throw Object.assign(new Error('Dataset query returned a different dataset.'), { code: 'DATASET_RESPONSE_INVALID' });
      const lrecl = numeric(row.lrecl);
      return { dsname: row.dsname, ...(typeof row.dsorg === 'string' ? { dsorg: row.dsorg } : {}), ...(typeof row.recfm === 'string' ? { recfm: row.recfm } : {}), ...(lrecl !== undefined ? { lrecl } : {}) };
    },
    async createSequential(dataset, primaryTracks, secondaryTracks) { await invokeZoweOperation({ kind: 'createSequential', dataset, primaryTracks, secondaryTracks }, dependencies); },
    async uploadSequential(dataset, localPath) { await invokeZoweOperation({ kind: 'uploadSequential', dataset, localPath }, dependencies); },
    async downloadDataset(dataset, localPath) { await invokeZoweOperation({ kind: 'downloadDataset', dataset, localPath }, dependencies); },
    async deleteDataset(dataset) { await invokeZoweOperation({ kind: 'deleteDataset', dataset }, dependencies); },
    async deleteVsamCluster(dataset) { await invokeZoweOperation({ kind: 'deleteVsamCluster', dataset }, dependencies); },
    async submitJcl(localPath) {
      const result = await invokeZoweOperation({ kind: 'submitJcl', localPath }, dependencies);
      const data = object(result.data); const jobId = data?.jobid ?? data?.jobId;
      if (typeof jobId !== 'string' || !/^(?:JOB|STC|TSU)\d{1,8}$/i.test(jobId)) throw Object.assign(new Error('Zowe submission did not return a valid JES job identifier.'), { code: 'JES_JOB_ID_MISSING' });
      return { jobId: jobId.toUpperCase() };
    },
    async jobStatus(jobId): Promise<RemoteJobStatus> {
      const result = await invokeZoweOperation({ kind: 'jobStatus', jobId }, dependencies);
      const row = object(result.data); const returned = row?.jobid ?? row?.jobId; const status = row?.status;
      if (typeof returned !== 'string' || returned.toUpperCase() !== jobId.toUpperCase() || typeof status !== 'string') throw Object.assign(new Error('JES status response did not match the requested job.'), { code: 'JES_STATUS_MALFORMED' });
      const rawRc = row!.retcode ?? row!.returnCode ?? row!.maxcc;
      const returnCode = parseReturnCode(rawRc);
      const conditionCode = rawRc === undefined || rawRc === null ? undefined : String(rawRc).slice(0, 40);
      if (String(status).toUpperCase() === 'OUTPUT' && returnCode === null) throw Object.assign(new Error('Completed JES job did not return a parseable condition code.'), { code: 'JES_RETURN_CODE_MISSING' });
      return { jobId: returned.toUpperCase(), status: status.toUpperCase(), returnCode, ...(conditionCode ? { conditionCode } : {}) };
    },
    async jobSpool(jobId) {
      const result = await invokeZoweOperation({ kind: 'jobSpool', jobId }, dependencies);
      return spoolText(result.data, jobId);
    },
  };
}

export const zoweSpoolAdapterInternals = { parseReturnCode, spoolText };
