import { ApiErrorSchema } from '@leash/shared';
import type { z } from 'zod';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/**
 * Fetches JSON from the Leash API (same origin, via the Vite proxy in dev) and
 * validates it with a Zod schema. Responses are never trusted unvalidated.
 *
 * `acceptStatuses` lets callers treat non-2xx responses with a meaningful body
 * (e.g. 503 from /readyz) as data rather than errors.
 */
export async function apiGet<S extends z.ZodType>(
  path: string,
  schema: S,
  options: { acceptStatuses?: number[]; signal?: AbortSignal } = {},
): Promise<z.infer<S>> {
  const res = await fetch(path, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal: options.signal,
  });
  const body: unknown = await res.json().catch(() => undefined);

  if (!res.ok && !options.acceptStatuses?.includes(res.status)) {
    const parsed = ApiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { code, message, requestId } = parsed.data.error;
      throw new ApiRequestError(res.status, code, message, requestId);
    }
    throw new ApiRequestError(res.status, 'HTTP_ERROR', `Request failed with status ${res.status}`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiRequestError(
      res.status,
      'INVALID_RESPONSE',
      'The server returned an unexpected response',
    );
  }
  return parsed.data;
}
