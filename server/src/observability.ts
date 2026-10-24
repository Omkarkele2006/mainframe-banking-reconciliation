import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type LogLevel = 'info' | 'warn' | 'error';
export type AuditRecord = {
  timestamp: Date;
  requestId: string;
  actorId: string;
  eventType: string;
  outcome: string;
  resourceReference: string;
  durationMs: number;
  errorCategory?: string;
  errorMessage?: string;
  action: string;
  details: Record<string, unknown>;
};
export type AuditWriter = (record: AuditRecord) => Promise<unknown>;
export type Logger = (level: LogLevel, event: Record<string, unknown>) => void;

const SECRET_PATTERN = /(?:password|passwd|token|authorization|cookie|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi;
export function sanitizeText(value: unknown, maxLength = 300): string {
  // eslint-disable-next-line no-control-regex -- control characters are removed to prevent terminal log injection.
  return String(value ?? '').replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]').replace(/\b(?:https?|mongodb(?:\+srv)?):\/\/[^\s/@]+:[^\s/@]+@/gi, '[REDACTED]@').replace(SECRET_PATTERN, '[REDACTED]').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
export function logStructured(level: LogLevel, event: Record<string, unknown>): void {
  const output = { timestamp: new Date().toISOString(), level, ...event };
  const line = JSON.stringify(output);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}
export function classifyRoute(method: string, path: string): string {
  const route = path.split('?')[0] ?? path;
  if (route === '/api/mainframe/connection-test') return 'MAINFRAME_CONNECTION_TEST';
  if (route.startsWith('/api/mainframe/upload-verification')) return 'MAINFRAME_UPLOAD_VERIFICATION';
  if (route.startsWith('/api/uploads/')) return 'UPLOAD';
  if (route === '/api/runs' && method === 'POST') return 'RECONCILIATION_ATTEMPT';
  if (route.includes('/export.')) return 'REPORT_DOWNLOAD';
  if (route.endsWith('/report') || /^\/api\/runs\/[^/]+$/.test(route)) return 'REPORT_ACCESS';
  if (route.startsWith('/api/organizations')) return 'ORGANIZATION_OPERATION';
  if (route === '/api/audit') return 'AUDIT_LOG_ACCESS';
  if (route === '/api/health' || route === '/api/readiness') return 'READINESS_CHECK';
  return 'API_REQUEST';
}
function resourceFor(path: string): string {
  const route = path.split('?')[0] ?? path;
  const safe = route.match(/^\/api\/(?:runs|uploads|mainframe\/upload-verification)\/([A-Za-z0-9_-]{1,100})(?:\/|$)/);
  if (safe?.[1]) return safe[1];
  if (route.startsWith('/api/organizations')) return 'organizations';
  if (route.startsWith('/api/mainframe/')) return 'mainframe';
  if (route === '/api/audit') return 'audit';
  return 'api';
}
function errorFor(status: number, code?: string, message?: string): { category: string; message: string } | undefined {
  if (status < 400) return undefined;
  const normalizedCode = sanitizeText(code, 80).toUpperCase();
  const category = normalizedCode.includes('TLS') ? 'TLS' : normalizedCode.includes('AUTHENTICATION') ? 'AUTHENTICATION' : normalizedCode.includes('DATASET_ACCESS') ? 'DATASET_ACCESS' : normalizedCode.includes('AUTHORIZATION') ? 'AUTHORIZATION' : normalizedCode.includes('NETWORK') ? 'NETWORK' : status === 401 || status === 403 ? 'AUTHORIZATION' : status === 408 || normalizedCode.includes('TIMEOUT') ? 'TIMEOUT' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : status === 404 ? 'NOT_FOUND' : 'VALIDATION';
  const safeMessage = sanitizeText(message || `Request failed with HTTP ${status}.`);
  return { category, message: safeMessage || `Request failed with HTTP ${status}.` };
}

export function requestObservability(options: { audit: AuditWriter; logger?: Logger; now?: () => number }): RequestHandler {
  const logger = options.logger ?? logStructured;
  const now = options.now ?? (() => performance.now());
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = crypto.randomUUID();
    (req as Request & { requestId?: string }).requestId = requestId;
    const startedAt = now();
    const timestamp = new Date();
    res.setHeader('X-Request-ID', requestId);
    let responseError: { code?: string; errorCategory?: string; message?: string } = {};
    const originalJson = res.json.bind(res);
    res.json = ((body?: unknown) => {
      if (res.statusCode >= 400 && body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        responseError = { code: typeof record.code === 'string' ? record.code : undefined, errorCategory: typeof record.errorCategory === 'string' ? record.errorCategory : undefined, message: typeof record.message === 'string' ? record.message : undefined };
      }
      return originalJson(body);
    }) as Response['json'];
    res.once('finish', () => {
      const durationMs = Math.max(0, Math.round((now() - startedAt) * 100) / 100);
      const path = sanitizeText(req.originalUrl.split('?')[0], 180);
      const eventType = classifyRoute(req.method, path);
      const error = errorFor(res.statusCode, responseError.errorCategory ?? responseError.code, responseError.message);
      const outcome = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'FAILED' : 'SUCCESS';
      const event = { requestId, method: sanitizeText(req.method, 12), route: path, durationMs, outcome, statusCode: res.statusCode, eventType, ...(error ? { errorCategory: error.category, errorMessage: error.message } : {}) };
      logger(outcome === 'ERROR' ? 'error' : outcome === 'FAILED' ? 'warn' : 'info', { event: 'api.request', ...event });
      const record: AuditRecord = {
        timestamp,
        requestId,
        actorId: typeof res.locals?.actorId === 'string' ? sanitizeText(res.locals.actorId, 120) : 'anonymous',
        eventType,
        outcome,
        resourceReference: resourceFor(path),
        durationMs,
        action: `${sanitizeText(req.method, 12)} ${path}`,
        details: { statusCode: res.statusCode },
        ...(error ? { errorCategory: error.category, errorMessage: error.message } : {}),
      };
      void options.audit(record).catch((writeError: unknown) => {
        logger('error', { event: 'audit.persist_failed', requestId, eventType, errorCategory: 'AUDIT_PERSISTENCE', errorMessage: sanitizeText((writeError as Error)?.message ?? 'MongoDB audit write failed.') });
      });
    });
    next();
  };
}
