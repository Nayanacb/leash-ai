import type { RequestHandler } from 'express';
import type { Database } from '../db.js';
import { AppError } from '../lib/errors.js';
import { requestMeta } from '../lib/requestMeta.js';
import { apiKeyStatus, hashApiKey, looksLikeApiKey } from '../modules/agents/apiKeys.js';
import { recordAuditEvent } from '../modules/audit/auditLog.js';

export interface AgentAuth {
  agentId: string;
  userId: string;
  keyId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agentAuth?: AgentAuth;
    }
  }
}

const TOUCH_INTERVAL_MS = 60_000;

function unauthorized(): AppError {
  // One message for every failure: callers learn nothing about why a key was refused.
  return new AppError(401, 'INVALID_API_KEY', 'Invalid or inactive API key');
}

/**
 * Authenticates `Authorization: Bearer lsh_…`. Keys are checked on every
 * request, so revocation, expiry and agent suspension take effect immediately.
 * Use of a known-but-inactive key is audited as a possible compromise signal.
 */
export function agentAuth(deps: { db: Database }): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    const match = header?.match(/^Bearer\s+(\S+)$/);
    if (!match || !looksLikeApiKey(match[1]!)) throw unauthorized();

    const key = await deps.db.agentApiKey.findUnique({
      where: { keyHash: hashApiKey(match[1]!) },
      include: { agent: { select: { id: true, userId: true, status: true } } },
    });
    if (!key) throw unauthorized();

    const keyStatus = apiKeyStatus(key);
    const reason =
      keyStatus !== 'ACTIVE'
        ? `key_${keyStatus.toLowerCase()}`
        : key.agent.status !== 'ACTIVE'
          ? `agent_${key.agent.status.toLowerCase()}`
          : null;
    if (reason) {
      await recordAuditEvent(deps.db, {
        actorType: 'AGENT',
        actorId: key.agent.id,
        userId: key.agent.userId,
        action: 'agent.auth_rejected',
        data: { keyId: key.id, keyPrefix: key.prefix, reason, ...requestMeta(req) },
      });
      throw unauthorized();
    }

    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await deps.db.agentApiKey.updateMany({
        where: { id: key.id },
        data: { lastUsedAt: new Date() },
      });
    }
    req.agentAuth = { agentId: key.agent.id, userId: key.agent.userId, keyId: key.id };
    next();
  };
}
