import type {
  ApprovalDto,
  ApprovalStatus,
  Currency,
  MerchantCategory,
  TransactionDetailDto,
} from '@leash/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import type { Actor } from '../agents/agents.service.js';
import { appendAuditEvent } from '../audit/auditLog.js';
import { evaluatePolicy, type PolicyEvaluation } from '../authorization/policyEngine.js';
import {
  committedByTask,
  effectiveTaskStatus,
  loadActivePolicy,
  loadSpendSnapshot,
  lockUserBudget,
  releaseWithinTransaction,
} from '../budget/ledger.js';
import { purchaseSnapshotHash } from '../purchases/snapshot.js';
import { getTransaction } from '../purchases/transactions.service.js';

interface Deps {
  db: Database;
  config: AppConfig;
}

const summaryInclude = {
  transaction: {
    include: {
      agent: { select: { id: true, name: true } },
      merchant: { select: { id: true, displayName: true, paypalEmail: true } },
    },
  },
} as const;

type ApprovalRow = Prisma.ApprovalGetPayload<{ include: typeof summaryInclude }>;

function toApprovalDto(a: ApprovalRow): ApprovalDto {
  const t = a.transaction;
  return {
    id: a.id,
    status: a.status,
    requestedAt: a.requestedAt.toISOString(),
    expiresAt: a.expiresAt.toISOString(),
    decidedAt: a.decidedAt?.toISOString() ?? null,
    note: a.note,
    snapshotHash: a.snapshotHash,
    payee: t.merchant?.paypalEmail ?? null,
    transaction: {
      id: t.id,
      status: t.status,
      decision: t.decision,
      amountMinor: t.amountMinor,
      currency: t.currency as Currency,
      itemDescription: t.itemDescription,
      agent: t.agent,
      merchant: t.merchant ? { id: t.merchant.id, displayName: t.merchant.displayName } : null,
      taskId: t.taskId,
      reasonCodes: t.reasonCodes,
      createdAt: t.createdAt.toISOString(),
    },
  };
}

export async function listApprovals(
  db: Database,
  userId: string,
  query: { status: ApprovalStatus; limit: number },
): Promise<{ approvals: ApprovalDto[]; pendingCount: number }> {
  const now = new Date();
  const [rows, pendingCount] = await Promise.all([
    db.approval.findMany({
      where: { status: query.status, transaction: { userId } },
      // Pending: soonest to expire first. History: most recent decision first.
      orderBy: query.status === 'PENDING' ? { expiresAt: 'asc' } : { requestedAt: 'desc' },
      take: query.limit,
      include: summaryInclude,
    }),
    db.approval.count({
      where: { status: 'PENDING', expiresAt: { gt: now }, transaction: { userId } },
    }),
  ]);
  return { approvals: rows.map(toApprovalDto), pendingCount };
}

/**
 * Deterministic re-check at approval and capture time. The human approves *escalation*
 * reasons only: if the current policy, task or budget would now BLOCK the
 * purchase, approval is refused. The purchase's own reservation is left out
 * of the spend it is compared against, and spend is attributed to the period
 * the purchase was reserved in (as everywhere else).
 */
