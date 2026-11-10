import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderRoutes } from '../../test/render';
import { TransactionDetailPage } from '../transactions/TransactionDetailPage';
import { PayPalReturnPage } from './PayPalReturnPage';

vi.mock('../../lib/navigation', () => ({ leaveForExternalPage: vi.fn() }));
const { leaveForExternalPage } = await import('../../lib/navigation');

const ID = '0196a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const APPROVE_URL = 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345';

const PAYMENT = {
  payee: 'pay@cable.example.test',
  paypalOrderId: null,
  orderCreatedAt: null,
  paypalCaptureId: null,
  capturedMinor: null,
  capturedAt: null,
  failureReason: null,
  refundedMinor: 0,
  refundableMinor: 0,
};

const detail = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  status: 'AUTHORIZED',
  decision: 'ALLOW',
  amountMinor: 1899,
  currency: 'USD',
  itemDescription: 'USB-C cable',
  agent: { id: ID, name: 'Buyer bot' },
  merchant: { id: ID, displayName: 'Cable Co' },
  taskId: ID,
  reasonCodes: [],
  createdAt: '2026-11-09T10:00:00.000Z',
  quantity: 1,
  category: null,
  agentJustification: null,
  sourceContext: [],
  task: { id: ID, instruction: 'Buy a cable', budgetMinor: 4000, currency: 'USD' },
  merchantDetail: null,
  policyVersion: 1,
  evaluations: [],
  approval: null,
  authorizedAt: '2026-11-09T10:00:00.000Z',
  authorizationExpiresAt: '2099-01-01T00:00:00.000Z',
  ledger: [],
  heldMinor: 1899,
  payment: PAYMENT,
  refunds: [],
  audit: [],
  updatedAt: '2026-11-09T10:00:00.000Z',
  ...overrides,
});

function server(routes: Record<string, () => Response>) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      const handler = routes[`${method} ${url}`];
      return Promise.resolve(
        handler ? handler() : jsonResponse(404, { error: { code: 'NOT_FOUND', message: url } }),
      );
    }),
  );
  return calls;
}

const detailRoutes = [
  { path: '/transactions/:id', element: <TransactionDetailPage /> },
  { path: '/transactions/:id/paypal-return', element: <PayPalReturnPage /> },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(leaveForExternalPage).mockClear();
});

