import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/modules/audit/auditLog.js';
import { expireOverdueAuthorizations } from '../../src/modules/budget/recovery.js';
import { reconcileCapturingPayments } from '../../src/modules/payments/checkout.service.js';
import { testConfig } from '../helpers.js';
import { FakePayPal } from './fakePayPal.js';
import { auditActions, db, makeApp, PASSWORD, UserClient } from './harness.js';
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
  paypal.captureDelayMs = 0;
});

const checkout = (user: UserClient, id: string) => user.post(`/api/v1/transactions/${id}/checkout`);
const complete = (user: UserClient, id: string) =>
  user.post(`/api/v1/transactions/${id}/checkout/complete`);

async function ledger(transactionId: string) {
  return (
    await db().ledgerEntry.findMany({ where: { transactionId }, orderBy: { createdAt: 'asc' } })
  ).map((l) => [l.type, l.amountMinor]);
}
const row = (id: string) => db().transaction.findUniqueOrThrow({ where: { id } });

/** A purchaser with one ALLOWed (AUTHORIZED) purchase. */
async function authorized(rules: unknown[] = [], overrides: Record<string, unknown> = {}) {
  const s = await setupPurchaser(app, rules);
  const res = await s.purchase(overrides);
  expect(res.body.status).toBe('AUTHORIZED');
  return { ...s, id: res.body.id as string };
}

/** …with a PayPal order the buyer has approved. */
async function buyerApproved(rules: unknown[] = [], overrides: Record<string, unknown> = {}) {
  const s = await authorized(rules, overrides);
  const started = await checkout(s.user, s.id);
  expect(started.status).toBe(200);
  const orderId = (await row(s.id)).paypalOrderId!;
  paypal.approve(orderId);
  return { ...s, orderId };
}

/** Makes the purchase look like it has been CAPTURING for a while (reconciliation age). */
const age = (id: string) =>
  db().transaction.update({
    where: { id },
    data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
  });

