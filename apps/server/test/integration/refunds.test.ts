import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/modules/audit/auditLog.js';
import {
  reconcilePendingRefunds,
  recordReversal,
  syncRefundFromPayPal,
} from '../../src/modules/payments/refunds.service.js';
import { testConfig } from '../helpers.js';
import { FakePayPal } from './fakePayPal.js';
import { db, makeApp, UserClient } from './harness.js';
import { FakeEvaluators, setupPurchaser } from './purchaseHarness.js';
import { testDatabaseUrl } from './testDatabase.js';

const ai = new FakeEvaluators();
const paypal = new FakePayPal();
const { app } = makeApp({ purchaseEvaluators: ai, paymentProvider: paypal });
const deps = () => ({
  db: db(),
  config: testConfig({ DATABASE_URL: testDatabaseUrl() }),
  provider: paypal,
});

beforeEach(() => {
  paypal.capture = 'COMPLETED';
  paypal.refund = 'COMPLETED';
});

const row = (id: string) => db().transaction.findUniqueOrThrow({ where: { id } });
const refunds = (transactionId: string) =>
  db().refund.findMany({ where: { transactionId }, orderBy: { createdAt: 'asc' } });
async function ledger(transactionId: string) {
  return (
    await db().ledgerEntry.findMany({ where: { transactionId }, orderBy: { createdAt: 'asc' } })
  ).map((l) => [l.type, l.amountMinor]);
}
const refund = (user: UserClient, id: string, body: object = {}, key: string = randomUUID()) =>
  user.http
    .post(`/api/v1/transactions/${id}/refunds`)
    .set('X-CSRF-Token', user.csrf)
    .set('Origin', 'http://localhost:5173')
    .set('Idempotency-Key', key)
    .send(body);
const usd = (value: string) => ({ amount: { currency: 'USD', value } });
/** Makes pending refunds old enough for reconciliation. */
const age = (transactionId: string) =>
  db().refund.updateMany({
    where: { transactionId },
    data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
  });

/** A purchaser with one captured 18.99 purchase. */
async function captured() {
  const s = await setupPurchaser(app, []);
  const res = await s.purchase();
  expect(res.body.status).toBe('AUTHORIZED');
  const id = res.body.id as string;
  await s.user.post(`/api/v1/transactions/${id}/checkout`);
  const t = await row(id);
  paypal.approve(t.paypalOrderId!);
  const done = await s.user.post(`/api/v1/transactions/${id}/checkout/complete`);
  expect(done.body.status).toBe('CAPTURED');
  return { ...s, id, captureId: (await row(id)).paypalCaptureId! };
}

