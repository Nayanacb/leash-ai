import type { Database } from '../../db.js';
import type { TransactionStatus } from '../../generated/prisma/client.js';
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
  const reconcile = await reconcileOrphanedReservations(
    db,
    options.logger ? { logger: options.logger } : {},
  );
  return {
    expired: expiry.expired,
    reconciled: reconcile.reconciled,
    failed: [...expiry.failed, ...reconcile.failed],
  };
}