describe('checkout happy path', () => {
  it('creates the order from stored values, waits for buyer approval, verifies, captures once', async () => {
    const s = await authorized();
    const started = await checkout(s.user, s.id);
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('REDIRECT');
    expect(new URL(started.body.approveUrl).hostname).toBe('www.sandbox.paypal.com');

    const t = await row(s.id);
    expect(t.status).toBe('ORDER_CREATED');
    const order = paypal.orders.get(t.paypalOrderId!)!;
    expect(order.request).toMatchObject({
      transactionId: s.id,
      amountMinor: 1899,
      currency: 'USD',
      payeeEmail: s.merchant.paypalEmail,
      returnUrl: `http://localhost:5173/transactions/${s.id}/paypal-return`,
    });

    // The agent sees progress, never PayPal data.
    const agentView = await s.bot.get(`/api/agent/v1/purchase-requests/${s.id}`);
    expect(agentView.body.status).toBe('ORDER_CREATED');
    const agentJson = JSON.stringify(agentView.body);
    expect(agentJson).not.toContain(t.paypalOrderId!);
    expect(agentJson).not.toMatch(/paypal|checkoutnow|token=/i);

    // Returning before the buyer approved: nothing happens.
    const early = await complete(s.user, s.id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ORDER_NOT_APPROVED');
    expect(paypal.calls.capture).toBe(0);

    paypal.approve(t.paypalOrderId!);
    const done = await complete(s.user, s.id);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('CAPTURED');
    expect(done.body.payment).toMatchObject({
      payee: s.merchant.paypalEmail,
      paypalOrderId: t.paypalOrderId,
      capturedMinor: 1899,
    });
    expect(done.body.payment.paypalCaptureId).toMatch(/^CAP/);
    expect(JSON.stringify(done.body)).not.toContain('checkoutnow');

    // Captured: the reservation stays as spend.
    expect(await ledger(s.id)).toEqual([['RESERVE', 1899]]);
    const agentAfter = await s.bot.get(`/api/agent/v1/purchase-requests/${s.id}`);
    expect(agentAfter.body).toMatchObject({ status: 'CAPTURED', reasonCodes: ['PAID'] });

    // Retrying the return is harmless.
    const again = await complete(s.user, s.id);
    expect(again.body.status).toBe('CAPTURED');
    expect(order.captureRequestId).toBe(`leash-capture-${s.id}`);

    expect(await auditActions(s.user.user.id)).toEqual(
      expect.arrayContaining([
        'purchase.order_created',
        'purchase.capture_started',
        'purchase.captured',
      ]),
    );
    expect((await verifyAuditChain(db())).valid).toBe(true);
  });

  it('pays an escalated purchase only after Leash human approval', async () => {
    const s = await setupPurchaser(app, [{ id: 'ask', type: 'new_merchant', action: 'ESCALATE' }]);
    const res = await s.purchase();
    expect(res.body.status).toBe('PENDING_APPROVAL');
    const blocked = await checkout(s.user, res.body.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PAYMENT_NOT_AVAILABLE');

    const detail = (await s.user.get(`/api/v1/transactions/${res.body.id}`)).body;
    await s.user.post('/api/v1/auth/step-up', { password: PASSWORD });
    const ok = await s.user.post(`/api/v1/approvals/${detail.approval.id}/approve`, {
      snapshotHash: detail.approval.snapshotHash,
    });
    expect(ok.body.status).toBe('AUTHORIZED');
    expect((await checkout(s.user, res.body.id)).status).toBe(200);
    paypal.approve((await row(res.body.id)).paypalOrderId!);
    expect((await complete(s.user, res.body.id)).body.status).toBe('CAPTURED');
  });

  it('allows a purchase that exactly fills a limit (its own reservation is excluded)', async () => {
    const s = await buyerApproved([
      {
        id: 'weekly',
        type: 'max_spend_per_period',
        period: 'week',
        amountMinor: 1899,
        action: 'BLOCK',
      },
    ]);
    expect((await complete(s.user, s.id)).body.status).toBe('CAPTURED');
  });
});

describe('duplicate and concurrent requests', () => {
  it('re-uses one order for repeated and concurrent checkout starts', async () => {
    const s = await authorized();
    const created = paypal.orders.size;
    const results = await Promise.all([1, 2, 3, 4].map(() => checkout(s.user, s.id)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(paypal.orders.size).toBe(created + 1);
    const urls = new Set(results.map((r) => r.body.approveUrl));
    expect(urls.size).toBe(1);
    // Resuming later fetches the same order again.
    expect((await checkout(s.user, s.id)).body.approveUrl).toBe([...urls][0]);
    paypal.approve((await row(s.id)).paypalOrderId!);
    expect((await checkout(s.user, s.id)).body).toEqual({ status: 'APPROVED' });
  });

  it('captures exactly once when the return is completed many times at once', async () => {
    const s = await buyerApproved();
    paypal.captureDelayMs = 50;
    const before = paypal.captureExecutions;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => complete(s.user, s.id)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(paypal.captureExecutions - before).toBe(1);
    expect((await row(s.id)).status).toBe('CAPTURED');
  });

  it('settles a race between completing and cancelling consistently', async () => {
    const s = await buyerApproved();
    paypal.captureDelayMs = 20;
    const before = paypal.captureExecutions;
    const [done, cancel] = await Promise.all([
      complete(s.user, s.id),
      s.user.post(`/api/v1/transactions/${s.id}/cancel`),
    ]);
    const t = await row(s.id);
    if (t.status === 'CANCELLED') {
      expect(paypal.captureExecutions).toBe(before);
      expect(await ledger(s.id)).toEqual([
        ['RESERVE', 1899],
        ['RELEASE', 1899],
      ]);
    } else {
      expect(t.status).toBe('CAPTURED');
      expect(cancel.status).toBe(409);
      expect(done.status).toBe(200);
      expect(await ledger(s.id)).toEqual([['RESERVE', 1899]]);
    }
  });
});

describe('verification before capture', () => {
  it.each([
    ['amount', { amountValue: '1.00' }],
    ['payee', { payeeEmail: 'attacker@evil.example.test' }],
    ['custom_id', { customId: 'f00d' }],
    ['currency', { currency: 'EUR' }],
  ])(
    'refuses an order whose %s was changed, and releases the funds once',
    async (field, change) => {
      const s = await buyerApproved();
      paypal.tamper(s.orderId, change);
      const res = await complete(s.user, s.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_MISMATCH');
      const t = await row(s.id);
      expect(t).toMatchObject({ status: 'PAYMENT_FAILED', paymentFailureReason: 'ORDER_MISMATCH' });
      expect(paypal.orders.get(s.orderId)!.captureRequestId).toBeNull();
      expect(await ledger(s.id)).toEqual([
        ['RESERVE', 1899],
        ['RELEASE', 1899],
      ]);
      const anomaly = await db().auditEvent.findFirst({
        where: { transactionId: s.id, action: 'purchase.payment_anomaly' },
      });
      expect((anomaly!.data as { mismatches: string[] }).mismatches).toContain(field);
      // Retrying changes nothing.
      expect((await complete(s.user, s.id)).status).toBe(409);
      expect(await ledger(s.id)).toHaveLength(2);
    },
  );

  it('ignores order IDs and flags supplied by the redirect', async () => {
    const a = await authorized();
    await checkout(a.user, a.id);
    const b = await buyerApproved();
    const res = await a.user.http
      .post(`/api/v1/transactions/${a.id}/checkout/complete?token=${b.orderId}&PayerID=X`)
      .set('X-CSRF-Token', a.user.csrf)
      .set('Origin', 'http://localhost:5173')
      .send({ orderId: b.orderId, status: 'APPROVED' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_APPROVED');
    expect((await row(a.id)).status).toBe('ORDER_CREATED');
    expect((await row(b.id)).status).toBe('ORDER_CREATED');
  });

  it('refuses when the current policy now blocks, and releases the funds', async () => {
    const s = await buyerApproved();
    await s.user.post('/api/v1/policies/pause', { password: PASSWORD });
    const res = await complete(s.user, s.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POLICY_NOW_BLOCKS');
    expect(await row(s.id)).toMatchObject({
      status: 'PAYMENT_FAILED',
      paymentFailureReason: 'POLICY_BLOCKED_AT_CAPTURE',
    });
    expect(paypal.orders.get(s.orderId)!.captureRequestId).toBeNull();
    expect(await ledger(s.id)).toEqual([
      ['RESERVE', 1899],
      ['RELEASE', 1899],
    ]);
    const agent = await s.bot.get(`/api/agent/v1/purchase-requests/${s.id}`);
    expect(agent.body).toMatchObject({ status: 'PAYMENT_FAILED', reasonCodes: ['PAYMENT_FAILED'] });
  });

  it('refuses when the merchant’s PayPal account changed after authorization', async () => {
    const s = await authorized();
    await s.user.patch(`/api/v1/merchants/${s.merchant.id}`, {
      paypalEmail: 'new-account@business.example.test',
    });
    const start = await checkout(s.user, s.id);
    expect(start.status).toBe(409);
    expect(start.body.error.code).toBe('PAYEE_CHANGED');
    expect((await row(s.id)).status).toBe('AUTHORIZED');

    const s2 = await buyerApproved();
    await s2.user.patch(`/api/v1/merchants/${s2.merchant.id}`, {
      paypalEmail: 'new-account@business.example.test',
    });
    const res = await complete(s2.user, s2.id);
    expect(res.body.error.code).toBe('PAYEE_CHANGED');
    expect((await row(s2.id)).status).toBe('PAYMENT_FAILED');
  });

  it('fails a voided order without capturing', async () => {
    const s = await buyerApproved();
    paypal.void(s.orderId);
    expect((await complete(s.user, s.id)).body.error.code).toBe('ORDER_VOIDED');
    expect(await row(s.id)).toMatchObject({ status: 'PAYMENT_FAILED' });
  });
});

describe('authorization deadline', () => {
  const expire = (id: string) =>
    db().transaction.update({
      where: { id },
      data: { authorizationExpiresAt: new Date(Date.now() - 1000) },
    });

  it('never creates an order or captures after the deadline', async () => {
    const s = await authorized();
    await expire(s.id);
    const res = await checkout(s.user, s.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUTHORIZATION_EXPIRED');
    expect((await row(s.id)).status).toBe('EXPIRED');

    const s2 = await buyerApproved();
    await expire(s2.id);
    const late = await complete(s2.user, s2.id);
    expect(late.body.error.code).toBe('AUTHORIZATION_EXPIRED');
    expect(await row(s2.id)).toMatchObject({ status: 'EXPIRED' });
    expect(paypal.orders.get(s2.orderId)!.captureRequestId).toBeNull();
    expect(await ledger(s2.id)).toEqual([
      ['RESERVE', 1899],
      ['RELEASE', 1899],
    ]);
  });

  it('the sweep expires unpaid orders but never a purchase that is capturing', async () => {
    const created = await authorized();
    await checkout(created.user, created.id);
    const capturing = await buyerApproved();
    paypal.capture = 'network-before';
    await complete(capturing.user, capturing.id);
    expect((await row(capturing.id)).status).toBe('CAPTURING');

    const later = new Date(Date.now() + 2 * 60 * 60_000);
    const { expired } = await expireOverdueAuthorizations(db(), { now: later });
    expect(expired).toContain(created.id);
    expect(expired).not.toContain(capturing.id);
    expect((await row(created.id)).status).toBe('EXPIRED');
    expect((await row(capturing.id)).status).toBe('CAPTURING');
  });
});

describe('capture outcomes and reconciliation', () => {
  it('a declined capture fails the payment and releases the funds', async () => {
    const s = await buyerApproved();
    paypal.capture = 'DECLINED';
    expect((await complete(s.user, s.id)).body.status).toBe('PAYMENT_FAILED');
    expect(await row(s.id)).toMatchObject({ paymentFailureReason: 'PAYMENT_DECLINED' });
    expect(await ledger(s.id)).toHaveLength(2);
  });

  it('a refused capture (nothing captured at PayPal) fails the payment', async () => {
    const s = await buyerApproved();
    paypal.capture = 'reject';
    expect((await complete(s.user, s.id)).body.status).toBe('PAYMENT_FAILED');
    expect(await ledger(s.id)).toHaveLength(2);
  });

  it('a pending capture keeps the funds held until reconciliation sees it complete', async () => {
    const s = await buyerApproved();
    paypal.capture = 'PENDING';
    const res = await complete(s.user, s.id);
    expect(res.body.status).toBe('CAPTURING');
    expect(res.body.payment.paypalCaptureId).toMatch(/^CAP/);
    expect(await ledger(s.id)).toEqual([['RESERVE', 1899]]);

    await age(s.id);
    await reconcileCapturingPayments(deps(), { minAgeMs: 60_000 });
    expect((await row(s.id)).status).toBe('CAPTURING'); // still pending at PayPal

    paypal.settleCapture(s.orderId, 'COMPLETED');
    await age(s.id);
    await reconcileCapturingPayments(deps(), { minAgeMs: 60_000 });
    expect(await row(s.id)).toMatchObject({ status: 'CAPTURED', capturedMinor: 1899 });
  });

  it('an unknown outcome (request lost before PayPal) is retried with the same request ID', async () => {
    const s = await buyerApproved();
    paypal.capture = 'network-before';
    expect((await complete(s.user, s.id)).body.status).toBe('CAPTURING');
    expect(await auditActions(s.user.user.id)).toContain('purchase.capture_uncertain');

    // Too recent: reconciliation leaves it alone.
    await reconcileCapturingPayments(deps(), { minAgeMs: 60_000 });
    expect((await row(s.id)).status).toBe('CAPTURING');

    paypal.capture = 'COMPLETED';
    const before = paypal.captureExecutions;
    await age(s.id);
    await reconcileCapturingPayments(deps(), { minAgeMs: 60_000 });
    expect((await row(s.id)).status).toBe('CAPTURED');
    expect(paypal.captureExecutions - before).toBe(1);
    expect(paypal.orders.get(s.orderId)!.captureRequestId).toBe(`leash-capture-${s.id}`);
  });

  it('an unknown outcome where PayPal did capture is recorded without capturing again', async () => {
    const s = await buyerApproved();
    paypal.capture = 'network-after';
    const before = paypal.captureExecutions;
    expect((await complete(s.user, s.id)).body.status).toBe('CAPTURING');
    expect(paypal.captureExecutions - before).toBe(1);

    const captureCalls = paypal.calls.capture;
    await age(s.id);
    await reconcileCapturingPayments(deps(), { minAgeMs: 60_000 });
    expect((await row(s.id)).status).toBe('CAPTURED');
    expect(paypal.calls.capture).toBe(captureCalls); // read, not re-captured
    expect(paypal.captureExecutions - before).toBe(1);
    expect(await ledger(s.id)).toEqual([['RESERVE', 1899]]);
  });

  it('an unknown outcome past the deadline with no capture at PayPal expires and releases', async () => {
    const s = await buyerApproved();
    paypal.capture = 'network-before';
    await complete(s.user, s.id);
    await db().transaction.update({
      where: { id: s.id },
      data: {
        authorizationExpiresAt: new Date(Date.now() - 1000),
        updatedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    paypal.capture = 'COMPLETED';
    const calls = paypal.calls.capture;
    await reconcileCapturingPayments(deps(), { minAgeMs: 60_000 });
    expect((await row(s.id)).status).toBe('EXPIRED');
    expect(paypal.calls.capture).toBe(calls);
    expect(await ledger(s.id)).toHaveLength(2);
  });
});

describe('access', () => {
  it('needs a signed-in owner with a CSRF token; agents have no way in', async () => {
    const s = await authorized();
    expect((await s.bot.post(`/api/v1/transactions/${s.id}/checkout`)).status).toBe(401);
    expect(
      (
        await s.user.http
          .post(`/api/v1/transactions/${s.id}/checkout`)
          .set('Origin', 'http://localhost:5173')
      ).status,
    ).toBe(403);
    const other = await UserClient.register(app);
    expect((await checkout(other, s.id)).status).toBe(404);
    expect((await complete(other, s.id)).status).toBe(404);
  });

  it('answers 503 when PayPal is not configured', async () => {
    const { app: unconfigured } = makeApp({ purchaseEvaluators: ai, paymentProvider: null });
    const s = await setupPurchaser(unconfigured, []);
    const res = await s.purchase();
    const start = await s.user.post(`/api/v1/transactions/${res.body.id}/checkout`);
    expect(start.status).toBe(503);
    expect(start.body.error.code).toBe('PAYMENTS_NOT_CONFIGURED');
  });

  it('cannot pay a blocked purchase', async () => {
    const s = await setupPurchaser(app, [
      { id: 'cap', type: 'max_amount_per_transaction', amountMinor: 100, action: 'BLOCK' },
    ]);
    const res = await s.purchase();
    expect(res.body.status).toBe('BLOCKED');
    expect((await checkout(s.user, res.body.id)).body.error.code).toBe('PAYMENT_NOT_AVAILABLE');
  });
});