describe('payment panel', () => {
  it('starts checkout and sends the user (never the agent) to the PayPal sandbox link', async () => {
    const calls = server({
      [`GET /api/v1/transactions/${ID}`]: () => jsonResponse(200, detail()),
      [`POST /api/v1/transactions/${ID}/checkout`]: () =>
        jsonResponse(200, { status: 'REDIRECT', approveUrl: APPROVE_URL }),
    });
    renderRoutes(detailRoutes, `/transactions/${ID}`);
    expect(await screen.findByText('Ready to pay')).toBeInTheDocument();
    expect(screen.getByText('pay@cable.example.test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pay with PayPal (sandbox)' }));
    await waitFor(() => expect(leaveForExternalPage).toHaveBeenCalledWith(APPROVE_URL));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('goes straight to completion when the buyer already approved', async () => {
    const calls = server({
      [`GET /api/v1/transactions/${ID}`]: () =>
        jsonResponse(200, detail({ status: 'ORDER_CREATED' })),
      [`POST /api/v1/transactions/${ID}/checkout`]: () => jsonResponse(200, { status: 'APPROVED' }),
      [`POST /api/v1/transactions/${ID}/checkout/complete`]: () =>
        jsonResponse(
          200,
          detail({ status: 'CAPTURED', payment: { ...PAYMENT, capturedMinor: 1899 } }),
        ),
    });
    renderRoutes(detailRoutes, `/transactions/${ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to PayPal (sandbox)' }));
    expect(await screen.findByText(/Payment complete/)).toBeInTheDocument();
    expect(leaveForExternalPage).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.endsWith('/checkout/complete'))).toBe(true);
  });

  it('explains a cancelled PayPal visit', async () => {
    server({
      [`GET /api/v1/transactions/${ID}`]: () =>
        jsonResponse(200, detail({ status: 'ORDER_CREATED' })),
    });
    renderRoutes(detailRoutes, `/transactions/${ID}?paypal=cancelled`);
    expect(await screen.findByText(/You left PayPal without paying/)).toBeInTheDocument();
  });

  it('shows the capture, a pending capture, and a failure with its reason', async () => {
    server({
      [`GET /api/v1/transactions/${ID}`]: () =>
        jsonResponse(
          200,
          detail({
            status: 'CAPTURED',
            payment: {
              ...PAYMENT,
              paypalOrderId: 'ORDER12345',
              paypalCaptureId: 'CAP777',
              capturedMinor: 1899,
              capturedAt: '2026-11-09T10:05:00.000Z',
            },
          }),
        ),
    });
    const { unmount } = renderRoutes(detailRoutes, `/transactions/${ID}`);
    expect(await screen.findByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('CAP777')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /PayPal/ })).toBeNull();
    unmount();

    server({
      [`GET /api/v1/transactions/${ID}`]: () => jsonResponse(200, detail({ status: 'CAPTURING' })),
    });
    const second = renderRoutes(detailRoutes, `/transactions/${ID}`);
    expect(await screen.findByText('Payment being confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel purchase' })).toBeNull();
    second.unmount();

    server({
      [`GET /api/v1/transactions/${ID}`]: () =>
        jsonResponse(
          200,
          detail({
            status: 'PAYMENT_FAILED',
            payment: { ...PAYMENT, failureReason: 'ORDER_MISMATCH' },
          }),
        ),
    });
    renderRoutes(detailRoutes, `/transactions/${ID}`);
    expect(await screen.findByText(/did not match what Leash authorized/)).toBeInTheDocument();
  });
});

describe('PayPal return page', () => {
  it('asks the server to verify and capture exactly once, ignoring the redirect parameters', async () => {
    const calls = server({
      [`POST /api/v1/transactions/${ID}/checkout/complete`]: () =>
        jsonResponse(
          200,
          detail({ status: 'CAPTURED', payment: { ...PAYMENT, capturedMinor: 1899 } }),
        ),
    });
    renderRoutes(detailRoutes, `/transactions/${ID}/paypal-return?token=OTHERORDER&PayerID=X`);
    expect(await screen.findByText(/Payment complete: 18.99 USD captured/)).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toEqual([
      { url: `/api/v1/transactions/${ID}/checkout/complete`, method: 'POST' },
    ]);
  });

  it('shows why the payment was refused', async () => {
    server({
      [`POST /api/v1/transactions/${ID}/checkout/complete`]: () =>
        jsonResponse(409, {
          error: { code: 'ORDER_MISMATCH', message: 'The PayPal order does not match' },
        }),
    });
    renderRoutes(detailRoutes, `/transactions/${ID}/paypal-return`);
    expect(await screen.findByText('The PayPal order does not match')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the purchase' })).toHaveAttribute(
      'href',
      `/transactions/${ID}`,
    );
  });
});

describe('refunds', () => {
  const paid = (overrides: Record<string, unknown> = {}) =>
    detail({
      status: 'CAPTURED',
      payment: {
        ...PAYMENT,
        paypalOrderId: 'ORDER12345',
        paypalCaptureId: 'CAP777',
        capturedMinor: 1899,
        refundableMinor: 1899,
      },
      ...overrides,
    });

  it('refunds with one idempotency key per dialog and the chosen amount', async () => {
    const sent: { headers: Record<string, string>; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST' && url.endsWith('/refunds')) {
          sent.push({
            headers: init.headers as Record<string, string>,
            body: JSON.parse(init.body as string),
          });
          return Promise.resolve(
            jsonResponse(
              200,
              paid({
                status: 'PARTIALLY_REFUNDED',
                payment: {
                  ...PAYMENT,
                  capturedMinor: 1899,
                  refundedMinor: 500,
                  refundableMinor: 1399,
                },
              }),
            ),
          );
        }
        return Promise.resolve(jsonResponse(200, paid()));
      }),
    );
    renderRoutes(detailRoutes, `/transactions/${ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Refund…' }));
    const amount = await screen.findByLabelText('Amount (USD)');
    expect(amount).toHaveValue('18.99');
    fireEvent.change(amount, { target: { value: '5.00' } });
    fireEvent.change(screen.getByLabelText('Reason (optional, shown to the buyer)'), {
      target: { value: 'Too long' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({
      amount: { currency: 'USD', value: '5.00' },
      reason: 'Too long',
    });
    expect(sent[0]!.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('lists refunds (including ones made outside Leash) and explains a reversal', async () => {
    const refunds = [
      {
        id: ID,
        amountMinor: 500,
        currency: 'USD',
        status: 'COMPLETED',
        source: 'PAYPAL',
        reason: 'Refunded outside Leash (PayPal)',
        failureReason: null,
        createdAt: '2026-11-09T11:00:00.000Z',
        completedAt: '2026-11-09T11:00:00.000Z',
      },
    ];
    server({
      [`GET /api/v1/transactions/${ID}`]: () =>
        jsonResponse(
          200,
          paid({
            status: 'REVERSED',
            refunds,
            payment: { ...PAYMENT, capturedMinor: 1899, refundedMinor: 1899, refundableMinor: 0 },
          }),
        ),
    });
    renderRoutes(detailRoutes, `/transactions/${ID}`);
    expect(await screen.findByText('Payment reversed by PayPal')).toBeInTheDocument();
    expect(screen.getByText('outside Leash (PayPal)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refund…' })).toBeNull();
  });
});