describe('refunds from the dashboard', () => {
  it('refunds everything by default, credits the budget once, and tells the agent', async () => {
    const s = await captured();
    const res = await refund(s.user, s.id, { reason: 'Wrong cable' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REFUNDED');
    expect(res.body.payment).toMatchObject({ refundedMinor: 1899, refundableMinor: 0 });
    expect(res.body.refunds).toEqual([
      expect.objectContaining({ amountMinor: 1899, status: 'COMPLETED', source: 'LEASH' }),
    ]);
    expect(await ledger(s.id)).toEqual([
      ['RESERVE', 1899],
      ['REFUND', 1899],
    ]);
    const agent = await s.bot.get(`/api/agent/v1/purchase-requests/${s.id}`);
    expect(agent.body.status).toBe('REFUNDED');
    expect(agent.body.reasonCodes).toContain('REFUNDED');
    expect((await refund(s.user, s.id)).body.error.code).toBe('REFUND_NOT_AVAILABLE');
    expect((await verifyAuditChain(db())).valid).toBe(true);
  });

  it('supports partial refunds up to the captured amount', async () => {
    const s = await captured();
    const first = await refund(s.user, s.id, usd('5.00'));
    expect(first.body).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      payment: { refundedMinor: 500, refundableMinor: 1399 },
    });
    const tooMuch = await refund(s.user, s.id, usd('14.00'));
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('REFUND_EXCEEDS_CAPTURED');
    const rest = await refund(s.user, s.id, usd('13.99'));
    expect(rest.body.status).toBe('REFUNDED');
    expect(await ledger(s.id)).toEqual([
      ['RESERVE', 1899],
      ['REFUND', 500],
      ['REFUND', 1399],
    ]);
  });

  it('validates the request', async () => {
    const s = await captured();
    const noKey = await s.user.post(`/api/v1/transactions/${s.id}/refunds`, {});
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(
      (await refund(s.user, s.id, { amount: { currency: 'EUR', value: '1.00' } })).status,
    ).toBe(400);
    expect((await refund(s.user, s.id, usd('0.00'))).status).toBe(400);
    expect((await refund(s.user, s.id, usd('1.001'))).status).toBe(400);
    expect((await refund(s.user, s.id, { amount: usd('1.00').amount, extra: 1 })).status).toBe(400);
    expect(await refunds(s.id)).toHaveLength(0);
  });

  it('is idempotent per key, including concurrent retries', async () => {
    const s = await captured();
    const key = randomUUID();
    const before = paypal.calls.refund;
    const results = await Promise.all([1, 2, 3].map(() => refund(s.user, s.id, usd('2.00'), key)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await refunds(s.id)).toHaveLength(1);
    expect(paypal.calls.refund - before).toBe(1);
    const reused = await refund(s.user, s.id, usd('3.00'), key);
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('never refunds more than was captured under concurrency', async () => {
    const s = await captured();
    const results = await Promise.all([1, 2, 3, 4].map(() => refund(s.user, s.id, usd('10.00'))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await row(s.id)).refundedMinor).toBe(1000);
  });

  it('refused or failed refunds credit nothing and free the amount again', async () => {
    const s = await captured();
    paypal.refund = 'reject';
    const res = await refund(s.user, s.id, usd('5.00'));
    expect(res.body.refunds[0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'REFUND_AMOUNT_EXCEEDED',
    });
    expect(res.body.payment.refundableMinor).toBe(1899);
    paypal.refund = 'FAILED';
    expect((await refund(s.user, s.id, usd('5.00'))).body.refunds[1].status).toBe('FAILED');
    expect(await ledger(s.id)).toEqual([['RESERVE', 1899]]);
    expect((await row(s.id)).status).toBe('CAPTURED');
  });

  it('only the owner can refund, with CSRF; agents never can; unpaid purchases cannot be refunded', async () => {
    const s = await captured();
    const other = await UserClient.register(app);
    expect((await refund(other, s.id)).status).toBe(404);
    expect(
      (
        await s.bot
          .post(`/api/v1/transactions/${s.id}/refunds`)
          .set('Idempotency-Key', randomUUID())
          .send({})
      ).status,
    ).toBe(401);
    expect(
      (
        await s.user.http
          .post(`/api/v1/transactions/${s.id}/refunds`)
          .set('Origin', 'http://localhost:5173')
          .set('Idempotency-Key', randomUUID())
          .send({})
      ).status,
    ).toBe(403);
    const unpaid = await s.purchase({ item: { description: 'Another cable', quantity: 1 } });
    expect((await refund(s.user, unpaid.body.id)).body.error.code).toBe('REFUND_NOT_AVAILABLE');
  });
});

describe('uncertain refund outcomes', () => {
  it('a pending refund holds until PayPal completes it', async () => {
    const s = await captured();
    paypal.refund = 'PENDING';
    const res = await refund(s.user, s.id, usd('5.00'));
    expect(res.body.refunds[0].status).toBe('PENDING');
    expect(res.body.status).toBe('CAPTURED');
    expect(res.body.payment.refundableMinor).toBe(1399); // pending counts
    expect(await ledger(s.id)).toEqual([['RESERVE', 1899]]);

    const r = (await refunds(s.id))[0]!;
    paypal.settleRefund(r.paypalRefundId!, 'COMPLETED');
    await age(s.id);
    await reconcilePendingRefunds(deps(), { minAgeMs: 60_000 });
    expect((await refunds(s.id))[0]!.status).toBe('COMPLETED');
    expect((await row(s.id)).status).toBe('PARTIALLY_REFUNDED');
  });

  it('a request lost before PayPal is re-sent with the same request ID after checking PayPal', async () => {
    const s = await captured();
    paypal.refund = 'network-before';
    const res = await refund(s.user, s.id, usd('5.00'));
    expect(res.body.refunds[0].status).toBe('PENDING');

    await reconcilePendingRefunds(deps(), { minAgeMs: 60_000 }); // too recent: untouched
    expect((await refunds(s.id))[0]!.status).toBe('PENDING');

    paypal.refund = 'COMPLETED';
    const executions = paypal.refundExecutions;
    await age(s.id);
    await reconcilePendingRefunds(deps(), { minAgeMs: 60_000 });
    const [r] = await refunds(s.id);
    expect(r!.status).toBe('COMPLETED');
    expect(paypal.refundExecutions - executions).toBe(1);
    expect(await ledger(s.id)).toEqual([
      ['RESERVE', 1899],
      ['REFUND', 500],
    ]);
  });

  it('a refund whose response was lost is found on the order, never sent again', async () => {
    const s = await captured();
    paypal.refund = 'network-after';
    await refund(s.user, s.id, usd('5.00'));
    expect((await refunds(s.id))[0]!.status).toBe('PENDING');
    const calls = paypal.calls.refund;
    await age(s.id);
    await reconcilePendingRefunds(deps(), { minAgeMs: 60_000 });
    expect((await refunds(s.id))[0]!.status).toBe('COMPLETED');
    expect(paypal.calls.refund).toBe(calls);
    expect(paypal.refundExecutions).toBeGreaterThan(0);
  });

  it('gives up (FAILED, flagged) when PayPal never shows the refund within the window', async () => {
    const s = await captured();
    paypal.refund = 'network-before';
    await refund(s.user, s.id, usd('5.00'));
    await age(s.id);
    await reconcilePendingRefunds(deps(), { minAgeMs: 60_000, maxAgeMs: 0 });
    expect((await refunds(s.id))[0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'NOT_FOUND_AT_PAYPAL',
    });
    expect(await ledger(s.id)).toHaveLength(1);
  });

  it('settling the same refund from two paths at once credits the budget once', async () => {
    const s = await captured();
    paypal.refund = 'PENDING';
    await refund(s.user, s.id, usd('5.00'));
    const r = (await refunds(s.id))[0]!;
    paypal.settleRefund(r.paypalRefundId!, 'COMPLETED');
    await age(s.id);
    await Promise.all([
      syncRefundFromPayPal(deps(), r.paypalRefundId!),
      syncRefundFromPayPal(deps(), r.paypalRefundId!),
      reconcilePendingRefunds(deps(), { minAgeMs: 60_000 }),
    ]);
    expect(await ledger(s.id)).toEqual([
      ['RESERVE', 1899],
      ['REFUND', 500],
    ]);
  });
});

describe('changes made outside Leash', () => {
  it('records a refund made in the PayPal dashboard once and restores the budget', async () => {
    const s = await captured();
    const ext = paypal.externalRefund(s.captureId, '3.00');
    expect(await syncRefundFromPayPal(deps(), ext.id)).toBe('recorded');
    expect(await syncRefundFromPayPal(deps(), ext.id)).toBe('settled');
    const all = await refunds(s.id);
    expect(all).toEqual([
      expect.objectContaining({ source: 'PAYPAL', status: 'COMPLETED', amountMinor: 300 }),
    ]);
    expect(all[0]!.requestedByUserId).toBeNull();
    expect(await row(s.id)).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedMinor: 300 });
    expect(await ledger(s.id)).toEqual([
      ['RESERVE', 1899],
      ['REFUND', 300],
    ]);
  });

  it('records a reversal confirmed by PayPal, crediting only what was not refunded', async () => {
    const s = await captured();
    await refund(s.user, s.id, usd('5.00'));
    // Not reversed at PayPal: a claim alone changes nothing.
    expect(await recordReversal(deps(), s.captureId)).toBe('unchanged');
    paypal.reverse(s.captureId);
    expect(await recordReversal(deps(), s.captureId)).toBe('reversed');
    expect(await recordReversal(deps(), s.captureId)).toBe('unchanged');
    expect(await row(s.id)).toMatchObject({ status: 'REVERSED', refundedMinor: 1899 });
    expect(await ledger(s.id)).toEqual([
      ['RESERVE', 1899],
      ['REFUND', 500],
      ['REFUND', 1399],
    ]);
    const agent = await s.bot.get(`/api/agent/v1/purchase-requests/${s.id}`);
    expect(agent.body.status).toBe('REVERSED');
    expect((await refund(s.user, s.id)).body.error.code).toBe('REFUND_NOT_AVAILABLE');
    expect((await verifyAuditChain(db())).valid).toBe(true);
  });
});
