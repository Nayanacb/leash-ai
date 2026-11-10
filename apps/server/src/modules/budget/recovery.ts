import type { Database } from '../../db.js';
import type { Prisma, TransactionStatus } from '../../generated/prisma/client.js';
import type { Logger } from '../../lib/logger.js';
import { appendAuditEvent } from '../audit/auditLog.js';
import { lockUserBudget, releaseWithinTransaction } from './ledger.js';

/**
 * Recovery for the budget ledger.
 *
 * A purchase sits in EVALUATING, with its funds reserved, only while the AI
 * layers run (seconds). If the process crashes or a step hangs, the
 * reservation would otherwise be held forever and silently eat into the
 * user's budget. These routines put such purchases into a safe terminal state
 * (EXPIRED — never anything that could lead to payment) and release the funds.
 *
 * Safety under concurrency:
 * - every change happens in one DB transaction holding the user's budget lock;
 * - the status change is a compare-and-swap from EVALUATING, so if the
 *   evaluation finishes at the same moment, exactly one of them wins and the
 *   other becomes a no-op;
 * - release is idempotent, so overlapping sweepers (or instances) can't
 *   release twice.
 */

/** Statuses in which a purchase can never be paid, so no funds should remain reserved. */
export const UNFUNDED_TERMINAL_STATUSES: TransactionStatus[] = [
  'BLOCKED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'PAYMENT_FAILED',
];

export interface SweepResult {
  expired: string[];
  approvalsExpired: string[];
  authorizationsExpired: string[];
  reconciled: string[];
  failed: string[];
}

/**
 * Expires purchases that have been EVALUATING for longer than `timeoutMs`
 * and releases their reservations.
 */
export async function expireStuckEvaluations(
  db: Database,
  options: { timeoutMs: number; now?: Date; batchSize?: number; logger?: Logger },
): Promise<Pick<SweepResult, 'expired' | 'failed'>> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.timeoutMs);
  const candidates = await db.transaction.findMany({
    where: { status: 'EVALUATING', createdAt: { lt: cutoff } },
    select: { id: true, userId: true },
    orderBy: { createdAt: 'asc' },
    take: options.batchSize ?? 100,
  });

  const expired: string[] = [];
  const failed: string[] = [];
  for (const candidate of candidates) {
    try {
      const didExpire = await db.$transaction(async (tx) => {
        await lockUserBudget(tx, candidate.userId);
        // Compare-and-swap: only if it is *still* evaluating and still overdue.
        const { count } = await tx.transaction.updateMany({
          where: { id: candidate.id, status: 'EVALUATING', createdAt: { lt: cutoff } },
          data: {
            status: 'EXPIRED',
            reasonCodes: { push: 'EVALUATION_TIMEOUT' },
            version: { increment: 1 },
          },
        });
        if (count === 0) return false;

        const { releasedMinor } = await releaseWithinTransaction(tx, {
          userId: candidate.userId,
          transactionId: candidate.id,
          reason: 'evaluation_timeout',
          actor: { type: 'SYSTEM', id: null },
        });
        await appendAuditEvent(tx, {
          actorType: 'SYSTEM',
          actorId: null,
          userId: candidate.userId,
          transactionId: candidate.id,
          action: 'purchase.evaluation_expired',
          data: { timeoutSeconds: Math.round(options.timeoutMs / 1000), releasedMinor },
        });
        return true;
      });
      if (didExpire) expired.push(candidate.id);
    } catch (err) {
      failed.push(candidate.id);
      options.logger?.error(
        { err, transactionId: candidate.id },
        'failed to expire stuck evaluation',
      );
    }
  }
  return { expired, failed };
}

/**
 * Expires purchases whose human approval window has passed (PENDING_APPROVAL
 * → EXPIRED, approval PENDING → EXPIRED) and releases their funds — exactly
 * once, even if a user cancels or approves at the same moment.
 */
