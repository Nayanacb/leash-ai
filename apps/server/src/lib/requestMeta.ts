import type { Request } from 'express';

/** Client metadata recorded in audit events. Truncated so hostile values can't bloat the log. */
export function requestMeta(req: Request): { ip: string | null; userAgent: string | null } {
  const ua = req.get('user-agent');
  return {
    ip: req.ip ?? null,
    userAgent: ua ? ua.slice(0, 256) : null,
  };
}
