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

export function createZoweUploadAdapter(dependencies: ZoweOperationDependencies = {}): SmokeAdapter {
  return {
    async attributes(dataset: string): Promise<DatasetAttributes> {
      const result = await invokeZoweOperation({ kind: 'datasetAttributes', dataset }, dependencies);
      const returned = rows(result.data);
      if (returned.length === 0) throw Object.assign(new Error('The successful exact-name query confirmed that the dataset is absent.'), { code: 'DATASET_NOT_FOUND' });
      const normalizedName = dataset.toUpperCase();
      const row = returned.find((item) => typeof item.dsname === 'string' && item.dsname.toUpperCase() === normalizedName);
      if (!row) throw Object.assign(new Error('Requested remote dataset was not returned by the attribute query.'), { code: 'RFJ_RESOURCE_INVALID' });
      return { dsname: row.dsname as string, ...(typeof row.dsorg === 'string' ? { dsorg: row.dsorg } : {}), ...(typeof row.recfm === 'string' ? { recfm: row.recfm } : {}), ...(numberValue(row.lrecl) !== undefined ? { lrecl: numberValue(row.lrecl) } : {}) };
    },
    async create(dataset, primaryTracks, secondaryTracks) {
      await invokeZoweOperation({ kind: 'createSequential', dataset, primaryTracks, secondaryTracks }, dependencies);
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
