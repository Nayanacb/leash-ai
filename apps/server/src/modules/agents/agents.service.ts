import type {
  AgentDetailDto,
  AgentDto,
  AgentStatus,
  ApiKeyDto,
  CreatedApiKeyResponse,
} from '@leash/shared';
import type { Database } from '../../db.js';
import type { Agent, AgentApiKey } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { appendAuditEvent } from '../audit/auditLog.js';
import { apiKeyStatus, generateApiKey } from './apiKeys.js';

/** Active (unrevoked, unexpired) keys allowed per agent. */
export const MAX_ACTIVE_KEYS_PER_AGENT = 5;

const DAY_MS = 86_400_000;

export interface Actor {
  userId: string;
  meta: { ip: string | null; userAgent: string | null };
}

function activeKeyWhere(now = new Date()) {
  return { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

export function toApiKeyDto(key: AgentApiKey): ApiKeyDto {
  return {
    id: key.id,
    label: key.label,
    prefix: key.prefix,
    status: apiKeyStatus(key),
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

function toAgentDto(agent: Agent, activeKeyCount: number): AgentDto {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    activeKeyCount,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

export async function listAgents(db: Database, userId: string): Promise<AgentDto[]> {
  const agents = await db.agent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { apiKeys: { where: activeKeyWhere() } } } },
  });
  return agents.map((a) => toAgentDto(a, a._count.apiKeys));
}

export async function getAgent(
  db: Database,
  userId: string,
  agentId: string,
): Promise<AgentDetailDto> {
  const agent = await db.agent.findFirst({
    where: { id: agentId, userId },
    include: { apiKeys: { orderBy: { createdAt: 'desc' } } },
  });
  if (!agent) throw AppError.notFound('Agent not found');
  const keys = agent.apiKeys.map(toApiKeyDto);
  return { ...toAgentDto(agent, keys.filter((k) => k.status === 'ACTIVE').length), apiKeys: keys };
}

export async function createAgent(db: Database, actor: Actor, name: string): Promise<AgentDto> {
  const agent = await db.$transaction(async (tx) => {
    const created = await tx.agent.create({ data: { userId: actor.userId, name } });
    await appendAuditEvent(tx, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      action: 'agent.created',
      data: { agentId: created.id, name, ...actor.meta },
    });
    return created;
  });
  return toAgentDto(agent, 0);
}

const STATUS_ACTIONS: Record<AgentStatus, string> = {
  ACTIVE: 'agent.reactivated',
  SUSPENDED: 'agent.suspended',
  REVOKED: 'agent.revoked',
};

export async function updateAgent(
  db: Database,
  actor: Actor,
  agentId: string,
  patch: { name?: string; status?: AgentStatus },
): Promise<AgentDetailDto> {
  await db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({ where: { id: agentId, userId: actor.userId } });
    if (!agent) throw AppError.notFound('Agent not found');
    if (agent.status === 'REVOKED') {
      throw AppError.conflict('A revoked agent cannot be changed. Create a new agent instead.');
    }

    const statusChanging = patch.status !== undefined && patch.status !== agent.status;
    const nameChanging = patch.name !== undefined && patch.name !== agent.name;
    if (!statusChanging && !nameChanging) return;

    // Compare-and-swap on the status we read, so concurrent changes cannot interleave.
    const { count } = await tx.agent.updateMany({
      where: { id: agent.id, userId: actor.userId, status: agent.status },
      data: {
        ...(nameChanging ? { name: patch.name } : {}),
        ...(statusChanging ? { status: patch.status } : {}),
      },
    });
    if (count === 0)
      throw AppError.conflict('Agent was modified concurrently; reload and try again');

    let keysRevoked = 0;
    if (patch.status === 'REVOKED') {
      ({ count: keysRevoked } = await tx.agentApiKey.updateMany({
        where: { agentId: agent.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }));
    }

    if (nameChanging) {
      await appendAuditEvent(tx, {
        actorType: 'USER',
        actorId: actor.userId,
        userId: actor.userId,
        action: 'agent.renamed',
        data: { agentId: agent.id, from: agent.name, to: patch.name, ...actor.meta },
      });
    }
    if (statusChanging) {
      await appendAuditEvent(tx, {
        actorType: 'USER',
        actorId: actor.userId,
        userId: actor.userId,
        action: STATUS_ACTIONS[patch.status!],
        data: {
          agentId: agent.id,
          from: agent.status,
          to: patch.status,
          keysRevoked,
          ...actor.meta,
        },
      });
    }
  });
  return getAgent(db, actor.userId, agentId);
}

export async function createApiKey(
  db: Database,
  actor: Actor,
  agentId: string,
  input: { label?: string | undefined; expiresInDays: number },
): Promise<CreatedApiKeyResponse> {
  const generated = generateApiKey();
  const key = await db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({ where: { id: agentId, userId: actor.userId } });
    if (!agent) throw AppError.notFound('Agent not found');
    if (agent.status !== 'ACTIVE')
      throw AppError.conflict(`Cannot create keys for a ${agent.status.toLowerCase()} agent`);

    const active = await tx.agentApiKey.count({ where: { agentId, ...activeKeyWhere() } });
    if (active >= MAX_ACTIVE_KEYS_PER_AGENT) {
      throw AppError.conflict(
        `An agent can have at most ${MAX_ACTIVE_KEYS_PER_AGENT} active keys. Revoke one first.`,
      );
    }

    const created = await tx.agentApiKey.create({
      data: {
        agentId,
        label: input.label ?? null,
        prefix: generated.prefix,
        keyHash: generated.hash,
        expiresAt: new Date(Date.now() + input.expiresInDays * DAY_MS),
      },
    });
    await appendAuditEvent(tx, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      action: 'agent_key.created',
      data: {
        agentId,
        keyId: created.id,
        keyPrefix: created.prefix,
        label: created.label,
        expiresAt: created.expiresAt,
        ...actor.meta,
      },
    });
    return created;
  });
  return { apiKey: toApiKeyDto(key), secret: generated.secret };
}

/** Revocation is immediate (keys are checked on every request) and idempotent. */
export async function revokeApiKey(
  db: Database,
  actor: Actor,
  agentId: string,
  keyId: string,
): Promise<ApiKeyDto> {
  return db.$transaction(async (tx) => {
    const key = await tx.agentApiKey.findFirst({
      where: { id: keyId, agentId, agent: { userId: actor.userId } },
    });
    if (!key) throw AppError.notFound('API key not found');
    if (key.revokedAt) return toApiKeyDto(key);

    const revoked = await tx.agentApiKey.update({
      where: { id: key.id },
      data: { revokedAt: new Date() },
    });
    await appendAuditEvent(tx, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      action: 'agent_key.revoked',
      data: { agentId, keyId: key.id, keyPrefix: key.prefix, ...actor.meta },
    });
    return toApiKeyDto(revoked);
  });
}
