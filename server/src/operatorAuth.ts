import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = 'ledgerline_session';
const sessions = new Map<string, { actorId: string; csrfToken: string; expiresAt: number }>();

export type AuthConfiguration = { username?: string; passwordHash?: string; ttlSeconds?: number; secureCookies?: boolean };
export type AuthRequest = Request & { actorId?: string; csrfToken?: string };

export function authConfiguration(env: NodeJS.ProcessEnv = process.env): AuthConfiguration {
  const ttlSeconds = Number(env.APP_SESSION_TTL_SECONDS ?? 1800);
  return {
    username: env.APP_OPERATOR_USERNAME,
    passwordHash: env.APP_OPERATOR_PASSWORD_SCRYPT,
    ttlSeconds: Number.isInteger(ttlSeconds) && ttlSeconds >= 300 && ttlSeconds <= 28_800 ? ttlSeconds : undefined,
    secureCookies: env.NODE_ENV === 'production',
  };
}

export function authConfigured(config = authConfiguration()): boolean {
  return Boolean(config.username && config.username.length <= 120 && parseHash(config.passwordHash) && config.ttlSeconds);
}

function parseHash(value?: string): { salt: Buffer; hash: Buffer } | undefined {
  if (!value) return undefined;
  const match = /^scrypt\$([a-f\d]{32,128})\$([a-f\d]{128})$/i.exec(value);
  return match ? { salt: Buffer.from(match[1]!, 'hex'), hash: Buffer.from(match[2]!, 'hex') } : undefined;
}

export async function verifyOperatorPassword(password: string, config = authConfiguration()): Promise<boolean> {
  const parsed = parseHash(config.passwordHash);
  if (!parsed || typeof password !== 'string' || password.length < 1 || password.length > 1024) return false;
  const derived = await scrypt(password, parsed.salt, parsed.hash.length) as Buffer;
  return timingSafeEqual(derived, parsed.hash);
}

export async function hashOperatorPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Operator password must be between 12 and 1024 characters.');
  const salt = randomBytes(24);
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function cookieToken(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header || header.length > 4096) return undefined;
  const pair = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const token = pair?.slice(COOKIE_NAME.length + 1);
  return token && /^[a-f\d]{64}$/i.test(token) ? token : undefined;
}

export function sessionMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = cookieToken(req);
  const session = token ? sessions.get(token) : undefined;
  if (!session) return next();
  if (session.expiresAt <= Date.now()) { sessions.delete(token!); return next(); }
  req.actorId = session.actorId;
  req.csrfToken = session.csrfToken;
  res.locals.actorId = session.actorId;
  next();
}

export function requireOperator(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.actorId) { res.status(401).json({ code: 'AUTHENTICATION_REQUIRED', message: 'Sign in with the server-configured operator account to use this protected action.' }); return; }
  const token = cookieToken(req);
  const session = token ? sessions.get(token) : undefined;
  const supplied = req.get('x-csrf-token') ?? '';
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && (!session || supplied.length !== session.csrfToken.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrfToken)))) {
    res.status(403).json({ code: 'CSRF_REJECTED', message: 'The session request token is missing or invalid. Refresh the page and try again.' }); return;
  }
  next();
}

export function createOperatorSession(actorId: string, config = authConfiguration()): { token: string; csrfToken: string; expiresAt: Date } {
  if (!authConfigured(config) || !config.ttlSeconds || !/^[\w.@-]{1,120}$/.test(actorId)) throw new Error('OPERATOR_AUTH_NOT_CONFIGURED');
  for (const [token, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(token);
  if (sessions.size >= 1000) throw new Error('OPERATOR_SESSION_CAPACITY');
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.ttlSeconds * 1000);
  sessions.set(token, { actorId, csrfToken, expiresAt: expiresAt.getTime() });
  return { token, csrfToken, expiresAt };
}

export function revokeOperatorSession(req: Request): void {
  const token = cookieToken(req);
  if (token) sessions.delete(token);
}

export function sessionCookie(token: string, config = authConfiguration()): string {
  return `${COOKIE_NAME}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${config.ttlSeconds ?? 0}${config.secureCookies ? '; Secure' : ''}`;
}

export function clearSessionCookie(config = authConfiguration()): string {
  return `${COOKIE_NAME}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${config.secureCookies ? '; Secure' : ''}`;
}

export function authSessionView(req: AuthRequest): { authenticated: boolean; actorId?: string; csrfToken?: string } {
  return req.actorId ? { authenticated: true, actorId: req.actorId, csrfToken: req.csrfToken } : { authenticated: false };
}

export function clearSessionsForTests(): void { sessions.clear(); }