export async function expireOverdueApprovals(
  db: Database,
  options: { now?: Date; batchSize?: number; logger?: Logger } = {},
): Promise<{ expired: string[]; failed: string[] }> {
  const now = options.now ?? new Date();
  const candidates = await db.approval.findMany({
    where: { status: 'PENDING', expiresAt: { lte: now } },
    select: { transactionId: true, transaction: { select: { userId: true } } },
    orderBy: { expiresAt: 'asc' },
    take: options.batchSize ?? 100,
  });
  const expired: string[] = [];
  const failed: string[] = [];
  for (const c of candidates) {
    const userId = c.transaction.userId;
    try {
      const done = await db.$transaction(async (tx) => {
        await lockUserBudget(tx, userId);
        const approval = await tx.approval.updateMany({
          where: { transactionId: c.transactionId, status: 'PENDING', expiresAt: { lte: now } },
          data: { status: 'EXPIRED', decidedAt: now },
        });
        if (approval.count === 0) return false;
        await tx.transaction.updateMany({
          where: { id: c.transactionId, status: 'PENDING_APPROVAL' },
          data: {
            status: 'EXPIRED',
            reasonCodes: { push: 'APPROVAL_EXPIRED' },
            version: { increment: 1 },
          },
        });
        const { releasedMinor } = await releaseWithinTransaction(tx, {
          userId,
          transactionId: c.transactionId,
          reason: 'approval_expired',
          actor: { type: 'SYSTEM', id: null },
        });
        await appendAuditEvent(tx, {
          actorType: 'SYSTEM',
          actorId: null,
          userId,
          transactionId: c.transactionId,
          action: 'purchase.approval_expired',
          data: { releasedMinor },
        });
        return true;
      });
      if (done) expired.push(c.transactionId);
    } catch (err) {
      failed.push(c.transactionId);
      options.logger?.error({ err, transactionId: c.transactionId }, 'failed to expire approval');
    }
  }
  return { expired, failed };
}

/** Authorized by Leash but not paid yet: the authorization deadline applies to the whole checkout. */
export const AWAITING_PAYMENT_STATUSES: TransactionStatus[] = [
  'AUTHORIZED',
  'ORDER_CREATED',
  'BUYER_APPROVED',
];

/**
 * Expires one purchase whose authorization deadline has passed and releases
 * its funds. The caller holds the user's budget lock. Compare-and-swap: a
 * no-op (false) unless the purchase is still in one of `fromStatuses` and
 * overdue. Never pass a status in which money may already have moved, unless
 * the provider has confirmed that it did not.
 */
export async function expireAuthorizationWithin(
  tx: Prisma.TransactionClient,
  purchase: { id: string; userId: string },
  now: Date,
  fromStatuses: TransactionStatus[] = AWAITING_PAYMENT_STATUSES,
): Promise<boolean> {
  const current = await tx.transaction.findUniqueOrThrow({
    where: { id: purchase.id },
    select: { status: true },
  });
  const { count } = await tx.transaction.updateMany({
    where: {
      id: purchase.id,
      status: { in: fromStatuses },
      authorizationExpiresAt: { lte: now },
    },
    data: {
      status: 'EXPIRED',
      reasonCodes: { push: 'AUTHORIZATION_EXPIRED' },
      version: { increment: 1 },
    },
  });
  if (count === 0) return false;
  const { releasedMinor } = await releaseWithinTransaction(tx, {
    userId: purchase.userId,
    transactionId: purchase.id,
    reason: 'authorization_expired',
    actor: { type: 'SYSTEM', id: null },
  });
  await appendAuditEvent(tx, {
    actorType: 'SYSTEM',
    actorId: null,
    userId: purchase.userId,
    transactionId: purchase.id,
    action: 'purchase.authorization_expired',
    data: { releasedMinor, fromStatus: current.status },
  });
  return true;
}

/**
 * Expires authorized purchases that were not paid within the authorization
 * window (including those whose PayPal checkout was started but never
 * captured), and releases their funds. Purchases in CAPTURING are left to
 * payment reconciliation: money may already have moved.
 */
