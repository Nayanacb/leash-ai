import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderRoutes, SESSION } from '../../test/render';
import { ApprovalsPage } from './ApprovalsPage';

const ID = '0196a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const APPROVAL_ID = '0196a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60';
const HASH = 'a'.repeat(64);
const XSS = '<img src=x onerror="window.__pwned=1">';

const SUMMARY = {
  id: ID,
  status: 'PENDING_APPROVAL',
  decision: 'ESCALATE',
  amountMinor: 1899,
  currency: 'USD',
  itemDescription: XSS,
  agent: { id: ID, name: 'Buyer bot' },
  merchant: { id: ID, displayName: 'Cable Co' },
  taskId: ID,
  reasonCodes: ['NEW_MERCHANT'],
  createdAt: '2026-11-09T10:00:00.000Z',
};

const APPROVAL = {
  id: APPROVAL_ID,
  status: 'PENDING',
  requestedAt: '2026-11-09T10:00:01.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  decidedAt: null,
  note: null,
  snapshotHash: HASH,
  payee: 'pay@cable.example',
  transaction: SUMMARY,
};

const DETAIL = {
  ...SUMMARY,
  status: 'AUTHORIZED',
  quantity: 1,
  category: null,
  agentJustification: null,
  sourceContext: [],
  task: { id: ID, instruction: 'Buy a cable', budgetMinor: 4000, currency: 'USD' },
  merchantDetail: null,
  policyVersion: 1,
  evaluations: [],
  approval: { ...APPROVAL, status: 'APPROVED', payee: undefined, transaction: undefined },
  authorizedAt: '2026-11-09T10:05:00.000Z',
  authorizationExpiresAt: '2026-11-09T10:35:00.000Z',
  ledger: [],
  heldMinor: 1899,
  payment: {
    payee: 'pay@cable.example',
    paypalOrderId: null,
    orderCreatedAt: null,
    paypalCaptureId: null,
    capturedMinor: null,
    capturedAt: null,
    failureReason: null,
    refundedMinor: 0,
    refundableMinor: 0,
  },
  refunds: [],
  audit: [],
  updatedAt: '2026-11-09T10:05:00.000Z',
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A tiny fake backend: routes by method + path and records every call. */
function fakeServer(opts: {
  steppedUp?: boolean;
  approveError?: { status: number; code: string };
}) {
  const calls: Call[] = [];
  let stepUpExpiresAt = opts.steppedUp ? '2099-01-01T00:00:00.000Z' : null;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (url.startsWith('/api/v1/auth/session'))
        return Promise.resolve(jsonResponse(200, { ...SESSION, stepUpExpiresAt }));
      if (url.startsWith('/api/v1/approvals?'))
        return Promise.resolve(jsonResponse(200, { approvals: [APPROVAL], pendingCount: 1 }));
      if (url === '/api/v1/auth/step-up') {
        if ((body as { password: string }).password !== 'correct horse')
          return Promise.resolve(
            jsonResponse(401, {
              error: { code: 'INVALID_PASSWORD', message: 'Password is incorrect' },
            }),
          );
        stepUpExpiresAt = '2099-01-01T00:00:00.000Z';
        return Promise.resolve(jsonResponse(200, { stepUpExpiresAt }));
      }
      if (url.endsWith('/approve')) {
        if (opts.approveError)
          return Promise.resolve(
            jsonResponse(opts.approveError.status, {
              error: { code: opts.approveError.code, message: `failed: ${opts.approveError.code}` },
            }),
          );
        return Promise.resolve(jsonResponse(200, DETAIL));
      }
      if (url.endsWith('/reject'))
        return Promise.resolve(jsonResponse(200, { ...DETAIL, status: 'REJECTED' }));
      return Promise.resolve(jsonResponse(404, { error: { code: 'NOT_FOUND', message: url } }));
    }),
  );
  return calls;
}

function renderPage() {
  return renderRoutes([{ path: '/approvals', element: <ApprovalsPage /> }], '/approvals');
}

afterEach(() => vi.unstubAllGlobals());

describe('ApprovalsPage', () => {
  it('lists pending approvals with payee, amount and inert agent text', async () => {
    fakeServer({});
    const { container } = renderPage();
    expect(await screen.findByText('18.99 USD')).toBeInTheDocument();
    expect(screen.getByText('pay@cable.example')).toBeInTheDocument();
    expect(screen.getByText(XSS)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Waiting (1)' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('asks for the password before approving and sends the snapshot hash that was shown', async () => {
    const calls = fakeServer({ steppedUp: false });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const confirm = await screen.findByRole('dialog', { name: 'Approve this purchase?' });
    expect(within(confirm).getByText('pay@cable.example')).toBeInTheDocument();
    fireEvent.change(within(confirm).getByLabelText('Note (optional)'), {
      target: { value: '  ok for the office  ' },
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve purchase' }));

    const stepUp = await screen.findByRole('dialog', { name: "Confirm it's you" });
    expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(false);

    fireEvent.change(within(stepUp).getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(within(stepUp).getByRole('button', { name: 'Confirm and approve' }));
    expect(await within(stepUp).findByText('Password is incorrect')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(false);

    fireEvent.change(within(stepUp).getByLabelText('Password'), {
      target: { value: 'correct horse' },
    });
    fireEvent.click(within(stepUp).getByRole('button', { name: 'Confirm and approve' }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(true));
    const approve = calls.find((c) => c.url.endsWith('/approve'))!;
    expect(approve).toMatchObject({
      method: 'POST',
      url: `/api/v1/approvals/${APPROVAL_ID}/approve`,
      body: { snapshotHash: HASH, note: 'ok for the office' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('skips the password prompt while the step-up window is open', async () => {
    const calls = fakeServer({ steppedUp: true });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const confirm = await screen.findByRole('dialog', { name: 'Approve this purchase?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve purchase' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(true));
    expect(calls.some((c) => c.url === '/api/v1/auth/step-up')).toBe(false);
    expect(screen.queryByRole('dialog', { name: "Confirm it's you" })).toBeNull();
  });

  it('falls back to the password prompt when the server says the step-up lapsed', async () => {
    fakeServer({ steppedUp: true, approveError: { status: 403, code: 'STEP_UP_REQUIRED' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const confirm = await screen.findByRole('dialog', { name: 'Approve this purchase?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve purchase' }));
    expect(await screen.findByRole('dialog', { name: "Confirm it's you" })).toBeInTheDocument();
  });

  it('shows why an approval was refused (for example, the purchase changed)', async () => {
    fakeServer({ steppedUp: true, approveError: { status: 409, code: 'SNAPSHOT_STALE' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const confirm = await screen.findByRole('dialog', { name: 'Approve this purchase?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve purchase' }));
    expect(await within(confirm).findByText('failed: SNAPSHOT_STALE')).toBeInTheDocument();
  });

  it('rejects without a password and sends the optional reason', async () => {
    const calls = fakeServer({ steppedUp: false });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject this purchase?' });
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), {
      target: { value: 'Wrong cable' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject purchase' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/reject'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/reject'))).toMatchObject({
      method: 'POST',
      body: { note: 'Wrong cable' },
    });
    expect(calls.some((c) => c.url === '/api/v1/auth/step-up')).toBe(false);
  });

  it('switches tabs to load past decisions', async () => {
    const calls = fakeServer({});
    renderPage();
    await screen.findByText('18.99 USD');
    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/approvals?status=APPROVED')).toBe(true),
    );
    expect(screen.getByRole('tab', { name: 'Approved' })).toHaveAttribute('aria-selected', 'true');
  });
});
