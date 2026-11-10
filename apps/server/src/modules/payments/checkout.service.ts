import type { CheckoutStartResponse, Currency, TransactionDetailDto } from '@leash/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db.js';
import type { Prisma, Transaction, TransactionStatus } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { Actor } from '../agents/agents.service.js';
import { recheckDeterministicPolicy } from '../approvals/approvals.service.js';
import { appendAuditEvent } from '../audit/auditLog.js';
import { lockUserBudget, releaseWithinTransaction } from '../budget/ledger.js';
import { expireAuthorizationWithin } from '../budget/recovery.js';
import { getTransaction } from '../purchases/transactions.service.js';
import {
  captureRequestId,
  orderRequestId,
  PaymentProviderError,
  type OrderView,
  type PaymentProvider,
} from './provider.js';
import { captureOutcome, orderMismatches, type AuthorizedPayment } from './verify.js';

/**
 * PayPal Checkout for authorized purchases (docs/ARCHITECTURE.md §6.3).
 *
 * Two independent checkpoints must both pass before money moves: Leash
 * authorized the purchase (ALLOW, or ESCALATE + human approval), and the PayPal
 * order — fetched server-side, never taken from a redirect — was approved by
 * the buyer and matches the authorized values exactly.
 *
 * Concurrency: provider calls happen outside the budget lock (like AI calls);
 * every state change is a compare-and-swap under the lock, and provider calls
 * use stable idempotency keys. Exactly one request moves a purchase into
 * CAPTURING, and only that request calls capture. An ambiguous capture
 * (network error, timeout, 5xx) leaves the purchase in CAPTURING for
 * reconciliation, which reads PayPal's state before anything else.
 */

export interface PaymentDeps {
  db: Database;
  config: AppConfig;
  provider: PaymentProvider | null;
  logger?: Logger;
}

const CHECKOUT_STARTED: TransactionStatus[] = ['ORDER_CREATED', 'BUYER_APPROVED'];

function requireProvider(provider: PaymentProvider | null): PaymentProvider {
  if (!provider) {
    throw new AppError(
      503,
      'PAYMENTS_NOT_CONFIGURED',
      'PayPal sandbox is not configured on the server (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)',
    );
  }
  return provider;
}

function providerFailure(err: unknown): never {
  if (err instanceof PaymentProviderError) {
    if (err.kind === 'auth') {
      throw new AppError(502, 'PAYMENT_PROVIDER_AUTH', 'PayPal refused the server credentials');
    }
    throw new AppError(
      502,
      'PAYMENT_PROVIDER_ERROR',
      `PayPal could not complete the request (${err.code}). Try again.`,
    );
  }
  throw err;
}

function authorizedPayment(t: Transaction): AuthorizedPayment {
  if (!t.paypalOrderId || !t.payeeEmail) {
    throw new AppError(409, 'PAYMENT_STATE_INVALID', 'This purchase has no PayPal order');
  }
  return {
    orderId: t.paypalOrderId,
    transactionId: t.id,
    amountMinor: t.amountMinor,
    currency: t.currency as Currency,
    payeeEmail: t.payeeEmail,
  };
}

const isExpired = (t: Pick<Transaction, 'authorizationExpiresAt'>, now: Date) =>
  !t.authorizationExpiresAt || t.authorizationExpiresAt.getTime() <= now.getTime();

const describeStatus = (s: TransactionStatus) => s.toLowerCase().replaceAll('_', ' ');

async function loadOwned(db: Database, userId: string, id: string) {
  const t = await db.transaction.findFirst({
    where: { id, userId },
    include: { merchant: { select: { paypalEmail: true } } },
  });
  if (!t) throw AppError.notFound('Transaction not found');
  return t;
}

async function audit(
  tx: Prisma.TransactionClient,
  t: { id: string; userId: string },
  actor: { type: 'USER' | 'SYSTEM'; id: string | null },
  action: string,
  data: Record<string, unknown>,
) {
  await appendAuditEvent(tx, {
    actorType: actor.type,
    actorId: actor.id,
    userId: t.userId,
    transactionId: t.id,
    action,
    data,
  });
}

