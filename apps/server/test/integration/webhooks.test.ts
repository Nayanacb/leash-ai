import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/modules/audit/auditLog.js';
import { reprocessWebhookEvents } from '../../src/modules/payments/webhooks.js';
import { testConfig } from '../helpers.js';
import { FakePayPal, VALID_SIGNATURE } from './fakePayPal.js';
import { db, makeApp } from './harness.js';
import { FakeEvaluators, setupPurchaser } from './purchaseHarness.js';
import { testDatabaseUrl } from './testDatabase.js';

const ai = new FakeEvaluators();
const paypal = new FakePayPal();
const env = { PAYPAL_WEBHOOK_ID: paypal.webhookId };
const { app } = makeApp({ purchaseEvaluators: ai, paymentProvider: paypal, env });
const deps = () => ({
  db: db(),
  config: testConfig({ DATABASE_URL: testDatabaseUrl(), ...env }),
  provider: paypal,
});

beforeEach(() => {
  paypal.capture = 'COMPLETED';
  paypal.refund = 'COMPLETED';
});

const row = (id: string) => db().transaction.findUniqueOrThrow({ where: { id } });
const ledger = async (transactionId: string) =>
  (
    await db().ledgerEntry.findMany({ where: { transactionId }, orderBy: { createdAt: 'asc' } })
  ).map((l) => [l.type, l.amountMinor]);

interface Delivery {
  sig?: string;
  time?: string;
  certUrl?: string;
  omit?: string;
  target?: Express;
}

function deliver(event: object | string, opts: Delivery = {}) {
  const raw = typeof event === 'string' ? event : JSON.stringify(event);
  const headers: Record<string, string> = {
    'paypal-transmission-id': randomUUID(),
    'paypal-transmission-time': opts.time ?? new Date().toISOString(),
    'paypal-transmission-sig': opts.sig ?? VALID_SIGNATURE,
    'paypal-cert-url':
      opts.certUrl ?? 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42',
    'paypal-auth-algo': 'SHA256withRSA',
  };
  if (opts.omit) delete headers[opts.omit];
  return request(opts.target ?? app)
    .post('/api/webhooks/paypal')
    .set(headers)
    .set('Content-Type', 'application/json')
    .send(raw);
}

const event = (type: string, resource: object, id = `WH-${randomUUID()}`) => ({
  id,
  event_type: type,
  resource_type: 'x',
  create_time: new Date().toISOString(),
  resource,
});

const stored = (paypalEventId: string) =>
  db().webhookEvent.findUnique({ where: { paypalEventId } });

/** A purchase whose PayPal order exists; the buyer approved it but never came back. */
async function approvedButNotReturned() {
  const s = await setupPurchaser(app, []);
  const res = await s.purchase();
  expect(res.body.status).toBe('AUTHORIZED');
  await s.user.post(`/api/v1/transactions/${res.body.id}/checkout`);
  const orderId = (await row(res.body.id)).paypalOrderId!;
  paypal.approve(orderId);
  return { ...s, id: res.body.id as string, orderId };
}

async function captured() {
  const s = await approvedButNotReturned();
  await s.user.post(`/api/v1/transactions/${s.id}/checkout/complete`);
  return { ...s, captureId: (await row(s.id)).paypalCaptureId! };
}

