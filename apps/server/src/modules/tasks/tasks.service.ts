import {
  MAX_TASK_DURATION_DAYS,
  MoneyParseError,
  parseDecimalToMinor,
  type AgentTaskDto,
  type CreateTaskInput,
  type Currency,
  type MerchantCategory,
  type TaskDto,
  type TaskStatus,
} from '@leash/shared';
import type { Database } from '../../db.js';
import type { Prisma, Task } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import type { Actor } from '../agents/agents.service.js';
import { appendAuditEvent } from '../audit/auditLog.js';
import {
  committedByTask,
  effectiveTaskStatus as ledgerEffectiveTaskStatus,
} from '../budget/ledger.js';

const MIN_LEAD_TIME_MS = 60_000;
const DAY_MS = 86_400_000;

type TaskWithAgent = Task & { agent: { id: string; name: string } };

/** An ACTIVE task whose expiry has passed is EXPIRED, whether or not a job has persisted that yet. */
export function effectiveTaskStatus(
  task: Pick<Task, 'status' | 'expiresAt'>,
  now = new Date(),
): TaskStatus {
  return ledgerEffectiveTaskStatus(task, now);
}

function whereEffectiveStatus(
  status: TaskStatus | undefined,
  now = new Date(),
): Prisma.TaskWhereInput {
  switch (status) {
    case undefined:
      return {};
    case 'ACTIVE':
      return { status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
    case 'EXPIRED':
      return { OR: [{ status: 'EXPIRED' }, { status: 'ACTIVE', expiresAt: { lte: now } }] };
    default:
      return { status };
  }
}

async function merchantsById(db: Database, userId: string, tasks: Task[]) {
  const ids = [...new Set(tasks.flatMap((t) => t.allowedMerchantIds))];
  if (ids.length === 0)
    return new Map<
      string,
      { id: string; displayName: string; category: string; archivedAt: Date | null }
    >();
  // Scoped by userId: a task can never surface another user's merchant.
  const merchants = await db.merchant.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true, displayName: true, category: true, archivedAt: true },
  });
  return new Map(merchants.map((m) => [m.id, m]));
}

async function toTaskDtos(
  db: Database,
  userId: string,
  tasks: TaskWithAgent[],
): Promise<TaskDto[]> {
  const [committed, merchants] = await Promise.all([
    committedByTask(
      db,
      tasks.map((t) => t.id),
    ),
    merchantsById(db, userId, tasks),
  ]);
  const now = new Date();
  return tasks.map((t) => {
    const spent = committed.get(t.id) ?? 0;
    return {
      id: t.id,
      instruction: t.instruction,
      budgetMinor: t.budgetMinor,
      currency: t.currency as Currency,
      committedMinor: spent,
      remainingMinor: Math.max(0, t.budgetMinor - spent),
      agent: { id: t.agent.id, name: t.agent.name },
      allowedMerchants: t.allowedMerchantIds.flatMap((id) => {
        const m = merchants.get(id);
        return m
          ? [
              {
                id: m.id,
                displayName: m.displayName,
                category: m.category as MerchantCategory,
                archived: m.archivedAt !== null,
              },
            ]
          : [];
      }),
      status: effectiveTaskStatus(t, now),
      expiresAt: t.expiresAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  });
}

const withAgent = { agent: { select: { id: true, name: true } } } as const;

export async function listTasks(
  db: Database,
  userId: string,
  status?: TaskStatus,
): Promise<TaskDto[]> {
  const tasks = await db.task.findMany({
    where: { userId, ...whereEffectiveStatus(status) },
    orderBy: { createdAt: 'desc' },
    include: withAgent,
  });
  return toTaskDtos(db, userId, tasks);
}

export async function getTask(db: Database, userId: string, id: string): Promise<TaskDto> {
  const task = await db.task.findFirst({ where: { id, userId }, include: withAgent });
  if (!task) throw AppError.notFound('Task not found');
  return (await toTaskDtos(db, userId, [task]))[0]!;
}

function invalidReference(message: string): AppError {
  return new AppError(400, 'INVALID_REFERENCE', message);
}

/** Tasks are created only through an authenticated user session — never by an agent. */
export async function createTask(
  db: Database,
  actor: Actor,
  input: CreateTaskInput,
): Promise<TaskDto> {
  let budgetMinor: number;
  try {
    budgetMinor = parseDecimalToMinor(input.budget.value, input.budget.currency);
  } catch (err) {
    if (err instanceof MoneyParseError) throw AppError.badRequest(err.message);
    throw err;
  }
  if (budgetMinor <= 0) throw AppError.badRequest('Budget must be greater than zero');

  const expiresAt = new Date(input.expiresAt);
  const now = Date.now();
  if (expiresAt.getTime() < now + MIN_LEAD_TIME_MS)
    throw AppError.badRequest('Expiry must be in the future');
  if (expiresAt.getTime() > now + MAX_TASK_DURATION_DAYS * DAY_MS) {
    throw AppError.badRequest(`Tasks can run for at most ${MAX_TASK_DURATION_DAYS} days`);
  }

  const task = await db.$transaction(async (tx) => {
    const agent = await tx.agent.findFirst({ where: { id: input.agentId, userId: actor.userId } });
    if (!agent) throw invalidReference('Agent not found');
    if (agent.status === 'REVOKED')
      throw invalidReference('Cannot assign a task to a revoked agent');

    const merchants = await tx.merchant.findMany({
      where: { id: { in: input.allowedMerchantIds }, userId: actor.userId, archivedAt: null },
      select: { id: true },
    });
    if (merchants.length !== input.allowedMerchantIds.length) {
      throw invalidReference('One or more merchants were not found or are archived');
    }

    const created = await tx.task.create({
      data: {
        userId: actor.userId,
        agentId: agent.id,
        instruction: input.instruction,
        budgetMinor,
        currency: input.budget.currency,
        allowedMerchantIds: input.allowedMerchantIds,
        expiresAt,
      },
      include: withAgent,
    });
    await appendAuditEvent(tx, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      action: 'task.created',
      data: {
        taskId: created.id,
        agentId: agent.id,
        instruction: input.instruction,
        budgetMinor,
        currency: input.budget.currency,
        allowedMerchantIds: input.allowedMerchantIds,
        expiresAt,
        ...actor.meta,
      },
    });
    return created;
  });
  return (await toTaskDtos(db, actor.userId, [task]))[0]!;
}

