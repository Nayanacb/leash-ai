import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemStatus } from './SystemStatus';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SystemStatus />
    </QueryClientProvider>,
  );
}

const HEALTH = {
  status: 'ok',
  service: 'leash-server',
  version: '0.1.0',
  uptimeSeconds: 3,
  paypalEnvironment: 'sandbox',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SystemStatus', () => {
  it('shows a healthy system', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith('/healthz')
            ? jsonResponse(200, HEALTH)
            : jsonResponse(200, { status: 'ready', checks: { database: 'ok' } }),
        ),
      ),
    );
    renderWithClient();
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Sandbox')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
  });

  it('shows the database as unavailable when readiness returns 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith('/healthz')
            ? jsonResponse(200, HEALTH)
            : jsonResponse(503, { status: 'not_ready', checks: { database: 'error' } }),
        ),
      ),
    );
    renderWithClient();
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
  });

  it('shows the API as unreachable when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderWithClient();
    expect(await screen.findByText('Unreachable')).toBeInTheDocument();
  });

  it('rejects a response that does not match the schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(200, { status: 'ok', paypalEnvironment: 'live' }))),
    );
    renderWithClient();
    expect(await screen.findByText('Unreachable')).toBeInTheDocument();
  });
});
