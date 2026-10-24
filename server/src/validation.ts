import { z } from 'zod';
import { Buffer } from 'node:buffer';
export const organizationInput = z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9_-]+$/) });
export const runInput = z.object({ organizationId: z.string().regex(/^[a-f\d]{24}$/i), transactionUploadId: z.string().uuid(), settlementUploadId: z.string().uuid(), profile: z.enum(['SMOKE','VOLUME_10K','NEGATIVE']), planId: z.string().regex(/^REC-\d{8}-[A-F0-9]{20}$/) }).strict();
export const previewInput = runInput.omit({ planId: true }).strict();
export const uploadVerificationPreviewInput = z.object({ organizationId: z.string().regex(/^[a-f\d]{24}$/i), transactionUploadId: z.string().uuid(), settlementUploadId: z.string().uuid() }).strict();
export const uploadVerificationStartInput = z.object({ confirmDatasets: z.array(z.string().min(1).max(44)).length(2) }).strict();
export const historyQuery = z.object({ search: z.string().max(120).optional(), status: z.enum(['RECEIVED','PREFLIGHT','ALLOCATING','UPLOADING','SORTING','DUPLICATE_CHECK','VSAM_SETUP','RECONCILING','RETRIEVING_RESULTS','EOD_VALIDATING','REPORT_GENERATION','CLEANUP','READY_FOR_MAINFRAME','SUBMITTED','RUNNING','COMPLETED','COMPLETED_WITH_EXCEPTIONS','BUSINESS_EXCEPTION','FAILED','NOT_CONFIGURED','AWAITING_RECOVERY']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), sort: z.enum(['createdAt','status','organizationName']).default('createdAt'), order: z.enum(['asc','desc']).default('desc') });
export const auditQuery = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), eventType: z.string().trim().min(1).max(80).optional(), outcome: z.enum(['SUCCESS','FAILED','ERROR']).optional(), requestId: z.string().uuid().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), { message: 'from must be earlier than or equal to to' });

/** Basic byte-level intake checks only; uploaded bytes are staged unchanged. */
export function validateFixedWidthFile(buffer: Buffer) {
  const records = buffer.toString('binary').split('\n');
  const hasTrailingLineFeed = records.at(-1) === '';
  if (hasTrailingLineFeed) records.pop();
  const errors: string[] = [];
  if (buffer.includes(0)) errors.push('File contains a NUL byte.');
  if (!records.length || (records.length === 1 && records[0] === '')) errors.push('File contains no records.');
  records.forEach((raw, index) => {
    // A CR belongs to a CRLF delimiter only when this record is followed by LF.
    // A terminal or standalone CR is data and therefore fails the 38-byte contract.
    const followedByLineFeed = index < records.length - 1 || hasTrailingLineFeed;
    const line = followedByLineFeed && raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const length = Buffer.byteLength(line, 'binary');
    if (length !== 38) errors.push(`Record ${index + 1} has ${length} bytes; expected 38.`);
    if (length === 38 && !/^[A-Za-z0-9]{10}[A-Za-z0-9]{10}\d{9}\d{8}[A-Za-z0-9]$/u.test(line)) {
      errors.push(`Record ${index + 1} contains a field that does not match the basic fixed-width character format.`);
    }
  });
  return {
    recordCount: records.length,
    valid: errors.length === 0,
    errors: [...new Set(errors)].slice(0, 30),
    preview: records.slice(0, 5).map((line) => Buffer.from(line.endsWith('\r') ? line.slice(0, -1) : line, 'binary').toString('utf8')),
  };
}
