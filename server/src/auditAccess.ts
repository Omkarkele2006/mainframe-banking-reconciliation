import type { NextFunction, Request, Response } from 'express';

/** Requires identity supplied by an existing authentication middleware; fails closed when none exists. */
export function requireAuditViewer(_req: Request, res: Response, next: NextFunction): void {
  const actorId = res.locals.actorId;
  if (typeof actorId !== 'string' || !actorId.trim()) {
    res.status(403).json({ code: 'AUDIT_ACCESS_REQUIRES_AUTH', message: 'Audit logs require an authenticated application session. This deployment has no application authentication configured.' });
    return;
  }
  next();
}
