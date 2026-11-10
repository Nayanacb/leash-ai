import { ApiErrorSchema, CSRF_HEADER } from '@leash/shared';
import type { z } from 'zod';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** Field-level messages from a VALIDATION_ERROR response, if any. */
  get fieldErrors(): { path: string; message: string }[] {
    return Array.isArray(this.details) ? (this.details as { path: string; message: string }[]) : [];
  }
}

/**
 * The CSRF token for the current session. It lives in memory only (never in
 * storage) and is sent on every state-changing request.
 */
let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

async function readBody(res: Response): Promise<unknown> {
  return res.json().catch(() => undefined);
}

function toError(res: Response, body: unknown): ApiRequestError {
  const parsed = ApiErrorSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, requestId, details } = parsed.data.error;
    return new ApiRequestError(res.status, code, message, requestId, details);
  }
  return new ApiRequestError(res.status, 'HTTP_ERROR', `Request failed with status ${res.status}`);
}

function parseWith<S extends z.ZodType>(schema: S, body: unknown, status: number): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiRequestError(
      status,
      'INVALID_RESPONSE',
      'The server returned an unexpected response',
    );
  }
  return parsed.data;
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
  const body = await readBody(res);
  if (!res.ok && !options.acceptStatuses?.includes(res.status)) throw toError(res, body);
  return parseWith(schema, body, res.status);
}

type Method = 'POST' | 'PATCH' | 'DELETE';

async function send(
  method: Method,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...extraHeaders, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken) headers[CSRF_HEADER] = csrfToken;
  return fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function apiSend<S extends z.ZodType>(
  method: Method,
  path: string,
  body: unknown,
  schema: S,
  extraHeaders?: Record<string, string>,
): Promise<z.infer<S>> {
  const res = await send(method, path, body, extraHeaders);
  const data = await readBody(res);
  if (!res.ok) throw toError(res, data);
  return parseWith(schema, data, res.status);
}

/** For endpoints that answer 204 No Content. */
export async function apiSendNoContent(
  method: Method,
  path: string,
  body?: unknown,
): Promise<void> {
  const res = await send(method, path, body);
  if (!res.ok) throw toError(res, await readBody(res));
}
