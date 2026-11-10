import {
  PolicyDocumentSchema,
  type Currency,
  type MerchantCategory,
  type Period,
  type PolicyDocument,
} from '@leash/shared';
import type { Database } from '../../db.js';
import type { Prisma, TransactionStatus } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { appendAuditEvent } from '../audit/auditLog.js';
import {
  evaluatePolicy,
  type EngineLimits,
  type PolicyEvaluation,
  type SpendSnapshot,
} from '../authorization/policyEngine.js';
import { PERIODS, periodBounds } from './periods.js';

type Tx = Prisma.TransactionClient;

/** Namespace for the per-user budget lock (two-key advisory locks never collide with the audit chain's one-key lock). */
const BUDGET_LOCK_NAMESPACE = 0x4c45_4144; // "LEAD"

/**
 * Serializes every spend decision for one user. Held until the surrounding
 * transaction commits, so "read committed spend → decide → reserve" is atomic
 * with respect to concurrent purchases by the same user. Different users never
 * wait on each other.
 */
export async function lockUserBudget(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_NAMESPACE}::int, hashtext(${userId}))`;
}

/** Statuses that mean the user has genuinely bought from a merchant before (for `new_merchant`). */
const HISTORY_STATUSES: TransactionStatus[] = [
  'AUTHORIZED',
  'ORDER_CREATED',
  'BUYER_APPROVED',
  'CAPTURING',
  'CAPTURED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
];

/** Timestamps are compared in UTC regardless of the database session's time zone. */
const utc = (d: Date) => d.toISOString();

export interface PeriodSpend {
  committedMinor: number;
  transactionCount: number;
}

/**
 * Committed spend (Σ RESERVE − Σ RELEASE − Σ REFUND) and the number of
 * still-reserved purchases in each calendar period containing `at`.
 * A purchase counts toward the period in which it was reserved.
 */
export async function periodSpend(
  tx: Tx | Database,
  userId: string,
  currency: Currency,
  timezone: string,
  at: Date,
  /** Leave one transaction out (e.g. the purchase being re-checked for approval). */
  excludeTransactionId: string | null = null,
): Promise<Record<Period, PeriodSpend>> {
  const bounds = Object.fromEntries(
    PERIODS.map((p) => [p, periodBounds(at, p, timezone)]),
  ) as Record<Period, { start: Date; end: Date }>;
  const earliest = new Date(Math.min(...PERIODS.map((p) => bounds[p].start.getTime())));
  const latest = new Date(Math.max(...PERIODS.map((p) => bounds[p].end.getTime())));

  const [row] = await tx.$queryRaw<
    {
      day_spend: bigint;
      week_spend: bigint;
      month_spend: bigint;
      day_count: number;
      week_count: number;
      month_count: number;
    }[]
  >`
    WITH per_tx AS (
      SELECT t."createdAt" AS at,
             SUM(CASE WHEN l."type" = 'RESERVE' THEN l."amountMinor" ELSE -l."amountMinor" END) AS net,
             bool_or(l."type" = 'RELEASE') AS released
        FROM "LedgerEntry" l
        JOIN "Transaction" t ON t."id" = l."transactionId"
       WHERE l."userId" = ${userId}::uuid
         AND l."currency" = ${currency}
         AND (${excludeTransactionId}::uuid IS NULL OR t."id" <> ${excludeTransactionId}::uuid)
         AND t."createdAt" >= (${utc(earliest)}::timestamptz AT TIME ZONE 'UTC')
         AND t."createdAt" <  (${utc(latest)}::timestamptz AT TIME ZONE 'UTC')
       GROUP BY t."id", t."createdAt"
    )
    SELECT
      COALESCE(SUM(net) FILTER (WHERE at >= (${utc(bounds.day.start)}::timestamptz AT TIME ZONE 'UTC') AND at < (${utc(bounds.day.end)}::timestamptz AT TIME ZONE 'UTC')), 0)::bigint AS day_spend,
      COALESCE(SUM(net) FILTER (WHERE at >= (${utc(bounds.week.start)}::timestamptz AT TIME ZONE 'UTC') AND at < (${utc(bounds.week.end)}::timestamptz AT TIME ZONE 'UTC')), 0)::bigint AS week_spend,
      COALESCE(SUM(net) FILTER (WHERE at >= (${utc(bounds.month.start)}::timestamptz AT TIME ZONE 'UTC') AND at < (${utc(bounds.month.end)}::timestamptz AT TIME ZONE 'UTC')), 0)::bigint AS month_spend,
      (COUNT(*) FILTER (WHERE NOT released AND at >= (${utc(bounds.day.start)}::timestamptz AT TIME ZONE 'UTC') AND at < (${utc(bounds.day.end)}::timestamptz AT TIME ZONE 'UTC')))::int AS day_count,
      (COUNT(*) FILTER (WHERE NOT released AND at >= (${utc(bounds.week.start)}::timestamptz AT TIME ZONE 'UTC') AND at < (${utc(bounds.week.end)}::timestamptz AT TIME ZONE 'UTC')))::int AS week_count,
      (COUNT(*) FILTER (WHERE NOT released AND at >= (${utc(bounds.month.start)}::timestamptz AT TIME ZONE 'UTC') AND at < (${utc(bounds.month.end)}::timestamptz AT TIME ZONE 'UTC')))::int AS month_count
    FROM per_tx`;

  return {
    day: { committedMinor: Number(row?.day_spend ?? 0), transactionCount: row?.day_count ?? 0 },
    week: { committedMinor: Number(row?.week_spend ?? 0), transactionCount: row?.week_count ?? 0 },
    month: {
      committedMinor: Number(row?.month_spend ?? 0),
      transactionCount: row?.month_count ?? 0,
    },
  };
}

/** Committed spend per task from the ledger. */
export async function committedByTask(
  tx: Tx | Database,
  taskIds: string[],
  excludeTransactionId: string | null = null,
): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ taskId: string; committed: bigint }[]>`
    SELECT t."taskId" AS "taskId",
           COALESCE(SUM(CASE WHEN l."type" = 'RESERVE' THEN l."amountMinor" ELSE -l."amountMinor" END), 0)::bigint AS committed
      FROM "LedgerEntry" l
      JOIN "Transaction" t ON t."id" = l."transactionId"
     WHERE t."taskId" = ANY(${taskIds}::uuid[])
       AND (${excludeTransactionId}::uuid IS NULL OR t."id" <> ${excludeTransactionId}::uuid)
     GROUP BY t."taskId"`;
  return new Map(rows.map((r) => [r.taskId, Number(r.committed)]));
}

export async function loadSpendSnapshot(
  tx: Tx | Database,
  input: {
    userId: string;
    policy: PolicyDocument | null;
    currency: Currency;
    merchantId: string;
    amountMinor: number;
    at: Date;
    excludeTransactionId?: string | null;
  },
): Promise<SpendSnapshot> {
  const timezone = input.policy?.timezone ?? 'UTC';
  const duplicateMinutes = Math.max(
    0,
    ...(input.policy?.rules ?? []).map((r) => (r.type === 'duplicate_window' ? r.minutes : 0)),
  );

  const [periods, history, similar] = await Promise.all([
    periodSpend(
      tx,
      input.userId,
      input.currency,
      timezone,
      input.at,
      input.excludeTransactionId ?? null,
    ),
    tx.transaction.count({
      where: {
        userId: input.userId,
        merchantId: input.merchantId,
        status: { in: HISTORY_STATUSES },
      },
    }),
    duplicateMinutes === 0
      ? Promise.resolve([])
      : tx.transaction.findMany({
          where: {
            userId: input.userId,
            ...(input.excludeTransactionId ? { id: { not: input.excludeTransactionId } } : {}),
            merchantId: input.merchantId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            createdAt: {
              gte: new Date(input.at.getTime() - duplicateMinutes * 60_000),
              lte: input.at,
            },
            // Still holding a reservation: failed or rejected attempts don't count as duplicates.
            AND: [
              { ledgerEntries: { some: { type: 'RESERVE' } } },
              { ledgerEntries: { none: { type: 'RELEASE' } } },
            ],
          },
          select: { createdAt: true },
        }),
  ]);
  return {
    periods,
    merchantHasHistory: history > 0,
    similarPurchaseTimes: similar.map((t) => t.createdAt),
  };
}

/** Loads and strictly re-validates the user's ACTIVE policy. A stored policy that no longer validates counts as none. */
export async function loadActivePolicy(
  tx: Tx | Database,
  userId: string,
): Promise<{ id: string; version: number; document: PolicyDocument } | null> {
  const active = await tx.policyVersion.findFirst({ where: { userId, status: 'ACTIVE' } });
  if (!active) return null;
  const parsed = PolicyDocumentSchema.safeParse(active.compiledRules);
  return parsed.success ? { id: active.id, version: active.version, document: parsed.data } : null;
}

export function effectiveTaskStatus(task: { status: string; expiresAt: Date | null }, at: Date) {
  if (task.status === 'ACTIVE' && task.expiresAt && task.expiresAt.getTime() <= at.getTime())
    return 'EXPIRED' as const;
  return task.status as 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
}

// ── Reservation ─────────────────────────────────────────────────────────────

export interface ReservationRequest {
  userId: string;
  agentId: string;
  taskId: string;
  merchantId: string;
  idempotencyKey: string;
  /** Hash of the canonical request, to detect a reused idempotency key with a different payload. */
  requestHash: string;
  amountMinor: number;
  currency: Currency;
  itemDescription: string;
  quantity: number;
  category?: string | null;
  agentJustification?: string | null;
  untrustedContext?: Prisma.InputJsonValue | null;
  /** Evaluation time; defaults to now. */
  at?: Date;
}

export interface ReservationResult {
  transactionId: string;
  /** Policy-layer decision only. The final decision (Phase 5) may be stricter, never looser. */
  policyDecision: PolicyEvaluation['decision'];
  reasonCodes: string[];
  evaluation: PolicyEvaluation;
  reservedMinor: number;
  policyVersionId: string | null;
  /** True when this is a replay of an earlier request with the same idempotency key. */
  replayed: boolean;
}

/**
 * Evaluates the deterministic policy for a purchase and, unless it is
 * BLOCKED, reserves the amount — atomically, under the user's budget lock.
 *
 * Concurrency guarantee: for any one user, evaluations and reservations are
 * strictly serialized, and each evaluation sees every earlier reservation. So
 * no interleaving of concurrent purchases can take committed spend past a
 * limit that each purchase was checked against.
 */
export async function reserveForPurchase(
  db: Database,
  request: ReservationRequest,
  limits: EngineLimits,
): Promise<ReservationResult> {
  const at = request.at ?? new Date();

  return db.$transaction(async (tx) => {
    await lockUserBudget(tx, request.userId);

    const existing = await tx.transaction.findUnique({
      where: {
        agentId_idempotencyKey: {
          agentId: request.agentId,
          idempotencyKey: request.idempotencyKey,
        },
      },
      include: { evaluations: { where: { layer: 'POLICY' } }, ledgerEntries: true },
    });
    if (existing) {
      if (existing.requestHash !== request.requestHash) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used for a different request',
        );
      }
      const evaluation = existing.evaluations[0]?.details as unknown as PolicyEvaluation;
      return {
        transactionId: existing.id,
        policyDecision: evaluation.decision,
        reasonCodes: evaluation.reasonCodes,
        evaluation,
        reservedMinor: existing.ledgerEntries
          .filter((l) => l.type === 'RESERVE')
          .reduce((s, l) => s + l.amountMinor, 0),
        policyVersionId: existing.policyVersionId,
        replayed: true,
      };
    }

    const task = await tx.task.findFirst({
      where: { id: request.taskId, userId: request.userId, agentId: request.agentId },
    });
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
    const merchant = await tx.merchant.findFirst({
      where: { id: request.merchantId, userId: request.userId },
    });
    if (!merchant) throw new AppError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');

    const policy = await loadActivePolicy(tx, request.userId);
    const [taskCommitted, spend] = await Promise.all([
      committedByTask(tx, [task.id]),
      loadSpendSnapshot(tx, {
        userId: request.userId,
        policy: policy?.document ?? null,
        currency: request.currency,
        merchantId: merchant.id,
        amountMinor: request.amountMinor,
        at,
      }),
    ]);

    const evaluation = evaluatePolicy(
      policy?.document ?? null,
      {
        amountMinor: request.amountMinor,
        currency: request.currency,
        merchantId: merchant.id,
        merchantCategory: merchant.category as MerchantCategory,
        merchantArchived: merchant.archivedAt !== null,
        at,
      },
      {
        status: effectiveTaskStatus(task, at),
        currency: task.currency as Currency,
        budgetMinor: task.budgetMinor,
        committedMinor: taskCommitted.get(task.id) ?? 0,
        allowedMerchantIds: task.allowedMerchantIds,
      },
      spend,
      limits,
    );
    const blocked = evaluation.decision === 'BLOCK';

    const transaction = await tx.transaction.create({
      data: {
        userId: request.userId,
        agentId: request.agentId,
        taskId: task.id,
        merchantId: merchant.id,
        policyVersionId: policy?.id ?? null,
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        amountMinor: request.amountMinor,
        currency: request.currency,
        itemDescription: request.itemDescription,
        quantity: request.quantity,
        category: request.category ?? null,
        agentJustification: request.agentJustification ?? null,
        ...(request.untrustedContext !== null && request.untrustedContext !== undefined
          ? { untrustedContext: request.untrustedContext }
          : {}),
        // A policy BLOCK is final. Otherwise the purchase awaits the AI layers (Phase 5) with funds reserved.
        status: blocked ? 'BLOCKED' : 'EVALUATING',
        decision: blocked ? 'BLOCK' : null,
        reasonCodes: evaluation.reasonCodes,
        createdAt: at,
      },
    });

    await tx.evaluation.create({
      data: {
        transactionId: transaction.id,
        layer: 'POLICY',
        verdict: blocked ? 'BLOCK' : evaluation.decision === 'ESCALATE' ? 'ESCALATE' : 'PASS',
        details: evaluation as unknown as Prisma.InputJsonObject,
      },
    });

    if (!blocked) {
      await tx.ledgerEntry.create({
        data: {
          userId: request.userId,
          transactionId: transaction.id,
          type: 'RESERVE',
          amountMinor: request.amountMinor,
          currency: request.currency,
          createdAt: at,
        },
      });
    }

    await appendAuditEvent(tx, {
      actorType: 'AGENT',
      actorId: request.agentId,
      userId: request.userId,
      transactionId: transaction.id,
      action: 'purchase.policy_evaluated',
      data: {
        policyDecision: evaluation.decision,
        reasonCodes: evaluation.reasonCodes,
        policyVersionId: policy?.id ?? null,
        policyVersion: policy?.version ?? null,
        amountMinor: request.amountMinor,
        currency: request.currency,
        merchantId: merchant.id,
        taskId: task.id,
        reservedMinor: blocked ? 0 : request.amountMinor,
      },
    });

    return {
      transactionId: transaction.id,
      policyDecision: evaluation.decision,
      reasonCodes: evaluation.reasonCodes,
      evaluation,
      reservedMinor: blocked ? 0 : request.amountMinor,
      policyVersionId: policy?.id ?? null,
      replayed: false,
    };
  });
}

/**
 * Releases whatever is still reserved for a transaction (e.g. it was rejected,
 * expired, blocked by an AI layer, or payment failed). Idempotent: a second
 * call releases nothing.
 */
export interface ReleaseInput {
  userId: string;
  transactionId: string;
  reason: string;
  actor: { type: 'USER' | 'SYSTEM' | 'AGENT'; id: string | null };
}

/**
 * Releases whatever is still reserved for a transaction, inside a transaction
 * that already holds the user's budget lock. Writes the RELEASE entry and its
 * audit event; releases nothing (and records nothing) if nothing is held.
 */
export async function releaseWithinTransaction(
  tx: Tx,
  input: ReleaseInput,
): Promise<{ releasedMinor: number }> {
  const transaction = await tx.transaction.findFirst({
    where: { id: input.transactionId, userId: input.userId },
    include: { ledgerEntries: true },
  });
  if (!transaction) throw new AppError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');

  const reserved = transaction.ledgerEntries
    .filter((l) => l.type === 'RESERVE')
    .reduce((s, l) => s + l.amountMinor, 0);
  const released = transaction.ledgerEntries
    .filter((l) => l.type === 'RELEASE')
    .reduce((s, l) => s + l.amountMinor, 0);
  const outstanding = reserved - released;
  if (outstanding <= 0) return { releasedMinor: 0 };

  await tx.ledgerEntry.create({
    data: {
      userId: input.userId,
      transactionId: transaction.id,
      type: 'RELEASE',
      amountMinor: outstanding,
      currency: transaction.currency,
    },
  });
  await appendAuditEvent(tx, {
    actorType: input.actor.type,
    actorId: input.actor.id,
    userId: input.userId,
    transactionId: transaction.id,
    action: 'purchase.reservation_released',
    data: { releasedMinor: outstanding, currency: transaction.currency, reason: input.reason },
  });
  return { releasedMinor: outstanding };
}

/**
 * Releases whatever is still reserved for a transaction (e.g. it was rejected,
 * expired, blocked by an AI layer, or payment failed). Idempotent: a second
 * call releases nothing.
 */
export async function releaseReservation(
  db: Database,
  input: ReleaseInput,
): Promise<{ releasedMinor: number }> {
  return db.$transaction(async (tx) => {
    await lockUserBudget(tx, input.userId);
    return releaseWithinTransaction(tx, input);
  });
}