export async function recheckDeterministicPolicy(
  tx: Prisma.TransactionClient,
  transaction: {
    id: string;
    userId: string;
    taskId: string;
    merchantId: string | null;
    amountMinor: number;
    currency: string;
    createdAt: Date;
  },
  now: Date,
  config: AppConfig,
): Promise<PolicyEvaluation> {
  const [policy, task, merchant] = await Promise.all([
    loadActivePolicy(tx, transaction.userId),
    tx.task.findUniqueOrThrow({ where: { id: transaction.taskId } }),
    transaction.merchantId
      ? tx.merchant.findUnique({ where: { id: transaction.merchantId } })
      : null,
  ]);
  if (!merchant)
    throw new AppError(409, 'MERCHANT_MISSING', 'The merchant for this purchase no longer exists');
  const currency = transaction.currency as Currency;
  const [committed, spend] = await Promise.all([
    committedByTask(tx, [task.id], transaction.id),
    loadSpendSnapshot(tx, {
      userId: transaction.userId,
      policy: policy?.document ?? null,
      currency,
      merchantId: merchant.id,
      amountMinor: transaction.amountMinor,
      at: transaction.createdAt,
      excludeTransactionId: transaction.id,
    }),
  ]);
  return evaluatePolicy(
    policy?.document ?? null,
    {
      amountMinor: transaction.amountMinor,
      currency,
      merchantId: merchant.id,
      merchantCategory: merchant.category as MerchantCategory,
      merchantArchived: merchant.archivedAt !== null,
      at: transaction.createdAt,
    },
    {
      // The task must still be active *now*.
      status: effectiveTaskStatus(task, now),
      currency: task.currency as Currency,
      budgetMinor: task.budgetMinor,
      committedMinor: committed.get(task.id) ?? 0,
      allowedMerchantIds: task.allowedMerchantIds,
    },
    spend,
    { sandboxMaxTransactionMinor: config.limits.sandboxMaxTransactionMinor },
  );
}

/**
 * A human approves an escalated purchase. All checks and changes happen in
 * one transaction under the user's budget lock; every state change is a
 * compare-and-swap, so a concurrent reject, cancel or expiry can't interleave.
 * Approving an already-approved purchase returns it unchanged (safe retry).
 */
export async function approvePurchase(
  { db, config }: Deps,
  actor: Actor & { stepUpAt: Date | null },
  approvalId: string,
  input: { snapshotHash: string; note?: string | undefined },
): Promise<TransactionDetailDto> {
  const transactionId = await db.$transaction(async (tx) => {
    const approval = await tx.approval.findFirst({
      where: { id: approvalId, transaction: { userId: actor.userId } },
      include: { transaction: true },
    });
    if (!approval) throw AppError.notFound('Approval not found');
    await lockUserBudget(tx, actor.userId);

    // Re-read under the lock.
    const current = await tx.approval.findUniqueOrThrow({
      where: { id: approval.id },
      include: { transaction: true },
    });
    const t = current.transaction;
    if (current.status === 'APPROVED') return t.id;
    if (current.status !== 'PENDING') {
      throw new AppError(
        409,
        'APPROVAL_NOT_PENDING',
        `This purchase was already ${current.status.toLowerCase()}`,
      );
    }
    const now = new Date();
    if (current.expiresAt.getTime() <= now.getTime()) {
      throw new AppError(
        409,
        'APPROVAL_EXPIRED',
        'The approval window has passed; the purchase will expire and its funds be released',
      );
    }
    if (t.status !== 'PENDING_APPROVAL') {
      throw new AppError(
        409,
        'APPROVAL_NOT_PENDING',
        `This purchase is ${t.status.toLowerCase().replaceAll('_', ' ')}`,
      );
    }

    // Approve what you saw: the hash on screen, and the purchase as it is now.
    if (input.snapshotHash !== current.snapshotHash) {
      throw new AppError(
        409,
        'SNAPSHOT_MISMATCH',
        'This purchase is not the one you reviewed. Reload and review it again.',
      );
    }
    const [task, merchant] = await Promise.all([
      tx.task.findUniqueOrThrow({ where: { id: t.taskId }, select: { instruction: true } }),
      t.merchantId
        ? tx.merchant.findUnique({ where: { id: t.merchantId }, select: { paypalEmail: true } })
        : null,
    ]);
    const recomputed = purchaseSnapshotHash({
      transactionId: t.id,
      amountMinor: t.amountMinor,
      currency: t.currency,
      merchantId: t.merchantId,
      payee: merchant?.paypalEmail ?? null,
      itemDescription: t.itemDescription,
      quantity: t.quantity,
      taskId: t.taskId,
      taskInstruction: task.instruction,
      decision: t.decision ?? 'ESCALATE',
      reasonCodes: t.reasonCodes,
    });
    if (recomputed !== current.snapshotHash) {
      throw new AppError(
        409,
        'SNAPSHOT_STALE',
        'Details of this purchase changed since it was escalated (for example the merchant’s PayPal account). Reject it and let the agent submit it again.',
      );
    }

    const recheck = await recheckDeterministicPolicy(tx, t, now, config);
    if (recheck.decision === 'BLOCK') {
      throw new AppError(
        409,
        'POLICY_NOW_BLOCKS',
        'Your current policy, task or budget would block this purchase, so it can no longer be approved.',
        recheck.results
          .filter((r) => r.matched && r.action === 'BLOCK')
          .map((r) => ({ reasonCode: r.reasonCode, detail: r.detail })),
      );
    }

    const approved = await tx.approval.updateMany({
      where: { id: current.id, status: 'PENDING', expiresAt: { gt: now } },
      data: {
        status: 'APPROVED',
        decidedAt: now,
        decidedByUserId: actor.userId,
        note: input.note ?? null,
      },
    });
    const authorizationExpiresAt = new Date(
      now.getTime() + config.limits.authorizationTtlMinutes * 60_000,
    );
    const authorized = await tx.transaction.updateMany({
      where: { id: t.id, status: 'PENDING_APPROVAL' },
      data: {
        status: 'AUTHORIZED',
        authorizedAt: now,
        authorizationExpiresAt,
        reasonCodes: { push: 'HUMAN_APPROVED' },
        version: { increment: 1 },
      },
    });
    if (approved.count !== 1 || authorized.count !== 1) {
      throw AppError.conflict('The purchase changed at the same time; reload and try again');
    }

    await appendAuditEvent(tx, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      transactionId: t.id,
      action: 'purchase.approved',
      data: {
        approvalId: current.id,
        snapshotHash: current.snapshotHash,
        note: input.note ?? null,
        stepUpAt: actor.stepUpAt,
        recheck: { decision: recheck.decision, reasonCodes: recheck.reasonCodes },
        authorizationExpiresAt,
        ...actor.meta,
      },
    });
    return t.id;
  });
  return getTransaction(db, actor.userId, transactionId);
}

