import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { classifyRoute, requestObservability, sanitizeText, type AuditRecord, type Logger } from './observability.js';
import { requireAuditViewer } from './auditAccess.js';
import { auditQuery } from './validation.js';

test('redacts secrets and neutralizes log injection', () => {
  assert.equal(sanitizeText('password=hunter2\r\nnext-line'), '[REDACTED] next-line');
  assert.equal(sanitizeText('Bearer super-secret-token'), 'Bearer [REDACTED]');
  assert.match(sanitizeText('authorization: Bearer abc'), /^\[REDACTED\]/);
});

test('logs request completion and persists correlated audit event without request bodies', async () => {
  const events: Record<string, unknown>[] = [];
  const writes: AuditRecord[] = [];
  const logger: Logger = (_level, event) => events.push(event);
  let tick = 100;
  const middleware = requestObservability({ audit: async record => { writes.push(record); }, logger, now: () => tick += 5 });
  const req = { method: 'POST', originalUrl: '/api/mainframe/connection-test?password=hidden', body: { password: 'never-audit-this' } } as never;
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), { statusCode: 502, setHeader(name: string, value: string) { headers[name] = value; }, json(body: unknown) { return body; } }) as never;
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  (res as unknown as { json: (body: unknown) => unknown }).json({ code: 'MAINFRAME_CONNECTION_FAILED', message: 'TLS certificate verification failed.' });
  (res as unknown as EventEmitter).emit('finish');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextCalled, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'api.request');
  assert.equal(events[0].outcome, 'ERROR');
  assert.equal(events[0].errorCategory, 'SERVER');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].eventType, 'MAINFRAME_CONNECTION_TEST');
  assert.equal(writes[0].requestId, headers['X-Request-ID']);
  assert.equal(JSON.stringify(writes[0]).includes('never-audit-this'), false);
});

test('audit persistence failures are printed to terminal logger', async () => {
  const logs: Record<string, unknown>[] = [];
  const middleware = requestObservability({ audit: async () => { throw new Error('mongo password=hunter2'); }, logger: (_level, event) => logs.push(event) });
  const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader() {}, json(body: unknown) { return body; } }) as never;
  middleware({ method: 'GET', originalUrl: '/api/health' } as never, res, () => undefined);
  (res as unknown as EventEmitter).emit('finish');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logs.some(event => event.event === 'audit.persist_failed'), true);
  assert.equal(JSON.stringify(logs).includes('hunter2'), false);
});

test('audit data access fails closed without an existing authenticated actor', () => {
  let status = 200;
  let body: unknown;
  let nextCalled = false;
  const res = { locals: {}, status(value: number) { status = value; return this; }, json(value: unknown) { body = value; return this; } } as never;
  requireAuditViewer({} as never, res, () => { nextCalled = true; });
  assert.equal(status, 403);
  assert.equal(nextCalled, false);
  assert.equal((body as { code: string }).code, 'AUDIT_ACCESS_REQUIRES_AUTH');
});

test('audit data access accepts an actor supplied by existing authentication middleware', () => {
  let nextCalled = false;
  const res = { locals: { actorId: 'operator-42' }, status() { return this; }, json() { return this; } } as never;
  requireAuditViewer({} as never, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('audit filter validation accepts filters and rejects invalid ranges', () => {
  const requestId = '92b178e8-25e5-4d1f-90ba-7e49c4281b16';
  assert.equal(auditQuery.safeParse({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z', eventType: 'UPLOAD', outcome: 'FAILED', requestId, page: '2' }).success, true);
  assert.equal(auditQuery.safeParse({ from: '2026-10-03T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' }).success, false);
  assert.equal(auditQuery.safeParse({ requestId: 'not-a-request-id' }).success, false);
});

test('classifies upload-verification API actions as mainframe business operations', () => {
  assert.equal(classifyRoute('POST','/api/mainframe/upload-verification/preview'),'MAINFRAME_UPLOAD_VERIFICATION');
  assert.equal(classifyRoute('POST','/api/mainframe/upload-verification/abc123/start'),'MAINFRAME_UPLOAD_VERIFICATION');
});

test('classifies persisted banking input-preflight API actions as mainframe business operations', () => {
  assert.equal(classifyRoute('POST','/api/mainframe/reconciliation-preflight'),'BANKING_INPUT_PREFLIGHT');
  assert.equal(classifyRoute('GET','/api/mainframe/reconciliation-preflight/123e4567-e89b-12d3-a456-426614174000'),'BANKING_INPUT_PREFLIGHT');
});
