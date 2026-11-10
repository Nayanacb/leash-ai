import {
  MoneyParseError,
  parseDecimalToMinor,
  type Currency,
  type RefundInput,
  type TransactionDetailDto,
} from '@leash/shared';
import type { Prisma, Refund, TransactionStatus } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/prismaErrors.js';
import type { Actor } from '../agents/agents.service.js';
import { getTransaction } from '../purchases/transactions.service.js';
import {
  audit,
  describeStatus,
  requireProvider,
  withLock,
  type PaymentDeps,
} from './checkout.service.js';
import {
  PaymentProviderError,
  refundRequestId,
  type PaymentProvider,
  type RefundView,
} from './provider.js';

/**
 * Refunds (docs/ARCHITECTURE.md §6.5), user-initiated or made outside Leash.
 *
 * Safety:
 * - A refund row is written (PENDING) under the budget lock before PayPal is
 *   called, and the refundable amount counts PENDING refunds, so concurrent
 *   requests can never refund more than was captured.
 * - PayPal is called with a stable request ID per refund (`leash-refund-<id>`)
 *   and invoice_id = the refund's ID, so a lost response can be found again.
 * - An unknown outcome leaves the refund PENDING. Reconciliation reads PayPal
 *   first and re-sends only with the same request ID.
 * - Completing a refund is a compare-and-swap from PENDING, and its budget
 *   credit is a ledger entry unique per refund: credited exactly once.
 */

type Who = { type: 'USER' | 'SYSTEM'; id: string | null };
const SYSTEM: Who = { type: 'SYSTEM', id: null };

const REFUNDABLE: TransactionStatus[] = ['CAPTURED', 'PARTIALLY_REFUNDED'];
/** Statuses in which money was captured (and may be refunded outside Leash or reversed). */
const CAPTURED_STATES: TransactionStatus[] = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

function viewMinor(
  view: { amountValue: string; currency: string },
  currency: string,
): number | null {
  if (view.currency !== currency) return null;
  try {
    return parseDecimalToMinor(view.amountValue, currency as Currency);
  } catch {
    return null;
  }
}

/** Captured minus completed and pending refunds. Caller holds the lock. */
async function refundableWithin(
  tx: Prisma.TransactionClient,
  t: { id: string; capturedMinor: number | null },
): Promise<number> {
  const committed = await tx.refund.aggregate({
    where: { transactionId: t.id, status: { in: ['PENDING', 'COMPLETED'] } },
    _sum: { amountMinor: true },
  });
  return Math.max(0, (t.capturedMinor ?? 0) - (committed._sum.amountMinor ?? 0));
}

/**
 * Completes a PENDING refund and credits the budget exactly once. The credit
 * is capped at what is still unrefunded. Caller holds the budget lock.
 */
async function completeRefundWithin(
  tx: Prisma.TransactionClient,
  refund: Refund,
  amountMinor: number,
  paypalRefundId: string | null,
  who: Who,
): Promise<boolean> {
  const { count } = await tx.refund.updateMany({
    where: { id: refund.id, status: 'PENDING' },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      ...(paypalRefundId ? { paypalRefundId } : {}),
    },
  });
  if (count === 0) return false;
  const t = await tx.transaction.findUniqueOrThrow({ where: { id: refund.transactionId } });
  const credit = Math.max(0, Math.min(amountMinor, (t.capturedMinor ?? 0) - t.refundedMinor));
  if (credit > 0) {
    await tx.ledgerEntry.create({
      data: {
        userId: t.userId,
        transactionId: t.id,
        type: 'REFUND',
        amountMinor: credit,
        currency: t.currency,
        refundId: refund.id,
      },
    });
  }
  const refundedMinor = t.refundedMinor + credit;
  const status: TransactionStatus =
    t.status === 'REVERSED'
      ? 'REVERSED'
      : refundedMinor >= (t.capturedMinor ?? 0)
        ? 'REFUNDED'
        : 'PARTIALLY_REFUNDED';
  await tx.transaction.update({
    where: { id: t.id },
    data: {
      refundedMinor,
      status,
      ...(t.reasonCodes.includes('PAYMENT_REFUNDED')
        ? {}
        : { reasonCodes: { push: 'PAYMENT_REFUNDED' } }),
      version: { increment: 1 },
    },
  });
  await audit(tx, t, who, 'purchase.refunded', {
    refundId: refund.id,
    paypalRefundId,
    amountMinor,
    creditedMinor: credit,
    source: refund.source,
    status,
  });
  if (amountMinor !== refund.amountMinor || credit !== amountMinor) {
    await audit(tx, t, SYSTEM, 'purchase.payment_anomaly', {
      stage: 'refund',
      refundId: refund.id,
      requestedMinor: refund.amountMinor,
      refundedMinor: amountMinor,
      creditedMinor: credit,
    });
  }
  return true;
}

