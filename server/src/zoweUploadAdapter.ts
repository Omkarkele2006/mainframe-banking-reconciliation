import { invokeZoweOperation, type ZoweOperationDependencies } from './zoweCli.js';
import type { DatasetAttributes, SmokeAdapter } from './uploadVerification.js';

function rows(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const apiResponse = (data as Record<string, unknown>).apiResponse;
  if (!apiResponse || typeof apiResponse !== 'object' || Array.isArray(apiResponse)) return [];
  const items = (apiResponse as Record<string, unknown>).items;
  return Array.isArray(items) ? items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
}
function numberValue(value: unknown): number | undefined { return typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined; }

const SPACE_ATTRIBUTE_KEYS = new Set(['primaryspace', 'secondaryspace', 'primarytracks', 'secondarytracks', 'primarytrks', 'secondarytrks', 'primary', 'secondary']);
function allocationEvidence(value: unknown): Record<string, number | string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, number | string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (SPACE_ATTRIBUTE_KEYS.has(normalized)) {
      const numeric = numberValue(raw);
      if (numeric !== undefined && Number.isSafeInteger(numeric)) result[key] = numeric;
    } else if (['spaceunit', 'allocationunit', 'alcunit'].includes(normalized) && typeof raw === 'string' && /^(?:TRK|TRACKS?|CYL|CYLINDERS?|KB|MB)$/i.test(raw)) result[key] = raw.toUpperCase();
  }
  return Object.keys(result).length ? result : undefined;
}
function returnedAllocationEvidence(data: unknown): Record<string, number | string> | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const root = data as Record<string, unknown>;
  const apiResponse = root.apiResponse && typeof root.apiResponse === 'object' && !Array.isArray(root.apiResponse) ? root.apiResponse as Record<string, unknown> : undefined;
  const items = Array.isArray(apiResponse?.items) ? apiResponse.items : [];
  for (const candidate of [root, apiResponse, ...items]) {
    const evidence = allocationEvidence(candidate);
    if (evidence) return evidence;
  }
  return undefined;
}

export function createZoweUploadAdapter(dependencies: ZoweOperationDependencies = {}): SmokeAdapter {
  return {
    async attributes(dataset: string): Promise<DatasetAttributes> {
      const result = await invokeZoweOperation({ kind: 'datasetAttributes', dataset }, dependencies);
      const returned = rows(result.data);
      if (returned.length === 0) throw Object.assign(new Error('The successful exact-name query confirmed that the dataset is absent.'), { code: 'DATASET_NOT_FOUND' });
      const normalizedName = dataset.toUpperCase();
      const row = returned.find((item) => typeof item.dsname === 'string' && item.dsname.toUpperCase() === normalizedName);
      if (!row) throw Object.assign(new Error('Requested remote dataset was not returned by the attribute query.'), { code: 'RFJ_RESOURCE_INVALID' });
      return { dsname: row.dsname as string, ...(typeof row.dsorg === 'string' ? { dsorg: row.dsorg } : {}), ...(typeof row.recfm === 'string' ? { recfm: row.recfm } : {}), ...(numberValue(row.lrecl) !== undefined ? { lrecl: numberValue(row.lrecl) } : {}), ...(allocationEvidence(row) ? { allocationEvidence: allocationEvidence(row) } : {}) };
    },
    async create(dataset, primaryTracks, secondaryTracks) {
      const result = await invokeZoweOperation({ kind: 'createSequential', dataset, primaryTracks, secondaryTracks }, dependencies);
      return { primaryTracks, secondaryTracks, unit: 'TRK' as const, ...(returnedAllocationEvidence(result.data) ? { returned: returnedAllocationEvidence(result.data) } : {}) };
    },
    async upload(dataset, stagedPath) {
      // Zowe's default transfer is text/record-aware. --binary is intentionally omitted.
      await invokeZoweOperation({ kind: 'uploadSequential', dataset, localPath: stagedPath }, dependencies);
    },
    async download(dataset, localPath) {
      await invokeZoweOperation({ kind: 'downloadDataset', dataset, localPath }, dependencies);
    },
    async delete(dataset) {
      await invokeZoweOperation({ kind: 'deleteDataset', dataset }, dependencies);
    },
  };
}
