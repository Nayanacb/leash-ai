import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderRoutes } from '../../test/render';
import { NewPolicyPanel } from './NewPolicyPanel';

const DRAFT_ID = '0196a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

afterEach(() => vi.unstubAllGlobals());

function stubApi(configured: boolean) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/v1/policies/compiler-status')
        return Promise.resolve(jsonResponse(200, { configured }));
      if (url.startsWith('/api/v1/merchants'))
        return Promise.resolve(jsonResponse(200, { merchants: [] }));
      if (url === '/api/v1/policies/drafts') {
        const body = JSON.parse(String(init!.body));
        return Promise.resolve(
          jsonResponse(201, {
            id: DRAFT_ID,
            version: 1,
            status: 'DRAFT',
            sourceText: 'Written directly as policy JSON.',
            compiledRules: body.compiledRules,
            rulesHash: 'b'.repeat(64),
            rendered: [],
            builtInRules: [],
            unmappedClauses: [],
            assumptions: [],
            compilerModel: 'none (written as JSON)',
            promptVersion: 'n/a',
            editedManually: true,
            confirmedAt: null,
            createdAt: '2026-11-09T10:00:00.000Z',
            updatedAt: '2026-11-09T10:00:00.000Z',
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x' } }));
    }),
  );
  return calls;
}

const routes = [
  { path: '/', element: <NewPolicyPanel /> },
  { path: '/policies/versions/:id', element: <p>Review page</p> },
];

describe('NewPolicyPanel', () => {
  it('defaults to the JSON tab when translation is not configured, and creates a draft from JSON', async () => {
    const calls = stubApi(false);
    renderRoutes(routes, '/');
    expect(await screen.findByLabelText('Policy JSON')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Create draft for review' }));
    await waitFor(() => expect(screen.getByText('Review page')).toBeInTheDocument());
    const call = calls.find((c) => c.url === '/api/v1/policies/drafts')!;
    expect(JSON.parse(String(call.init!.body)).compiledRules).toMatchObject({
      dslVersion: 1,
      currency: 'USD',
    });
  });

  it('shows plain English by default when translation is configured', async () => {
    stubApi(true);
    renderRoutes(routes, '/');
    expect(await screen.findByLabelText('Your rules')).toBeInTheDocument();
  });

  it('reports malformed JSON without calling the server', async () => {
    const calls = stubApi(false);
    renderRoutes(routes, '/');
    fireEvent.change(await screen.findByLabelText('Policy JSON'), {
      target: { value: '{ not json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft for review' }));
    expect(await screen.findByText(/Not valid JSON/)).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/v1/policies/drafts')).toBe(false);
  });
});