async function failRefundWithin(
  tx: Prisma.TransactionClient,
  refund: Refund,
  reason: string,
  who: Who,
  paypalRefundId: string | null = null,
) {
  const { count } = await tx.refund.updateMany({
    where: { id: refund.id, status: 'PENDING' },
    data: {
      status: 'FAILED',
      failureReason: reason,
      ...(paypalRefundId ? { paypalRefundId } : {}),
    },
  });
  if (count === 0) return;
  const t = await tx.transaction.findUniqueOrThrow({
    where: { id: refund.transactionId },
    select: { id: true, userId: true },
  });
  await audit(tx, t, who, 'purchase.refund_failed', {
    refundId: refund.id,
    paypalRefundId,
    reason,
    amountMinor: refund.amountMinor,
  });
}

/** Applies PayPal's current view of a refund to the matching PENDING refund row. */
export async function settleRefund(
  deps: PaymentDeps,
  refundId: string,
  view: RefundView,
  who: Who,
): Promise<void> {
  const r = await deps.db.refund.findUniqueOrThrow({
    where: { id: refundId },
    include: { transaction: { select: { userId: true } } },
  });
  await withLock(deps.db, r.transaction.userId, async (tx) => {
    const current = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    if (current.status !== 'PENDING') return;
    switch (view.status) {
      case 'COMPLETED': {
        const minor = viewMinor(view, current.currency);
        await completeRefundWithin(tx, current, minor ?? current.amountMinor, view.id, who);
        return;
      }
      case 'PENDING':
        if (current.paypalRefundId === view.id) return;
        await tx.refund.update({ where: { id: current.id }, data: { paypalRefundId: view.id } });
        await audit(
          tx,
          { id: current.transactionId, userId: r.transaction.userId },
          who,
          'purchase.refund_pending',
          { refundId: current.id, paypalRefundId: view.id },
        );
        return;
      case 'FAILED':
      case 'CANCELLED':
        await failRefundWithin(tx, current, `PAYPAL_${view.status}`, who, view.id);
        return;
      default:
        await audit(
          tx,
          { id: current.transactionId, userId: r.transaction.userId },
          SYSTEM,
          'purchase.payment_anomaly',
          { stage: 'refund', refundId: current.id, refundStatus: view.status },
        );
    }
  });
}

/** Looks for Leash's refund among the refunds PayPal lists on the order. */
async function findRefundAtPayPal(
  provider: PaymentProvider,
  orderId: string,
  refund: Refund,
): Promise<RefundView | null> {
  const order = await provider.getOrder(orderId);
  return (
    order.purchaseUnits
      .flatMap((u) => u.refunds)
      .find(
        (v) =>
          v.invoiceId === refund.id ||
          (refund.paypalRefundId !== null && v.id === refund.paypalRefundId),
      ) ?? null
  );
}

/**
 * Sends (or re-sends, with the same request ID) a PENDING refund to PayPal and
 * records the result. Unknown outcomes leave it PENDING for reconciliation.
 */