/**
 * Marks the payment failed and releases the funds (exactly once: release is
 * idempotent and the status change is a CAS). Caller holds the budget lock.
 */
async function failPaymentWithin(
  tx: Prisma.TransactionClient,
  t: { id: string; userId: string },
  from: TransactionStatus[],
  reason: string,
  actor: { type: 'USER' | 'SYSTEM'; id: string | null },
  data: Record<string, unknown> = {},
): Promise<boolean> {
  const { count } = await tx.transaction.updateMany({
    where: { id: t.id, status: { in: from } },
    data: {
      status: 'PAYMENT_FAILED',
      paymentFailureReason: reason,
      reasonCodes: { push: reason },
      version: { increment: 1 },
    },
  });
  if (count === 0) return false;
  const { releasedMinor } = await releaseWithinTransaction(tx, {
    userId: t.userId,
    transactionId: t.id,
    reason: 'payment_failed',
    actor,
  });
  await audit(tx, t, actor, 'purchase.payment_failed', { reason, releasedMinor, ...data });
  return true;
}

async function withLock<T>(
  db: Database,
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await lockUserBudget(tx, userId);
    return fn(tx);
  });
}

/** Expires an overdue purchase right away (instead of waiting for the sweep). */
async function expireNow(
  db: Database,
  t: { id: string; userId: string },
  now: Date,
): Promise<never> {
  await withLock(db, t.userId, (tx) => expireAuthorizationWithin(tx, t, now));
  throw new AppError(
    409,
    'AUTHORIZATION_EXPIRED',
    'The authorization deadline passed before payment; the purchase expired and its funds were released',
  );
}

// ── Start checkout ─────────────────────────────────────────────────────────

/**
 * Creates (or re-uses) the PayPal order for an authorized purchase and returns
 * the buyer-approval link — to the signed-in user only, never to the agent.
 */
