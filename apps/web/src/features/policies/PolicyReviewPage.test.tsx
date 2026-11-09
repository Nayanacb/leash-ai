import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api/client';
import { jsonResponse, renderRoutes } from '../../test/render';
import { PolicyReviewPage } from './PolicyReviewPage';

const ID = '0196a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const DRAFT = {
  id: ID,
  version: 3,
  status: 'DRAFT',
  sourceText: 'Never spend more than $50 on one purchase. Prefer eco brands.',
  compiledRules: {
    dslVersion: 1,
    currency: 'USD',
    timezone: 'UTC',
    rules: [{ id: 'cap', type: 'max_amount_per_transaction', amountMinor: 5000, action: 'BLOCK' }],
  },
  rulesHash: 'a'.repeat(64),
  rendered: [{ id: 'cap', action: 'BLOCK', text: 'Block any single purchase over 50.00 USD.' }],
  builtInRules: [
    'Block any single purchase over 500.00 USD (sandbox ceiling; cannot be changed by a policy).',
  ],
  unmappedClauses: [{ text: 'Prefer eco brands', reason: 'Not a spending rule' }],
  assumptions: [],
  compilerModel: 'test-model',
  promptVersion: 'policy-compiler/v1',
  editedManually: false,
  confirmedAt: null,
  createdAt: '2026-11-09T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

function stubApi() {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === `/api/v1/policies/versions/${ID}/confirm`) {
        return Promise.resolve(
          jsonResponse(200, {
            ...DRAFT,
            status: 'ACTIVE',
            confirmedAt: '2026-11-09T11:00:00.000Z',
          }),
        );
      }
      if (url === `/api/v1/policies/versions/${ID}`)
        return Promise.resolve(jsonResponse(200, DRAFT));
      if (url.startsWith('/api/v1/tasks')) return Promise.resolve(jsonResponse(200, { tasks: [] }));
      return Promise.resolve(jsonResponse(200, {}));
    }),
  );
  return calls;
}

const routes = [
  { path: '/policies/versions/:id', element: <PolicyReviewPage /> },
  { path: '/policies', element: <p>Policies list</p> },
];

describe('PolicyReviewPage', () => {
  it('shows the deterministic rendering and what will not be enforced', async () => {
    stubApi();
    renderRoutes(routes, `/policies/versions/${ID}`);
    expect(
      await screen.findByText('Block any single purchase over 50.00 USD.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Not enforced/)).toBeInTheDocument();
    expect(screen.getByText('“Prefer eco brands”')).toBeInTheDocument();
  });

  it('requires acknowledging unmapped clauses, then confirms the exact reviewed hash with the password', async () => {
    const calls = stubApi();
    renderRoutes(routes, `/policies/versions/${ID}`);
    const confirmButton = await screen.findByRole('button', { name: 'Confirm and enforce' });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/I understand these will not be enforced/));
    fireEvent.click(confirmButton);
    fireEvent.change(await screen.findByLabelText('Confirm with your password'), {
      target: { value: 'my passphrase' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm and enforce' }).at(-1)!);

    await waitFor(() => expect(screen.getByText('Policies list')).toBeInTheDocument());
    const call = calls.find((c) => c.url.endsWith('/confirm'))!;
    expect(JSON.parse(String(call.init!.body))).toEqual({
      rulesHash: DRAFT.rulesHash,
      acknowledgeUnmapped: true,
      password: 'my passphrase',
    });
  });
});