async function sendRefund(
  deps: PaymentDeps,
  provider: PaymentProvider,
  refund: Refund,
  t: { id: string; userId: string; paypalOrderId: string | null; paypalCaptureId: string },
  who: Who,
): Promise<void> {
  let view: RefundView;
  try {
    view = await provider.refundCapture(
      t.paypalCaptureId,
      {
        amountMinor: refund.amountMinor,
        currency: refund.currency as Currency,
        invoiceId: refund.id,
        note: refund.reason,
      },
      refundRequestId(refund.id),
    );
  } catch (err) {
    if (!(err instanceof PaymentProviderError)) throw err;
    if (err.kind === 'ambiguous' || err.kind === 'auth') {
      await withLock(deps.db, t.userId, (tx) =>
        audit(tx, t, who, 'purchase.refund_uncertain', { refundId: refund.id, error: err.code }),
      );
      return;
    }
    // PayPal refused. Confirm on the order that nothing was refunded before failing it.
    let found: RefundView | null;
    try {
      found = t.paypalOrderId ? await findRefundAtPayPal(provider, t.paypalOrderId, refund) : null;
    } catch {
      return; // unknown: reconciliation will look again
    }
    if (found) return settleRefund(deps, refund.id, found, who);
    await withLock(deps.db, t.userId, (tx) => failRefundWithin(tx, refund, err.code, who));
    return;
  }
  await settleRefund(deps, refund.id, view, who);
}

// ── Dashboard: request a refund ────────────────────────────────────────────

export async function requestRefund(
  deps: PaymentDeps,
  actor: Actor,
  transactionId: string,
  input: RefundInput,
  idempotencyKey: string,
): Promise<TransactionDetailDto> {
  const { db } = deps;
  const provider = requireProvider(deps.provider);
  const key = `${actor.userId}:${idempotencyKey}`;
  const who: Who = { type: 'USER', id: actor.userId };

  const owned = await db.transaction.findFirst({
    where: { id: transactionId, userId: actor.userId },
    select: { id: true, currency: true },
  });
  if (!owned) throw AppError.notFound('Transaction not found');

  let requestedMinor: number | null = null;
  if (input.amount) {
    if (input.amount.currency !== owned.currency) {
      throw AppError.badRequest(`Refunds must be in ${owned.currency}`);
    }
    try {
      requestedMinor = parseDecimalToMinor(input.amount.value, input.amount.currency);
    } catch (err) {
      if (err instanceof MoneyParseError) throw AppError.badRequest(err.message);
      throw err;
    }
    if (requestedMinor <= 0) throw AppError.badRequest('The refund amount must be positive');
  }

  const sameRequest = (r: Refund) =>
    r.transactionId === transactionId &&
    (requestedMinor === null || r.amountMinor === requestedMinor);

  // A retried request returns the refund it created; it never refunds again.
  const existing = await db.refund.findUnique({ where: { idempotencyKey: key } });
  if (existing) {
    if (!sameRequest(existing)) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was used for a different refund',
      );
    }
    return getTransaction(db, actor.userId, transactionId);
  }

  let created: {
    refund: Refund;
    t: { id: string; userId: string; paypalOrderId: string | null; paypalCaptureId: string };
  };
  try {
    created = await withLock(db, actor.userId, async (tx) => {
      const t = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      if (!REFUNDABLE.includes(t.status) || !t.paypalCaptureId || t.capturedMinor === null) {
        throw new AppError(
          409,
          'REFUND_NOT_AVAILABLE',
          `A ${describeStatus(t.status)} purchase can't be refunded`,
        );
      }
      const refundable = await refundableWithin(tx, t);
      const amountMinor = requestedMinor ?? refundable;
      if (amountMinor <= 0) {
        throw new AppError(
          409,
          'NOTHING_TO_REFUND',
          'Everything captured has already been refunded (or is being refunded)',
        );
      }
      if (amountMinor > refundable) {
        throw new AppError(
          409,
          'REFUND_EXCEEDS_CAPTURED',
          'The refund is larger than what can still be refunded',
          {
            refundableMinor: refundable,
          },
        );
      }
      const refund = await tx.refund.create({
        data: {
          transactionId: t.id,
          idempotencyKey: key,
          amountMinor,
          currency: t.currency,
          status: 'PENDING',
          source: 'LEASH',
          reason: input.reason ?? null,
          requestedByUserId: actor.userId,
        },
      });
      await audit(tx, t, who, 'purchase.refund_requested', {
        refundId: refund.id,
        amountMinor,
        currency: t.currency,
        reason: input.reason ?? null,
        ...actor.meta,
      });
      return {
        refund,
        t: {
          id: t.id,
          userId: t.userId,
          paypalOrderId: t.paypalOrderId,
          paypalCaptureId: t.paypalCaptureId,
        },
      };
    });
  } catch (err) {
    // The same key sent twice at once: the second insert loses; return the first.
    if (isUniqueViolation(err)) {
      const winner = await db.refund.findUnique({ where: { idempotencyKey: key } });
      if (winner && sameRequest(winner)) return getTransaction(db, actor.userId, transactionId);
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was used for a different refund',
      );
    }
    throw err;
  }

  await sendRefund(deps, provider, created.refund, created.t, who);
  return getTransaction(db, actor.userId, transactionId);
}