export async function expireOverdueAuthorizations(
  db: Database,
  options: { now?: Date; batchSize?: number; logger?: Logger } = {},
): Promise<{ expired: string[]; failed: string[] }> {
  const now = options.now ?? new Date();
  const candidates = await db.transaction.findMany({
    where: { status: { in: AWAITING_PAYMENT_STATUSES }, authorizationExpiresAt: { lte: now } },
    select: { id: true, userId: true },
    orderBy: { authorizationExpiresAt: 'asc' },
    take: options.batchSize ?? 100,
  });
  const expired: string[] = [];
  const failed: string[] = [];
  for (const c of candidates) {
    try {
      const done = await db.$transaction(async (tx) => {
        await lockUserBudget(tx, c.userId);
        return expireAuthorizationWithin(tx, c, now);
      });
      if (done) expired.push(c.id);
    } catch (err) {
      failed.push(c.id);
      options.logger?.error({ err, transactionId: c.id }, 'failed to expire authorization');
    }
  }
  return { expired, failed };
}

/**
 * Safety net: releases reservations still held by purchases that are already
 * in a terminal, never-paid state (which correct code never leaves behind).
 */
export async function reconcileOrphanedReservations(
  db: Database,
  options: { batchSize?: number; logger?: Logger } = {},
): Promise<Pick<SweepResult, 'reconciled' | 'failed'>> {
  const candidates = await db.transaction.findMany({
    where: {
      status: { in: UNFUNDED_TERMINAL_STATUSES },
      AND: [
        { ledgerEntries: { some: { type: 'RESERVE' } } },
        { ledgerEntries: { none: { type: 'RELEASE' } } },
      ],
    },
    select: { id: true, userId: true },
    take: options.batchSize ?? 100,
  });

  const reconciled: string[] = [];
  const failed: string[] = [];
  for (const candidate of candidates) {
    try {
      const released = await db.$transaction(async (tx) => {
        await lockUserBudget(tx, candidate.userId);
        const current = await tx.transaction.findUniqueOrThrow({
          where: { id: candidate.id },
          select: { status: true },
        });
        if (!UNFUNDED_TERMINAL_STATUSES.includes(current.status)) return 0;
        const { releasedMinor } = await releaseWithinTransaction(tx, {
          userId: candidate.userId,
          transactionId: candidate.id,
          reason: `reconciliation: ${current.status.toLowerCase()} purchase still held funds`,
          actor: { type: 'SYSTEM', id: null },
        });
        return releasedMinor;
      });
      if (released > 0) {
        reconciled.push(candidate.id);
        options.logger?.warn(
          { transactionId: candidate.id, released },
          'released orphaned reservation',
        );
      }
    } catch (err) {
      failed.push(candidate.id);
      options.logger?.error(
        { err, transactionId: candidate.id },
        'failed to reconcile reservation',
      );
    }
  }
  return { reconciled, failed };
}

export async function sweepReservations(
  db: Database,
  options: { evaluationTimeoutMs: number; now?: Date; logger?: Logger },
): Promise<SweepResult> {
  const expiry = await expireStuckEvaluations(db, {
    timeoutMs: options.evaluationTimeoutMs,
    ...(options.now ? { now: options.now } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const shared = {
    ...(options.now ? { now: options.now } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  };
  const approvals = await expireOverdueApprovals(db, shared);
  const authorizations = await expireOverdueAuthorizations(db, shared);
  const reconcile = await reconcileOrphanedReservations(
    db,
    options.logger ? { logger: options.logger } : {},
  );
  return {
    expired: expiry.expired,
    approvalsExpired: approvals.expired,
    authorizationsExpired: authorizations.expired,
    reconciled: reconcile.reconciled,
    failed: [...expiry.failed, ...approvals.failed, ...authorizations.failed, ...reconcile.failed],
  };
}
