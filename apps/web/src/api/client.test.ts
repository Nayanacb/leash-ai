import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiRequestError, apiSend, setCsrfToken } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('apiSend', () => {
  it('sends JSON with the session CSRF token', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    setCsrfToken('tok-1');
    await apiSend('POST', '/api/v1/agents', { name: 'x' }, z.object({ ok: z.boolean() }));

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBe('tok-1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init!.credentials).toBe('same-origin');
  });

  it('surfaces validation details from error responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'VALIDATION_ERROR',
                message: 'Request validation failed',
                details: [{ path: 'name', message: 'Required' }],
              },
            }),
            { status: 400 },
          ),
        ),
      ),
    );
    const err = await apiSend('POST', '/x', {}, z.object({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).fieldErrors).toEqual([{ path: 'name', message: 'Required' }]);
  });
});

describe('isSessionEnded', () => {
  it('treats only UNAUTHENTICATED as the end of the session', async () => {
    const { isSessionEnded } = await import('./session');
    expect(isSessionEnded(new ApiRequestError(401, 'UNAUTHENTICATED', 'Sign in'))).toBe(true);
    expect(
      isSessionEnded(new ApiRequestError(401, 'INVALID_PASSWORD', 'Password is incorrect')),
    ).toBe(false);
    expect(
      isSessionEnded(new ApiRequestError(401, 'INVALID_CREDENTIALS', 'Invalid email or password')),
    ).toBe(false);
    expect(isSessionEnded(new ApiRequestError(403, 'CSRF_FAILED', 'x'))).toBe(false);
    expect(isSessionEnded(new Error('network'))).toBe(false);
  });
});
