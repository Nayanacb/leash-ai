import { describe, expect, it, vi } from 'vitest';
import { PayPalClient } from '../../src/modules/payments/paypal/client.js';
import {
  assertSandboxApproveUrl,
  buildOrderBody,
  parseOrder,
  PayPalCheckoutProvider,
} from '../../src/modules/payments/paypal/checkout.js';
import { PaymentProviderError, type OrderView } from '../../src/modules/payments/provider.js';
import { captureOutcome, orderMismatches } from '../../src/modules/payments/verify.js';
import { readTransmission, summarizeEvent } from '../../src/modules/payments/webhooks.js';

const TX = '0196a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const EXPECTED = {
  orderId: 'ORDER12345',
  transactionId: TX,
  amountMinor: 1250,
  currency: 'USD' as const,
  payeeEmail: 'pay@paper.example.test',
};

function order(
  overrides: Partial<OrderView['purchaseUnits'][number]> = {},
  o: Partial<OrderView> = {},
): OrderView {
  return {
    id: 'ORDER12345',
    status: 'APPROVED',
    approveUrl: null,
    purchaseUnits: [
      {
        amountValue: '12.50',
        currency: 'USD',
        payeeEmail: 'Pay@Paper.example.test',
        payeeMerchantId: 'MERCH1',
        refunds: [],
        customId: TX,
        invoiceId: TX,
        captures: [],
        ...overrides,
      },
    ],
    ...o,
  };
}

describe('orderMismatches', () => {
  it('accepts an exact match (payee compared case-insensitively)', () => {
    expect(orderMismatches(order(), EXPECTED)).toEqual([]);
  });

  it.each([
    ['amount', { amountValue: '12.51' }],
    ['amount', { amountValue: '12.5000' }],
    ['amount', { amountValue: '-12.50' }],
    ['currency', { currency: 'EUR' }],
    ['payee', { payeeEmail: 'attacker@evil.example.test' }],
    ['payee', { payeeEmail: null }],
    ['custom_id', { customId: 'someone-else' }],
    ['invoice_id', { invoiceId: null }],
  ])('flags a tampered %s', (field, overrides) => {
    expect(orderMismatches(order(overrides), EXPECTED)).toContain(field);
  });

  it('flags a different order and extra purchase units', () => {
    expect(orderMismatches(order({}, { id: 'OTHER99999' }), EXPECTED)).toContain('order id');
    const two = order();
    two.purchaseUnits.push(two.purchaseUnits[0]!);
    expect(orderMismatches(two, EXPECTED)[0]).toMatch(/purchase unit/);
  });
});

describe('captureOutcome', () => {
  const cap = (status: string, value = '12.50', currency = 'USD') =>
    order({ captures: [{ id: 'CAP1', status, amountValue: value, currency }] });

  it('reads completed, pending and declined captures', () => {
    expect(captureOutcome(order(), EXPECTED)).toEqual({ kind: 'none' });
    expect(captureOutcome(cap('COMPLETED'), EXPECTED)).toEqual({
      kind: 'completed',
      captureId: 'CAP1',
      amountMinor: 1250,
      exact: true,
    });
    expect(captureOutcome(cap('PENDING'), EXPECTED)).toEqual({
      kind: 'pending',
      captureId: 'CAP1',
    });
    expect(captureOutcome(cap('DECLINED'), EXPECTED)).toMatchObject({ kind: 'declined' });
    expect(captureOutcome(cap('FAILED'), EXPECTED)).toMatchObject({ kind: 'declined' });
  });

  it('marks a capture of the wrong amount as inexact, and unknown states as anomalies', () => {
    expect(captureOutcome(cap('COMPLETED', '99.00'), EXPECTED)).toMatchObject({
      kind: 'completed',
      exact: false,
      amountMinor: 9900,
    });
    expect(captureOutcome(cap('WEIRD'), EXPECTED)).toMatchObject({ kind: 'anomaly' });
    const twice = cap('COMPLETED');
    twice.purchaseUnits[0]!.captures.push({ ...twice.purchaseUnits[0]!.captures[0]!, id: 'CAP2' });
    expect(captureOutcome(twice, EXPECTED)).toMatchObject({ kind: 'anomaly' });
  });
});