describe('delivery checks', () => {
  it('only acts on deliveries PayPal verifies, and stores nothing else', async () => {
    const before = await db().webhookEvent.count();
    const e = event('CHECKOUT.ORDER.APPROVED', { id: 'ORDER00000001' });

    const bad = await deliver(e, { sig: 'forged' });
    expect(bad.status).toBe(400);
    for (const omit of ['paypal-transmission-sig', 'paypal-cert-url', 'paypal-transmission-id']) {
      expect((await deliver(e, { omit })).status).toBe(400);
    }
    // Live or foreign certificate hosts, and replays outside the time window.
    expect(
      (await deliver(e, { certUrl: 'https://api.paypal.com/v1/notifications/certs/C' })).status,
    ).toBe(400);
    expect((await deliver(e, { certUrl: 'https://evil.example/cert' })).status).toBe(400);
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    expect((await deliver(e, { time: old })).status).toBe(400);
    expect((await deliver('not json')).status).toBe(400);
    expect(await db().webhookEvent.count()).toBe(before);
  });

  it('sends PayPal the body exactly as received', async () => {
    const raw = `{"id":"WH-${randomUUID()}",  "event_type":"SOMETHING.ELSE","resource":{"id":"X1","v":1.10}}`;
    expect((await deliver(raw)).status).toBe(200);
    expect(paypal.verifiedBodies.at(-1)).toBe(raw);
  });

  it('answers 503 (so PayPal retries) until webhooks are configured', async () => {
    const { app: unconfigured } = makeApp({ purchaseEvaluators: ai, paymentProvider: paypal });
    const res = await deliver(event('X', { id: 'X1' }), { target: unconfigured });
    expect(res.status).toBe(503);
  });

  it('is rate limited per IP', async () => {
    const { app: limited } = makeApp({
      purchaseEvaluators: ai,
      paymentProvider: paypal,
      env,
      rateLimits: { webhooksPerIpPerMinute: 2 },
    });
    const statuses = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await deliver(event('X', { id: 'X1' }), { target: limited })).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe('checkout events', () => {
  it('CHECKOUT.ORDER.APPROVED completes checkout through the same checks, once', async () => {
    const s = await approvedButNotReturned();
    const e = event('CHECKOUT.ORDER.APPROVED', {
      id: s.orderId,
      status: 'APPROVED',
      payer: { email_address: 'buyer@personal.example.test', name: { given_name: 'Ada' } },
    });
    const before = paypal.captureExecutions;
    expect((await deliver(e)).body).toEqual({ received: true });
    expect(await row(s.id)).toMatchObject({ status: 'CAPTURED', capturedMinor: 1899 });

    // Stored as a minimal summary: no payer details.
    const saved = await stored(e.id);
    expect(saved).toMatchObject({ verified: true, transactionId: s.id });
    expect(saved!.processedAt).not.toBeNull();
    expect(JSON.stringify(saved!.payload)).not.toMatch(/buyer@|Ada|payer/);

    // Duplicate delivery: acknowledged, not processed again.
    expect((await deliver(e)).body).toEqual({ received: true, duplicate: true });
    expect(paypal.captureExecutions - before).toBe(1);
    const audit = await db().auditEvent.findFirst({
      where: { transactionId: s.id, action: 'purchase.capture_started' },
    });
    expect(audit!.actorType).toBe('SYSTEM');
  });

  it('never trusts the payload: an approval PayPal does not confirm captures nothing', async () => {
    const s = await setupPurchaser(app, []);
    const res = await s.purchase();
    await s.user.post(`/api/v1/transactions/${res.body.id}/checkout`);
    const orderId = (await row(res.body.id)).paypalOrderId!;
    // Valid signature, but PayPal says the buyer hasn't approved.
    const e = event('CHECKOUT.ORDER.APPROVED', { id: orderId, status: 'APPROVED' });
    expect((await deliver(e)).status).toBe(200);
    expect((await row(res.body.id)).status).toBe('ORDER_CREATED');
    expect(paypal.orders.get(orderId)!.captureRequestId).toBeNull();
  });

  it('applies every check: a tampered order is refused, an expired authorization expires', async () => {
    const a = await approvedButNotReturned();
    paypal.tamper(a.orderId, { amountValue: '1.00' });
    await deliver(event('CHECKOUT.ORDER.APPROVED', { id: a.orderId }));
    expect(await row(a.id)).toMatchObject({
      status: 'PAYMENT_FAILED',
      paymentFailureReason: 'ORDER_MISMATCH',
    });

    const b = await approvedButNotReturned();
    await db().transaction.update({
      where: { id: b.id },
      data: { authorizationExpiresAt: new Date(Date.now() - 1000) },
    });
    await deliver(event('CHECKOUT.ORDER.APPROVED', { id: b.orderId }));
    expect((await row(b.id)).status).toBe('EXPIRED');
    expect(paypal.orders.get(b.orderId)!.captureRequestId).toBeNull();
  });

  it('never revives a cancelled purchase and records unknown orders without acting', async () => {
    const s = await approvedButNotReturned();
    await s.user.post(`/api/v1/transactions/${s.id}/cancel`);
    await deliver(event('CHECKOUT.ORDER.APPROVED', { id: s.orderId }));
    expect((await row(s.id)).status).toBe('CANCELLED');

    const unknown = event('CHECKOUT.ORDER.APPROVED', { id: 'NOTLEASHORDER1' });
    expect((await deliver(unknown)).status).toBe(200);
    expect(
      await db().auditEvent.findFirst({
        where: {
          action: 'payment.webhook_unmatched',
          data: { path: ['eventId'], equals: unknown.id },
        },
      }),
    ).not.toBeNull();
  });

  it('handles capture events in any order by reading PayPal’s current state', async () => {
    const s = await approvedButNotReturned();
    paypal.capture = 'PENDING';
    await s.user.post(`/api/v1/transactions/${s.id}/checkout/complete`);
    const captureId = (await row(s.id)).paypalCaptureId!;
    const capture = (status: string) =>
      event(`PAYMENT.CAPTURE.${status}`, {
        id: captureId,
        status,
        supplementary_data: { related_ids: { order_id: s.orderId } },
      });

    // "Completed" arrives early, but PayPal still says pending: nothing changes.
    await deliver(capture('COMPLETED'));
    expect((await row(s.id)).status).toBe('CAPTURING');

    paypal.settleCapture(s.orderId, 'COMPLETED');
    // A late "pending" event still settles to what PayPal says now.
    await deliver(capture('PENDING'));
    expect((await row(s.id)).status).toBe('CAPTURED');
    // A stray "denied" afterwards can't undo a capture.
    await deliver(capture('DENIED'));
    expect(await row(s.id)).toMatchObject({ status: 'CAPTURED' });
    expect(await ledger(s.id)).toEqual([['RESERVE', 1899]]);
  });
});

describe('refund and reversal events', () => {
  it('records a refund made in the PayPal dashboard exactly once', async () => {
    const s = await captured();
    const ext = paypal.externalRefund(s.captureId, '4.00');
    const e = event('PAYMENT.CAPTURE.REFUNDED', { id: ext.id, status: 'COMPLETED' });
    await deliver(e);
    await deliver(e); // duplicate delivery
    await deliver(event('PAYMENT.CAPTURE.REFUNDED', { id: ext.id })); // new event, same refund
    expect(await ledger(s.id)).toEqual([
      ['RESERVE', 1899],
      ['REFUND', 400],
    ]);
    expect(await row(s.id)).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedMinor: 400 });
  });

  it('completes a Leash refund that was pending', async () => {
    const s = await captured();
    paypal.refund = 'PENDING';
    await s.user.http
      .post(`/api/v1/transactions/${s.id}/refunds`)
      .set('X-CSRF-Token', s.user.csrf)
      .set('Origin', 'http://localhost:5173')
      .set('Idempotency-Key', randomUUID())
      .send({});
    const r = await db().refund.findFirstOrThrow({ where: { transactionId: s.id } });
    expect(r.status).toBe('PENDING');
    // The event alone isn't enough …
    await deliver(event('PAYMENT.CAPTURE.REFUNDED', { id: r.paypalRefundId, status: 'COMPLETED' }));
    expect((await db().refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('PENDING');
    // … PayPal must say so.
    paypal.settleRefund(r.paypalRefundId!, 'COMPLETED');
    await deliver(event('PAYMENT.CAPTURE.REFUNDED', { id: r.paypalRefundId }));
    expect((await db().refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('COMPLETED');
    expect((await row(s.id)).status).toBe('REFUNDED');
  });

  it('records a reversal only when PayPal confirms it', async () => {
    const s = await captured();
    const e = () => event('PAYMENT.CAPTURE.REVERSED', { id: s.captureId, status: 'REVERSED' });
    await deliver(e());
    expect((await row(s.id)).status).toBe('CAPTURED');
    paypal.reverse(s.captureId);
    await deliver(e());
    await deliver(e());
    expect((await row(s.id)).status).toBe('REVERSED');
    expect(await ledger(s.id)).toEqual([
      ['RESERVE', 1899],
      ['REFUND', 1899],
    ]);
    expect((await verifyAuditChain(db())).valid).toBe(true);
  });
});

describe('failures', () => {
  it('a processing failure returns 500, is kept, and is retried', async () => {
    const s = await approvedButNotReturned();
    const original = paypal.getOrder.bind(paypal);
    paypal.getOrder = async () => {
      throw new (await import('../../src/modules/payments/provider.js')).PaymentProviderError(
        'ambiguous',
        'TIMEOUT',
        'timed out',
      );
    };
    const e = event('CHECKOUT.ORDER.APPROVED', { id: s.orderId });
    try {
      expect((await deliver(e)).status).toBe(500);
    } finally {
      paypal.getOrder = original;
    }
    const saved = await stored(e.id);
    expect(saved).toMatchObject({ processedAt: null, attempts: 1 });
    expect(saved!.error).toMatch(/PayPal did not respond|timed out|could not complete/i);

    await db().webhookEvent.update({
      where: { id: saved!.id },
      data: { receivedAt: new Date(Date.now() - 5 * 60_000) },
    });
    await reprocessWebhookEvents(deps());
    expect((await stored(e.id))!.processedAt).not.toBeNull();
    expect((await row(s.id)).status).toBe('CAPTURED');
  });
});