// ── Changes made outside Leash (webhooks, reconciliation) ──────────────────

/**
 * Records a refund PayPal reports but Leash didn't start (e.g. issued from the
 * PayPal dashboard), and credits the budget once. `view` must come from
 * PayPal's API, never from a webhook payload.
 */
export async function recordExternalRefund(
  deps: PaymentDeps,
  view: RefundView,
): Promise<'recorded' | 'known' | 'unknown'> {
  if (!view.captureId) return 'unknown';
  const t = await deps.db.transaction.findFirst({ where: { paypalCaptureId: view.captureId } });
  if (!t) return 'unknown';
  const amountMinor = viewMinor(view, t.currency);
  try {
    return await withLock(deps.db, t.userId, async (tx) => {
      const known = await tx.refund.findFirst({
        where: { OR: [{ paypalRefundId: view.id }, { idempotencyKey: `paypal:${view.id}` }] },
      });
      if (known) return 'known';
      const current = await tx.transaction.findUniqueOrThrow({ where: { id: t.id } });
      if (!CAPTURED_STATES.includes(current.status) || amountMinor === null) {
        await audit(tx, current, SYSTEM, 'purchase.payment_anomaly', {
          stage: 'external_refund',
          paypalRefundId: view.id,
          status: current.status,
          currency: view.currency,
        });
        return 'known';
      }
      const refund = await tx.refund.create({
        data: {
          transactionId: t.id,
          idempotencyKey: `paypal:${view.id}`,
          paypalRefundId: view.id,
          amountMinor,
          currency: t.currency,
          status: 'PENDING',
          source: 'PAYPAL',
          reason: 'Refunded outside Leash (PayPal)',
        },
      });
      if (view.status === 'COMPLETED') {
        await completeRefundWithin(tx, refund, amountMinor, view.id, SYSTEM);
      } else if (view.status === 'FAILED' || view.status === 'CANCELLED') {
        await failRefundWithin(tx, refund, `PAYPAL_${view.status}`, SYSTEM, view.id);
      }
      return 'recorded';
    });
  } catch (err) {
    if (isUniqueViolation(err)) return 'known';
    throw err;
  }
}

/**
 * A capture was reversed (chargeback / dispute). Confirmed with PayPal first;
 * the unrefunded remainder is credited back once and the purchase becomes REVERSED.
 */
export async function recordReversal(
  deps: PaymentDeps,
  captureId: string,
): Promise<'reversed' | 'unchanged' | 'unknown'> {
  const provider = requireProvider(deps.provider);
  const t = await deps.db.transaction.findFirst({ where: { paypalCaptureId: captureId } });
  if (!t) return 'unknown';
  const capture = await provider.getCapture(captureId);
  if (capture.status !== 'REVERSED') return 'unchanged';
  try {
    return await withLock(deps.db, t.userId, async (tx) => {
      const current = await tx.transaction.findUniqueOrThrow({ where: { id: t.id } });
      if (current.status === 'REVERSED') return 'unchanged';
      if (!CAPTURED_STATES.includes(current.status)) {
        await audit(tx, current, SYSTEM, 'purchase.payment_anomaly', {
          stage: 'reversal',
          captureId,
          status: current.status,
        });
        return 'unchanged';
      }
      const remaining = Math.max(0, (current.capturedMinor ?? 0) - current.refundedMinor);
      if (remaining > 0) {
        const refund = await tx.refund.create({
          data: {
            transactionId: current.id,
            idempotencyKey: `reversal:${captureId}`,
            amountMinor: remaining,
            currency: current.currency,
            status: 'PENDING',
            source: 'PAYPAL',
            reason: 'Payment reversed by PayPal (chargeback or dispute)',
          },
        });
        await completeRefundWithin(tx, refund, remaining, null, SYSTEM);
      }
      await tx.transaction.update({
        where: { id: current.id },
        data: {
          status: 'REVERSED',
          reasonCodes: { push: 'PAYMENT_REVERSED' },
          version: { increment: 1 },
        },
      });
      await audit(tx, current, SYSTEM, 'purchase.reversed', {
        captureId,
        creditedMinor: remaining,
      });
      return 'reversed';
    });
  } catch (err) {
    if (isUniqueViolation(err)) return 'unchanged';
    throw err;
  }
}

