import { assertPayPalSandboxUrl, PAYPAL_SANDBOX_API_BASE } from '../../../config/paypalSandbox.js';
import { PaymentProviderError } from '../provider.js';

/**
 * The only code that holds PayPal credentials (invariant I1). Every request
 * goes to the sandbox API base, checked by the sandbox guard (invariant I5).
 * Credentials and OAuth tokens never appear in errors, logs or responses.
 */

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export const PAYPAL_HTTP_TIMEOUT_MS = 20_000;

/** PayPal's error body: only these fields are ever surfaced. */
function describeError(status: number, body: unknown): { code: string; message: string } {
  const b = (body && typeof body === 'object' ? body : {}) as {
    name?: unknown;
    error?: unknown;
    debug_id?: unknown;
    details?: { issue?: unknown }[];
  };
  const issue = typeof b.details?.[0]?.issue === 'string' ? b.details[0].issue : null;
  const name =
    typeof b.name === 'string' ? b.name : typeof b.error === 'string' ? b.error : `HTTP_${status}`;
  const debugId = typeof b.debug_id === 'string' ? ` (debug id ${b.debug_id})` : '';
  const code = (issue ?? name).slice(0, 100);
  return {
    code,
    message: `PayPal returned ${status} ${name}${issue ? `/${issue}` : ''}${debugId}`,
  };
}

export class PayPalClient {
  private token: CachedToken | null = null;
  private tokenRequest: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: PayPalClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? PAYPAL_HTTP_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  private url(path: string): URL {
    return assertPayPalSandboxUrl(new URL(path, PAYPAL_SANDBOX_API_BASE));
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new PaymentProviderError(
        'ambiguous',
        timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        timedOut ? 'PayPal did not respond in time' : 'Could not reach PayPal',
      );
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    // One token request at a time; concurrent callers share it.
    this.tokenRequest ??= (async () => {
      try {
        const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString(
          'base64',
        );
        const res = await this.send(this.url('/v1/oauth2/token'), {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: 'grant_type=client_credentials',
        });
        const body = (await res.json().catch(() => null)) as {
          access_token?: unknown;
          expires_in?: unknown;
        } | null;
        if (!res.ok || typeof body?.access_token !== 'string') {
          const { code, message } = describeError(res.status, body);
          throw new PaymentProviderError(
            res.status >= 500 ? 'ambiguous' : 'auth',
            code,
            `PayPal sandbox authentication failed: ${message}`,
            res.status,
          );
        }
        const ttlSeconds = typeof body.expires_in === 'number' ? body.expires_in : 300;
        // Refresh a minute early so a token never expires mid-request.
        this.token = {
          value: body.access_token,
          expiresAt: this.now() + Math.max(0, ttlSeconds - 60) * 1000,
        };
        return body.access_token;
      } finally {
        this.tokenRequest = null;
      }
    })();
    return this.tokenRequest;
  }

  /**
   * Sends an authenticated JSON request. A rejected token is refreshed and the
   * request retried once — safe because PayPal did not execute it.
   */
  async request(
    method: 'GET' | 'POST',
    path: string,
    options: {
      body?: unknown;
      /** A pre-serialized JSON body, sent exactly as given (webhook verification). */
      rawJson?: string;
      requestId?: string;
    } = {},
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const res = await this.send(this.url(path), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          Prefer: 'return=representation',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          ...(options.requestId ? { 'PayPal-Request-Id': options.requestId } : {}),
        },
        ...(options.rawJson !== undefined
          ? { body: options.rawJson }
          : options.body !== undefined
            ? { body: JSON.stringify(options.body) }
            : {}),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.ok) return body;
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      const { code, message } = describeError(res.status, body);
      const kind =
        res.status >= 500 || res.status === 429 || res.status === 408
          ? 'ambiguous'
          : res.status === 404
            ? 'not_found'
            : res.status === 401 || res.status === 403
              ? 'auth'
              : 'rejected';
      throw new PaymentProviderError(kind, code, message, res.status);
    }
  }
}
