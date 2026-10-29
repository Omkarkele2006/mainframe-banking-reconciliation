import assert from 'node:assert/strict';
import test from 'node:test';
import { authConfigured, createOperatorSession, hashOperatorPassword, requireOperator, revokeOperatorSession, sessionCookie, sessionMiddleware, verifyOperatorPassword, clearSessionsForTests, type AuthRequest } from './operatorAuth.js';
import type { NextFunction, Response } from 'express';

test('scrypt hashes verify without persisting the source password', async () => {
  const hash = await hashOperatorPassword('long-test-password');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyOperatorPassword('long-test-password', { passwordHash: hash }), true);
  assert.equal(await verifyOperatorPassword('wrong-password', { passwordHash: hash }), false);
  assert.equal(authConfigured({ username: 'operator', passwordHash: hash, ttlSeconds: 1800 }), true);
});

test('operator sessions use opaque HttpOnly strict cookies and require CSRF on mutations', () => {
  clearSessionsForTests();
  const config = { username: 'operator', passwordHash: `scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`, ttlSeconds: 1800 };
  const session = createOperatorSession('operator', config);
  assert.match(sessionCookie(session.token, config), /HttpOnly; SameSite=Strict/);
  const req = { headers: { cookie: `ledgerline_session=${session.token}` }, method: 'POST', get: () => undefined } as unknown as AuthRequest;
  const responseState = { statusCode: 0 };
  const res = { locals: {}, status(code: number) { responseState.statusCode = code; return this; }, json() { return this; } } as unknown as Response;
  let nextCalled = false;
  sessionMiddleware(req, res, (() => { nextCalled = true; }) as NextFunction);
  assert.equal(nextCalled, true);
  assert.equal(req.actorId, 'operator');
  requireOperator(req, res, (() => { nextCalled = false; }) as NextFunction);
  assert.equal(responseState.statusCode, 403);
  req.headers['x-csrf-token'] = session.csrfToken;
  requireOperator(req, res, (() => { nextCalled = true; }) as NextFunction);
  assert.equal(nextCalled, true);
  clearSessionsForTests();
});

test('protected actions fail closed when unauthenticated and a revoked session cannot be reused', () => {
  clearSessionsForTests();
  let responseCode = 0; let responseBody: unknown;
  const req = { headers: {}, method: 'GET', get: () => undefined } as unknown as AuthRequest;
  const res = { locals: {}, status(code: number) { responseCode = code; return this; }, json(body: unknown) { responseBody = body; return this; } } as unknown as Response;
  requireOperator(req, res, (() => assert.fail('unauthenticated request must not continue')) as NextFunction);
  assert.equal(responseCode, 401);
  assert.equal((responseBody as { code: string }).code, 'AUTHENTICATION_REQUIRED');

  const config = { username: 'operator', passwordHash: `scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`, ttlSeconds: 1800 };
  const session = createOperatorSession('operator', config);
  const authenticatedReq = { headers: { cookie: `ledgerline_session=${session.token}` }, method: 'GET', get: () => undefined } as unknown as AuthRequest;
  revokeOperatorSession(authenticatedReq);
  sessionMiddleware(authenticatedReq, res, (() => undefined) as NextFunction);
  assert.equal(authenticatedReq.actorId, undefined);
  requireOperator(authenticatedReq, res, (() => assert.fail('revoked session must not continue')) as NextFunction);
  assert.equal(responseCode, 401);
  clearSessionsForTests();
});

test('expired application session is rejected on the next protected request', () => {
  clearSessionsForTests();
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const config = { username: 'operator', passwordHash: `scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`, ttlSeconds: 300 };
    const session = createOperatorSession('operator', config);
    const req = { headers: { cookie: `ledgerline_session=${session.token}` }, method: 'GET', get: () => undefined } as unknown as AuthRequest;
    const responseState: { statusCode?: number } = {};
    const res = { locals: {}, status(code: number) { responseState.statusCode = code; return this; }, json() { return this; } } as unknown as Response;
    let continued = false;
    now += 300_001;
    sessionMiddleware(req, res, (() => { continued = true; }) as NextFunction);
    assert.equal(continued, true);
    assert.equal(req.actorId, undefined);
    requireOperator(req, res, (() => assert.fail('expired session must not continue to a protected endpoint')) as NextFunction);
    assert.equal(responseState.statusCode, 401);
  } finally {
    Date.now = originalNow;
    clearSessionsForTests();
  }
});

test('non-ASCII CSRF token is rejected without throwing or reaching the protected action',()=>{
 clearSessionsForTests();const session=createOperatorSession('operator',{username:'operator',passwordHash:`scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`,ttlSeconds:1800});
 const req={headers:{cookie:`ledgerline_session=${session.token}`},method:'POST',get:()=>String.fromCharCode(233).repeat(64)} as unknown as AuthRequest;
 let status=0;const res={locals:{},status(code:number){status=code;return this;},json(){return this;}} as unknown as Response;
 sessionMiddleware(req,res,(()=>undefined) as NextFunction);assert.doesNotThrow(()=>requireOperator(req,res,(()=>assert.fail('invalid CSRF must not proceed')) as NextFunction));assert.equal(status,403);clearSessionsForTests();
});