describe('buildOrderBody', () => {
  it('builds the order only from the stored purchase, with a printable, bounded description', () => {
    const body = buildOrderBody({
      transactionId: TX,
      amountMinor: 1899,
      currency: 'USD',
      payeeEmail: 'pay@cable.example.test',
      description: 'Cable\u0000\n<b>2 m</b>' + 'x'.repeat(300),
      returnUrl: 'http://localhost:5173/transactions/x/paypal-return',
      cancelUrl: 'http://localhost:5173/transactions/x?paypal=cancelled',
    });
    const unit = body.purchase_units[0]!;
    expect(body.intent).toBe('CAPTURE');
    expect(unit).toMatchObject({
      custom_id: TX,
      invoice_id: TX,
      reference_id: TX,
      amount: { currency_code: 'USD', value: '18.99' },
      payee: { email_address: 'pay@cable.example.test' },
    });
    expect(unit.description.length).toBeLessThanOrEqual(127);
    // eslint-disable-next-line no-control-regex
    expect(unit.description).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('parseOrder', () => {
  const raw = (href: string) => ({
    id: 'ORDER12345',
    status: 'PAYER_ACTION_REQUIRED',
    purchase_units: [
      {
        amount: { currency_code: 'USD', value: '12.50' },
        payee: { email_address: 'pay@paper.example.test', merchant_id: 'M1' },
        custom_id: TX,
        invoice_id: TX,
      },
    ],
    links: [{ rel: 'payer-action', href }],
  });

  it('keeps only sandbox approval links', () => {
    const ok = 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345';
    expect(parseOrder(raw(ok)).approveUrl).toBe(ok);
    expect(parseOrder(raw('https://www.paypal.com/checkoutnow?token=X')).approveUrl).toBeNull();
    expect(parseOrder(raw('https://evil.example/checkoutnow')).approveUrl).toBeNull();
    expect(parseOrder(raw('http://www.sandbox.paypal.com/x')).approveUrl).toBeNull();
    expect(() => assertSandboxApproveUrl('https://www.paypal.com/x')).toThrow(PaymentProviderError);
  });

  it('treats an unexpected response as an unknown outcome', () => {
    expect(() => parseOrder({ nope: true })).toThrow(
      expect.objectContaining({ kind: 'ambiguous' }),
    );
  });
});

// ── PayPal HTTP client (fake fetch; nothing leaves the process) ─────────────

const SECRET = 'sandbox-secret-value-123';

function fakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const token = (value = 'access-token-abc', expires = 3600) =>
  json(200, { access_token: value, expires_in: expires, token_type: 'Bearer' });

describe('PayPalClient', () => {
  it('authenticates against the sandbox only, caches the token, and sends idempotency keys', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.pathname === '/v1/oauth2/token' ? token() : json(201, { id: 'ORDER12345' }),
    );
    const client = new PayPalClient({ clientId: 'cid', clientSecret: SECRET, fetch });
    await client.request('POST', '/v2/checkout/orders', {
      body: { a: 1 },
      requestId: 'leash-order-1',
    });
    await client.request('GET', '/v2/checkout/orders/ORDER12345');

    expect(calls.map((c) => `${c.url.host}${c.url.pathname}`)).toEqual([
      'api-m.sandbox.paypal.com/v1/oauth2/token',
      'api-m.sandbox.paypal.com/v2/checkout/orders',
      'api-m.sandbox.paypal.com/v2/checkout/orders/ORDER12345',
    ]);
    const auth = (calls[0]!.init.headers as Record<string, string>).Authorization!;
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe(`cid:${SECRET}`);
    const create = calls[1]!.init.headers as Record<string, string>;
    expect(create.Authorization).toBe('Bearer access-token-abc');
    expect(create['PayPal-Request-Id']).toBe('leash-order-1');
    expect(calls[1]!.init.redirect).toBe('error');
  });

  it('refreshes an expired or rejected token once', async () => {
    let now = 0;
    let apiCalls = 0;
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1/oauth2/token') return token(`t${calls.length}`, 120);
      apiCalls++;
      return apiCalls === 2 ? json(401, { name: 'AUTHENTICATION_FAILURE' }) : json(200, {});
    });
    const client = new PayPalClient({ clientId: 'c', clientSecret: SECRET, fetch, now: () => now });
    await client.request('GET', '/v2/checkout/orders/A1234567');
    await client.request('GET', '/v2/checkout/orders/A1234567'); // 401 → new token → retry
    now = 61_000; // past (120 − 60) s: refreshed proactively
    await client.request('GET', '/v2/checkout/orders/A1234567');
    expect(calls.filter((c) => c.url.pathname === '/v1/oauth2/token')).toHaveLength(3);
  });

  it('classifies failures and never puts credentials or tokens in errors', async () => {
    const cases: [Response | Error, string, string][] = [
      [
        json(422, {
          name: 'UNPROCESSABLE_ENTITY',
          details: [{ issue: 'INSTRUMENT_DECLINED' }],
          debug_id: 'dbg1',
        }),
        'rejected',
        'INSTRUMENT_DECLINED',
      ],
      [json(404, { name: 'RESOURCE_NOT_FOUND' }), 'not_found', 'RESOURCE_NOT_FOUND'],
      [json(503, { name: 'SERVICE_UNAVAILABLE' }), 'ambiguous', 'SERVICE_UNAVAILABLE'],
      [new TypeError('fetch failed'), 'ambiguous', 'NETWORK_ERROR'],
    ];
    for (const [outcome, kind, code] of cases) {
      const { fetch } = fakeFetch((url) => {
        if (url.pathname === '/v1/oauth2/token') return token('tok-SECRET-ish');
        if (outcome instanceof Error) throw outcome;
        return outcome.clone();
      });
      const client = new PayPalClient({ clientId: 'cid', clientSecret: SECRET, fetch });
      const err = await client
        .request('POST', '/v2/checkout/orders/A1234567/capture')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PaymentProviderError);
      expect(err).toMatchObject({ kind, code });
      expect(String((err as Error).message)).not.toContain(SECRET);
      expect(String((err as Error).message)).not.toContain('tok-SECRET-ish');
    }
  });

  it('reports bad credentials as an auth failure without echoing them', async () => {
    const { fetch } = fakeFetch(() => json(401, { error: 'invalid_client' }));
    const client = new PayPalClient({ clientId: 'cid', clientSecret: SECRET, fetch });
    const err = await client
      .request('GET', '/v2/checkout/orders/A1234567')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'auth', code: 'invalid_client' });
    expect(String((err as Error).message)).not.toContain(SECRET);
  });

  it('refuses order IDs that could alter the request path', async () => {
    const { fetch, calls } = fakeFetch(() => token());
    const provider = new PayPalCheckoutProvider(
      new PayPalClient({ clientId: 'c', clientSecret: SECRET, fetch }),
    );
    await expect(provider.getOrder('../v1/oauth2/token')).rejects.toMatchObject({
      kind: 'not_found',
    });
    await expect(provider.captureOrder('A1234567?x=1', 'k')).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('refunds, captures and webhook verification (PayPal provider)', () => {
  const provider = (handler: (url: URL, init: RequestInit) => Response) => {
    const f = fakeFetch((url, init) =>
      url.pathname === '/v1/oauth2/token' ? token() : handler(url, init),
    );
    return {
      calls: f.calls,
      provider: new PayPalCheckoutProvider(
        new PayPalClient({ clientId: 'c', clientSecret: SECRET, fetch: f.fetch }),
      ),
    };
  };
  const refundBody = {
    id: 'REFUND12345',
    status: 'COMPLETED',
    amount: { currency_code: 'USD', value: '5.00' },
    invoice_id: TX,
    links: [
      { rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP12345678' },
    ],
  };

  it('refunds with a stable request ID, the amount as a decimal and a printable note', async () => {
    const { provider: p, calls } = provider(() => json(201, refundBody));
    const view = await p.refundCapture(
      'CAP12345678',
      { amountMinor: 500, currency: 'USD', invoiceId: TX, note: 'Wrong\u0000 size\n' },
      'leash-refund-1',
    );
    expect(view).toEqual({
      id: 'REFUND12345',
      status: 'COMPLETED',
      amountValue: '5.00',
      currency: 'USD',
      invoiceId: TX,
      captureId: 'CAP12345678',
    });
    const call = calls.find((c) => c.url.pathname.endsWith('/refund'))!;
    expect(call.url.pathname).toBe('/v2/payments/captures/CAP12345678/refund');
    expect((call.init.headers as Record<string, string>)['PayPal-Request-Id']).toBe(
      'leash-refund-1',
    );
    expect(JSON.parse(call.init.body as string)).toEqual({
      amount: { currency_code: 'USD', value: '5.00' },
      invoice_id: TX,
      note_to_payer: 'Wrong size',
    });
  });

  it('reads refunds and captures, and refuses IDs that could alter the path', async () => {
    const { provider: p } = provider((url) =>
      url.pathname.startsWith('/v2/payments/refunds/')
        ? json(200, refundBody)
        : json(200, {
            id: 'CAP12345678',
            status: 'REVERSED',
            amount: { currency_code: 'USD', value: '18.99' },
            supplementary_data: { related_ids: { order_id: 'ORDER12345' } },
          }),
    );
    expect((await p.getRefund('REFUND12345')).captureId).toBe('CAP12345678');
    expect(await p.getCapture('CAP12345678')).toMatchObject({
      status: 'REVERSED',
      orderId: 'ORDER12345',
    });
    await expect(p.getRefund('../../v1/x')).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('parses refunds listed on an order', () => {
    const o = parseOrder({
      id: 'ORDER12345',
      status: 'COMPLETED',
      purchase_units: [
        {
          amount: { currency_code: 'USD', value: '18.99' },
          payments: { captures: [], refunds: [refundBody] },
        },
      ],
    });
    expect(o.purchaseUnits[0]!.refunds).toEqual([
      expect.objectContaining({ id: 'REFUND12345', invoiceId: TX }),
    ]);
  });

  const transmission = {
    authAlgo: 'SHA256withRSA',
    certUrl: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    transmissionId: 't-1',
    transmissionSig: 'sig==',
    transmissionTime: '2026-11-10T10:00:00Z',
  };

  it('verifies a webhook by sending the event to PayPal byte for byte', async () => {
    // Deliberately unusual formatting: re-serializing would change it.
    const raw = '{"id":"WH-1",  "event_type":"X","resource":{"amount":1.10,"n":"\\u00e9"}}';
    const { provider: p, calls } = provider(() => json(200, { verification_status: 'SUCCESS' }));
    expect(await p.verifyWebhookSignature(transmission, 'WEBHOOK-ID', raw)).toBe(true);
    const sent = calls.find(
      (c) => c.url.pathname === '/v1/notifications/verify-webhook-signature',
    )!;
    const body = sent.init.body as string;
    expect(body.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(body)).toMatchObject({
      webhook_id: 'WEBHOOK-ID',
      transmission_id: 't-1',
      cert_url: transmission.certUrl,
    });
  });

  it('rejects failed verifications and bodies that are not a single JSON object', async () => {
    const { provider: p, calls } = provider(() => json(200, { verification_status: 'FAILURE' }));
    expect(await p.verifyWebhookSignature(transmission, 'W', '{"id":"x"}')).toBe(false);
    const before = calls.length;
    for (const raw of ['', 'not json', '[1]', '1,"webhook_id":"other"', 'null']) {
      expect(await p.verifyWebhookSignature(transmission, 'W', raw)).toBe(false);
    }
    expect(calls.length).toBe(before); // never sent to PayPal
  });
});

describe('webhook transmission checks and summaries', () => {
  const now = new Date('2026-11-10T10:00:00Z');
  const headers: Record<string, string> = {
    'paypal-transmission-id': 'abc-123',
    'paypal-transmission-time': '2026-11-10T09:55:00Z',
    'paypal-transmission-sig': 'c2lnbmF0dXJl==',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    'paypal-auth-algo': 'SHA256withRSA',
  };
  const read = (overrides: Record<string, string | undefined>) =>
    readTransmission((n) => ({ ...headers, ...overrides })[n], now);

  it('accepts a well-formed sandbox delivery inside the time window', () => {
    expect(read({})).toMatchObject({ ok: true, transmission: { transmissionId: 'abc-123' } });
  });

  it.each([
    ['MISSING_HEADERS', { 'paypal-transmission-sig': undefined }],
    ['MISSING_HEADERS', { 'paypal-auth-algo': 'SHA256 withRSA' }],
    ['BAD_CERT_URL', { 'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/C' }],
    ['BAD_CERT_URL', { 'paypal-cert-url': 'http://api.sandbox.paypal.com/certs/C' }],
    ['BAD_CERT_URL', { 'paypal-cert-url': 'https://api.sandbox.paypal.com.evil.example/C' }],
    ['STALE_TRANSMISSION', { 'paypal-transmission-time': '2026-11-10T09:40:00Z' }],
    ['STALE_TRANSMISSION', { 'paypal-transmission-time': 'yesterday' }],
  ])('rejects %s', (reason, overrides) => {
    expect(read(overrides)).toEqual({ ok: false, reason });
  });

  it('keeps identifiers, status and amount — never payer details', () => {
    const summary = summarizeEvent({
      id: 'WH-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP1',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '18.99' },
        supplementary_data: { related_ids: { order_id: 'ORDER1' } },
        payer: { email_address: 'buyer@example.test' },
        payee: { email_address: 'merchant@example.test' },
      },
    });
    expect(summary).toEqual({
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceType: null,
      resourceId: 'CAP1',
      status: 'COMPLETED',
      amount: { currency: 'USD', value: '18.99' },
      orderId: 'ORDER1',
      createTime: null,
    });
  });
});