/** Ends an ACTIVE, unexpired task. The mandate itself is never edited. */
export async function finishTask(
  db: Database,
  actor: Actor,
  id: string,
  outcome: 'CANCELLED' | 'COMPLETED',
): Promise<TaskDto> {
  await db.$transaction(async (tx) => {
    const task = await tx.task.findFirst({ where: { id, userId: actor.userId } });
    if (!task) throw AppError.notFound('Task not found');
    const { count } = await tx.task.updateMany({
      where: { id, userId: actor.userId, ...whereEffectiveStatus('ACTIVE') },
      data: { status: outcome },
    });
    if (count === 0) {
      throw new AppError(
        409,
        'TASK_NOT_ACTIVE',
        `Task is ${effectiveTaskStatus(task).toLowerCase()}`,
      );
    }
    await appendAuditEvent(tx, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      action: outcome === 'CANCELLED' ? 'task.cancelled' : 'task.completed',
      data: { taskId: id, ...actor.meta },
    });
  });
  return getTask(db, actor.userId, id);
}

// ── Agent-facing (read-only) ────────────────────────────────────────────────

function toAgentTaskDto(t: TaskDto): AgentTaskDto {
  return {
    id: t.id,
    instruction: t.instruction,
    budgetMinor: t.budgetMinor,
    remainingMinor: t.remainingMinor,
    currency: t.currency,
    status: t.status,
    expiresAt: t.expiresAt,
    allowedMerchants: t.allowedMerchants
      .filter((m) => !m.archived)
      .map(({ id, displayName, category }) => ({ id, displayName, category })),
  };
}

export async function listTasksForAgent(
  db: Database,
  agent: { agentId: string; userId: string },
  status?: TaskStatus,
): Promise<AgentTaskDto[]> {
  const tasks = await db.task.findMany({
    where: { agentId: agent.agentId, userId: agent.userId, ...whereEffectiveStatus(status) },
    orderBy: { createdAt: 'desc' },
    include: withAgent,
  });
  return (await toTaskDtos(db, agent.userId, tasks)).map(toAgentTaskDto);
}

export async function getTaskForAgent(
  db: Database,
  agent: { agentId: string; userId: string },
  id: string,
): Promise<AgentTaskDto> {
  // Same 404 whether the task doesn't exist or belongs to another agent.
  const task = await db.task.findFirst({
    where: { id, agentId: agent.agentId, userId: agent.userId },
    include: withAgent,
  });
  if (!task) throw AppError.notFound('Task not found');
  return toAgentTaskDto((await toTaskDtos(db, agent.userId, [task]))[0]!);
}