export async function startCheckout(
  deps: PaymentDeps,
  actor: Actor,
  transactionId: string,
): Promise<CheckoutStartResponse> {
  const { db, config } = deps;
  const t = await loadOwned(db, actor.userId, transactionId);
  const provider = requireProvider(deps.provider);
  const now = new Date();

  if (CHECKOUT_STARTED.includes(t.status) && t.paypalOrderId) {
    if (isExpired(t, now)) return expireNow(db, t, now);
    // Resume: the same order, fetched fresh from PayPal.
    const order = await provider.getOrder(t.paypalOrderId).catch(providerFailure);
    if (order.status === 'APPROVED') return { status: 'APPROVED' };
    if (
      (order.status === 'CREATED' || order.status === 'PAYER_ACTION_REQUIRED') &&
      order.approveUrl
    ) {
      return { status: 'REDIRECT', approveUrl: order.approveUrl };
    }
    throw new AppError(
      409,
      'ORDER_NOT_PAYABLE',
      `The PayPal order is ${order.status.toLowerCase()}; it can't be paid`,
    );
  }
  if (t.status !== 'AUTHORIZED') {
    throw new AppError(
      409,
      'PAYMENT_NOT_AVAILABLE',
      `A ${describeStatus(t.status)} purchase can't be paid`,
    );
  }
  if (isExpired(t, now)) return expireNow(db, t, now);
  if (!t.payeeEmail || !t.merchantId) {
    throw new AppError(409, 'PAYEE_MISSING', 'This purchase has no registered payee');
  }
  if (t.merchant?.paypalEmail.toLowerCase() !== t.payeeEmail.toLowerCase()) {
    throw new AppError(
      409,
      'PAYEE_CHANGED',
      'The merchant’s PayPal account changed after this purchase was authorized. Cancel it and let the agent submit it again.',
    );
  }

  const base = config.webOrigin.replace(/\/$/, '');
  const order = await provider
    .createOrder(
      {
        transactionId: t.id,
        amountMinor: t.amountMinor,
        currency: t.currency as Currency,
        payeeEmail: t.payeeEmail,
        description: t.itemDescription,
        returnUrl: `${base}/transactions/${t.id}/paypal-return`,
        cancelUrl: `${base}/transactions/${t.id}?paypal=cancelled`,
      },
      orderRequestId(t.id),
    )
    .catch(providerFailure);

  const mismatches = orderMismatches(order, { ...authorizedPaymentFor(t), orderId: order.id });
  if (mismatches.length || !order.approveUrl) {
    await withLock(db, t.userId, (tx) =>
      audit(tx, t, { type: 'SYSTEM', id: null }, 'purchase.payment_anomaly', {
        stage: 'order_created',
        orderId: order.id,
        mismatches,
        approveUrl: order.approveUrl ? 'present' : 'missing or outside the sandbox',
      }),
    );
    throw new AppError(
      502,
      'ORDER_MISMATCH',
      'PayPal created an order that does not match this purchase; it will not be used',
    );
  }

  await withLock(db, t.userId, async (tx) => {
    const updated = await tx.transaction.updateMany({
      where: { id: t.id, status: 'AUTHORIZED', authorizationExpiresAt: { gt: new Date() } },
      data: {
        status: 'ORDER_CREATED',
        paypalOrderId: order.id,
        orderCreatedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (updated.count === 1) {
      await audit(tx, t, { type: 'USER', id: actor.userId }, 'purchase.order_created', {
        orderId: order.id,
        amountMinor: t.amountMinor,
        currency: t.currency,
        payee: t.payeeEmail,
        ...actor.meta,
      });
      return;
    }
    // A concurrent request may have created the same (idempotent) order.
    const current = await tx.transaction.findUniqueOrThrow({ where: { id: t.id } });
    if (CHECKOUT_STARTED.includes(current.status) && current.paypalOrderId === order.id) return;
    throw AppError.conflict(`The purchase is now ${describeStatus(current.status)}`);
  });
  return { status: 'REDIRECT', approveUrl: order.approveUrl };
}

function authorizedPaymentFor(t: Transaction): Omit<AuthorizedPayment, 'orderId'> {
  return {
    transactionId: t.id,
    amountMinor: t.amountMinor,
    currency: t.currency as Currency,
    payeeEmail: t.payeeEmail ?? '',
  };
}

// ── Settle from the provider's state ───────────────────────────────────────

type Settlement = 'captured' | 'pending' | 'failed' | 'none' | 'unchanged';

/**
 * Applies what the order says about money movement to a purchase in
 * CAPTURING. Returns 'none' when PayPal shows no capture at all.
 */
async function settleFromOrder(
  deps: PaymentDeps,
  t: Transaction,
  order: OrderView,
  actor: { type: 'USER' | 'SYSTEM'; id: string | null },
): Promise<Settlement> {
  const expected = authorizedPayment(t);
  const outcome = captureOutcome(order, expected);
  if (outcome.kind === 'none') return 'none';

  return withLock(deps.db, t.userId, async (tx): Promise<Settlement> => {
    const current = await tx.transaction.findUniqueOrThrow({ where: { id: t.id } });
    if (current.status !== 'CAPTURING') return 'unchanged';

    switch (outcome.kind) {
      case 'completed': {
        await tx.transaction.update({
          where: { id: t.id },
          data: {
            status: 'CAPTURED',
            paypalCaptureId: outcome.captureId,
            capturedMinor: outcome.amountMinor,
            capturedAt: new Date(),
            reasonCodes: { push: 'PAYMENT_CAPTURED' },
            version: { increment: 1 },
          },
        });
        await audit(tx, t, actor, 'purchase.captured', {
          orderId: expected.orderId,
          captureId: outcome.captureId,
          capturedMinor: outcome.amountMinor,
          currency: expected.currency,
        });
        if (!outcome.exact) {
          // Money moved, so the purchase is captured — but flag it loudly.
          await audit(tx, t, { type: 'SYSTEM', id: null }, 'purchase.payment_anomaly', {
            stage: 'capture',
            orderId: expected.orderId,
            captureId: outcome.captureId,
            expectedMinor: expected.amountMinor,
            capturedMinor: outcome.amountMinor,
          });
          deps.logger?.error({ transactionId: t.id }, 'captured amount differs from authorized');
        }
        return 'captured';
      }
      case 'pending': {
        if (current.paypalCaptureId === outcome.captureId) return 'pending';
        await tx.transaction.update({
          where: { id: t.id },
          data: { paypalCaptureId: outcome.captureId, version: { increment: 1 } },
        });
        await audit(tx, t, actor, 'purchase.capture_pending', {
          orderId: expected.orderId,
          captureId: outcome.captureId,
        });
        return 'pending';
      }
      case 'declined': {
        await tx.transaction.updateMany({
          where: { id: t.id, status: 'CAPTURING' },
          data: { paypalCaptureId: outcome.captureId },
        });
        await failPaymentWithin(tx, t, ['CAPTURING'], 'PAYMENT_DECLINED', actor, {
          orderId: expected.orderId,
          captureId: outcome.captureId,
          captureStatus: outcome.status,
        });
        return 'failed';
      }
      case 'anomaly': {
        // Ambiguous: never release funds when money may have moved.
        await audit(tx, t, { type: 'SYSTEM', id: null }, 'purchase.payment_anomaly', {
          stage: 'capture',
          orderId: expected.orderId,
          detail: outcome.detail,
        });
        return 'unchanged';
      }
    }
  });
}

/**
 * Calls capture (stable request ID) and records the result. Any error that
 * leaves the outcome unknown keeps the purchase in CAPTURING.
 */
async function captureAndSettle(
  deps: PaymentDeps,
  provider: PaymentProvider,
  t: Transaction,
  actor: { type: 'USER' | 'SYSTEM'; id: string | null },
): Promise<void> {
  const orderId = t.paypalOrderId!;
  let order: OrderView;
  try {
    order = await provider.captureOrder(orderId, captureRequestId(t.id));
  } catch (err) {
    if (!(err instanceof PaymentProviderError)) throw err;
    if (err.kind !== 'rejected' && err.kind !== 'not_found') {
      await withLock(deps.db, t.userId, (tx) =>
        audit(tx, t, actor, 'purchase.capture_uncertain', { orderId, error: err.code }),
      );
      return; // reconciliation reads PayPal's state later
    }
    // PayPal refused the capture. Check what the order says before failing it
    // (e.g. ORDER_ALREADY_CAPTURED means an earlier attempt did go through).
    let latest: OrderView;
    try {
      latest = await provider.getOrder(orderId);
    } catch {
      return; // unknown: leave it to reconciliation
    }
    if ((await settleFromOrder(deps, t, latest, actor)) !== 'none') return;
    await withLock(deps.db, t.userId, (tx) =>
      failPaymentWithin(tx, t, ['CAPTURING'], 'PAYMENT_DECLINED', actor, {
        orderId,
        error: err.code,
      }),
    );
    return;
  }
  const settled = await settleFromOrder(deps, t, order, actor);
  if (settled === 'none') {
    // A capture response without a capture: unknown, reconcile later.
    await withLock(deps.db, t.userId, (tx) =>
      audit(tx, t, actor, 'purchase.capture_uncertain', {
        orderId,
        error: 'NO_CAPTURE_IN_RESPONSE',
      }),
    );
  }
}

// ── Complete checkout (after the buyer returns from PayPal) ───────────────

type Gate =
  { next: 'capture'; t: Transaction } | { next: 'done' } | { next: 'error'; error: AppError };

/**
 * Called by the dashboard's PayPal return page. Ignores everything PayPal put
 * in the redirect: the order is identified by what Leash stored and verified
 * by fetching it server-side. Safe to call repeatedly or concurrently.
 */
export async function completeCheckout(
  deps: PaymentDeps,
  actor: Actor,
  transactionId: string,
): Promise<TransactionDetailDto> {
  const { db, config } = deps;
  const t = await loadOwned(db, actor.userId, transactionId);
  const provider = requireProvider(deps.provider);
  const userActor = { type: 'USER' as const, id: actor.userId };

  if (t.status === 'CAPTURED') return getTransaction(db, actor.userId, t.id);
  if (t.status === 'CAPTURING') {
    // Another request is capturing (or the outcome was unknown). Read, never re-capture here.
    const order = await provider.getOrder(t.paypalOrderId!).catch(() => null);
    if (order) await settleFromOrder(deps, t, order, userActor);
    return getTransaction(db, actor.userId, t.id);
  }
  if (!CHECKOUT_STARTED.includes(t.status) || !t.paypalOrderId) {
    throw new AppError(
      409,
      'PAYMENT_NOT_AVAILABLE',
      `This purchase is ${describeStatus(t.status)}; there is no checkout to complete`,
    );
  }
  if (isExpired(t, new Date())) return expireNow(db, t, new Date());

  const expected = authorizedPayment(t);
  const order = await provider.getOrder(expected.orderId).catch(providerFailure);
  if (order.status === 'CREATED' || order.status === 'PAYER_ACTION_REQUIRED') {
    throw new AppError(
      409,
      'ORDER_NOT_APPROVED',
      'PayPal has not confirmed the buyer’s approval for this order yet',
    );
  }

  const gate = await withLock(db, t.userId, async (tx): Promise<Gate> => {
    const current = await tx.transaction.findUniqueOrThrow({ where: { id: t.id } });
    if (!CHECKOUT_STARTED.includes(current.status)) return { next: 'done' };
    const now = new Date();
    if (isExpired(current, now)) {
      await expireAuthorizationWithin(tx, current, now);
      return {
        next: 'error',
        error: new AppError(409, 'AUTHORIZATION_EXPIRED', 'The authorization deadline passed'),
      };
    }

    if (order.status === 'VOIDED') {
      await failPaymentWithin(tx, current, CHECKOUT_STARTED, 'ORDER_VOIDED', userActor, {
        orderId: expected.orderId,
      });
      return {
        next: 'error',
        error: new AppError(409, 'ORDER_VOIDED', 'PayPal voided this order; nothing was paid'),
      };
    }
    if (order.status !== 'APPROVED') {
      // e.g. COMPLETED although Leash never captured: don't touch the funds.
      await audit(tx, current, { type: 'SYSTEM', id: null }, 'purchase.payment_anomaly', {
        stage: 'complete',
        orderId: expected.orderId,
        orderStatus: order.status,
      });
      return {
        next: 'error',
        error: new AppError(
          409,
          'ORDER_STATE_UNEXPECTED',
          `The PayPal order is ${order.status.toLowerCase()}; nothing was captured`,
        ),
      };
    }

    // Checkpoint 2: the order PayPal reports must be exactly what Leash authorized.
    const mismatches = orderMismatches(order, expected);
    if (mismatches.length) {
      await audit(tx, current, { type: 'SYSTEM', id: null }, 'purchase.payment_anomaly', {
        stage: 'verify',
        orderId: expected.orderId,
        mismatches,
      });
      await failPaymentWithin(tx, current, CHECKOUT_STARTED, 'ORDER_MISMATCH', userActor, {
        orderId: expected.orderId,
        mismatches,
      });
      return {
        next: 'error',
        error: new AppError(
          409,
          'ORDER_MISMATCH',
          'The PayPal order does not match the authorized purchase; nothing was captured and the funds were released',
        ),
      };
    }

    // The payee must still be the registered merchant account.
    const merchant = current.merchantId
      ? await tx.merchant.findUnique({
          where: { id: current.merchantId },
          select: { paypalEmail: true },
        })
      : null;
    if (merchant?.paypalEmail.toLowerCase() !== expected.payeeEmail.toLowerCase()) {
      await failPaymentWithin(tx, current, CHECKOUT_STARTED, 'PAYEE_CHANGED', userActor, {
        orderId: expected.orderId,
      });
      return {
        next: 'error',
        error: new AppError(
          409,
          'PAYEE_CHANGED',
          'The merchant’s PayPal account changed after authorization; nothing was captured and the funds were released',
        ),
      };
    }

    // Checkpoint 1, again: the current policy, task and budget must still allow it.
    const recheck = await recheckDeterministicPolicy(tx, current, now, config);
    if (recheck.decision === 'BLOCK') {
      const blocking = recheck.results
        .filter((r) => r.matched && r.action === 'BLOCK')
        .map((r) => ({ reasonCode: r.reasonCode, detail: r.detail }));
      await failPaymentWithin(
        tx,
        current,
        CHECKOUT_STARTED,
        'POLICY_BLOCKED_AT_CAPTURE',
        userActor,
        { orderId: expected.orderId, blocking },
      );
      return {
        next: 'error',
        error: new AppError(
          409,
          'POLICY_NOW_BLOCKS',
          'Your current policy, task or budget blocks this purchase; nothing was captured and the funds were released',
          blocking,
        ),
      };
    }

    const moved = await tx.transaction.updateMany({
      where: { id: current.id, status: { in: CHECKOUT_STARTED } },
      data: { status: 'CAPTURING', version: { increment: 1 } },
    });
    if (moved.count !== 1) return { next: 'done' };
    await audit(tx, current, userActor, 'purchase.capture_started', {
      orderId: expected.orderId,
      buyerApprovalVerified: true,
      recheck: { decision: recheck.decision, reasonCodes: recheck.reasonCodes },
      ...actor.meta,
    });
    return { next: 'capture', t: { ...current, status: 'CAPTURING' } };
  });

  if (gate.next === 'error') throw gate.error;
  if (gate.next === 'capture') await captureAndSettle(deps, provider, gate.t, userActor);
  return getTransaction(db, actor.userId, t.id);
}

// ── Reconciliation sweep ───────────────────────────────────────────────────

/**
 * Settles purchases left in CAPTURING (pending capture, or a capture whose
 * outcome was unknown). Always reads the order first:
 * - a capture exists → record it (completed / pending / declined);
 * - no capture, order still APPROVED, authorization valid → capture again
 *   with the SAME request ID (PayPal returns the original result if the first
 *   attempt went through, so this never captures twice);
 * - no capture, authorization expired → expire and release (never capture);
 * - order voided / gone → payment failed, release.
 * Purchases are only touched once they've been CAPTURING for `minAgeMs`, so
 * an in-flight capture request is never raced.
 */
export async function reconcileCapturingPayments(
  deps: PaymentDeps,
  options: { now?: Date; minAgeMs?: number; batchSize?: number } = {},
): Promise<{ settled: string[]; failed: string[] }> {
  const provider = deps.provider;
  if (!provider) return { settled: [], failed: [] };
  const now = options.now ?? new Date();
  const candidates = await deps.db.transaction.findMany({
    where: {
      status: 'CAPTURING',
      updatedAt: { lt: new Date(now.getTime() - (options.minAgeMs ?? 120_000)) },
    },
    orderBy: { updatedAt: 'asc' },
    take: options.batchSize ?? 50,
  });
  const system = { type: 'SYSTEM' as const, id: null };
  const settled: string[] = [];
  const failed: string[] = [];
  for (const t of candidates) {
    try {
      let order: OrderView;
      try {
        order = await provider.getOrder(t.paypalOrderId!);
      } catch (err) {
        if (err instanceof PaymentProviderError && err.kind === 'not_found') {
          const done = await withLock(deps.db, t.userId, (tx) =>
            failPaymentWithin(tx, t, ['CAPTURING'], 'ORDER_VOIDED', system, {
              orderId: t.paypalOrderId,
            }),
          );
          if (done) settled.push(t.id);
          continue;
        }
        throw err;
      }
      const result = await settleFromOrder(deps, t, order, system);
      if (result !== 'none') {
        if (result !== 'unchanged') settled.push(t.id);
        continue;
      }
      if (order.status === 'APPROVED' && !isExpired(t, now)) {
        await captureAndSettle(deps, provider, t, system);
        settled.push(t.id);
        continue;
      }
      // No money moved and it can't be captured any more.
      const done = await withLock(deps.db, t.userId, (tx) =>
        order.status === 'APPROVED'
          ? expireAuthorizationWithin(tx, t, now, ['CAPTURING'])
          : failPaymentWithin(
              tx,
              t,
              ['CAPTURING'],
              order.status === 'VOIDED' ? 'ORDER_VOIDED' : 'PAYMENT_DECLINED',
              system,
              { orderId: t.paypalOrderId, orderStatus: order.status },
            ),
      );
      if (done) settled.push(t.id);
    } catch (err) {
      failed.push(t.id);
      deps.logger?.error({ err, transactionId: t.id }, 'payment reconciliation failed');
    }
  }
  return { settled, failed };
}