/** A human rejects an escalated purchase; its funds are released. Safe to retry. */
export async function rejectPurchase(
  { db }: Deps,
  actor: Actor,
  approvalId: string,
  input: { note?: string | undefined },
): Promise<TransactionDetailDto> {
  const transactionId = await db.$transaction(async (tx) => {
    const approval = await tx.approval.findFirst({
      where: { id: approvalId, transaction: { userId: actor.userId } },
      select: { id: true },
    });
    if (!approval) throw AppError.notFound('Approval not found');
    await lockUserBudget(tx, actor.userId);

    const current = await tx.approval.findUniqueOrThrow({
      where: { id: approval.id },
      include: { transaction: true },
    });
    const t = current.transaction;
    if (current.status === 'REJECTED') return t.id;
    if (current.status !== 'PENDING' || t.status !== 'PENDING_APPROVAL') {
      throw new AppError(
        409,
        'APPROVAL_NOT_PENDING',
        `This purchase was already ${current.status.toLowerCase()}`,
      );
    }

    // Rejecting is always allowed while pending — even if the window just passed — since it only restricts.
    const now = new Date();
    const rejected = await tx.approval.updateMany({
      where: { id: current.id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        decidedAt: now,
        decidedByUserId: actor.userId,
        note: input.note ?? null,
      },
    });
    const updated = await tx.transaction.updateMany({
      where: { id: t.id, status: 'PENDING_APPROVAL' },
      data: {
        status: 'REJECTED',
        reasonCodes: { push: 'HUMAN_REJECTED' },
        version: { increment: 1 },
      },
    });
    if (rejected.count !== 1 || updated.count !== 1) {
      throw AppError.conflict('The purchase changed at the same time; reload and try again');
    }
    const { releasedMinor } = await releaseWithinTransaction(tx, {
      userId: actor.userId,
      transactionId: t.id,
      reason: 'rejected',
      actor: { type: 'USER', id: actor.userId },
    });
    await appendAuditEvent(tx, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      transactionId: t.id,
      action: 'purchase.rejected',
      data: { approvalId: current.id, note: input.note ?? null, releasedMinor, ...actor.meta },
    });
    return t.id;
  });
  return getTransaction(db, actor.userId, transactionId);
}