/** Handles a refund PayPal reports (webhook hint): settles Leash's refund or records an external one. */
export async function syncRefundFromPayPal(
  deps: PaymentDeps,
  paypalRefundId: string,
): Promise<'settled' | 'recorded' | 'known' | 'unknown'> {
  const provider = requireProvider(deps.provider);
  const view = await provider.getRefund(paypalRefundId);
  const ours = await deps.db.refund.findFirst({
    where: {
      OR: [
        { paypalRefundId: view.id },
        ...(view.invoiceId && /^[0-9a-f-]{36}$/i.test(view.invoiceId)
          ? [{ id: view.invoiceId }]
          : []),
      ],
    },
  });
  if (ours) {
    await settleRefund(deps, ours.id, view, SYSTEM);
    return 'settled';
  }
  return recordExternalRefund(deps, view);
}

// ── Reconciliation ─────────────────────────────────────────────────────────

/**
 * Settles refunds left PENDING (pending at PayPal, or an unknown outcome).
 * Reads PayPal first; re-sends only with the same request ID, and only when
 * PayPal shows no such refund. After `maxAgeMs` with nothing at PayPal the
 * refund is marked FAILED (nothing was refunded) and flagged for review.
 */
export async function reconcilePendingRefunds(
  deps: PaymentDeps,
  options: { now?: Date; minAgeMs?: number; maxAgeMs?: number; batchSize?: number } = {},
): Promise<{ settled: string[]; failed: string[] }> {
  const provider = deps.provider;
  if (!provider) return { settled: [], failed: [] };
  const now = options.now ?? new Date();
  const pending = await deps.db.refund.findMany({
    where: {
      status: 'PENDING',
      updatedAt: { lt: new Date(now.getTime() - (options.minAgeMs ?? 120_000)) },
    },
    include: {
      transaction: {
        select: { id: true, userId: true, paypalOrderId: true, paypalCaptureId: true },
      },
    },
    orderBy: { updatedAt: 'asc' },
    take: options.batchSize ?? 50,
  });
  const settled: string[] = [];
  const failed: string[] = [];
  for (const r of pending) {
    try {
      const t = r.transaction;
      if (r.paypalRefundId) {
        await settleRefund(deps, r.id, await provider.getRefund(r.paypalRefundId), SYSTEM);
      } else {
        const found = t.paypalOrderId
          ? await findRefundAtPayPal(provider, t.paypalOrderId, r)
          : null;
        if (found) {
          await settleRefund(deps, r.id, found, SYSTEM);
        } else if (now.getTime() - r.createdAt.getTime() > (options.maxAgeMs ?? 24 * 3600_000)) {
          await withLock(deps.db, t.userId, async (tx) => {
            await failRefundWithin(tx, r, 'NOT_FOUND_AT_PAYPAL', SYSTEM);
            await audit(tx, t, SYSTEM, 'purchase.payment_anomaly', {
              stage: 'refund_reconciliation',
              refundId: r.id,
              detail: 'no refund at PayPal after the retry window',
            });
          });
        } else if (t.paypalCaptureId) {
          await sendRefund(deps, provider, r, { ...t, paypalCaptureId: t.paypalCaptureId }, SYSTEM);
        }
      }
      const after = await deps.db.refund.findUniqueOrThrow({ where: { id: r.id } });
      if (after.status !== 'PENDING') settled.push(r.id);
    } catch (err) {
      failed.push(r.id);
      deps.logger?.error({ err, refundId: r.id }, 'refund reconciliation failed');
    }
  }
  return { settled, failed };
}
