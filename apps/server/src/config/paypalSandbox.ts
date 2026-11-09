/**
 * PayPal sandbox-only guard (docs/ARCHITECTURE.md invariant I5).
 *
 * The live PayPal API base URL does not appear anywhere in this codebase.
 * Every outbound PayPal request (Phase 7+) must pass its URL through
 * `assertPayPalSandboxUrl` before sending.
 */

export const PAYPAL_SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';

const SANDBOX_HOSTS = new Set(['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com']);

/** Hostnames of PayPal's live (real-money) environment. Used only to detect misconfiguration. */
const LIVE_HOST_PATTERN = /(^|[^a-z0-9.-])(api-m|api|www)\.paypal\.com/i;

export class PayPalSandboxViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayPalSandboxViolation';
  }
}

/** Throws unless `url` is an HTTPS URL on a PayPal sandbox API host. */
export function assertPayPalSandboxUrl(url: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PayPalSandboxViolation(`Not a valid URL: ${String(url)}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new PayPalSandboxViolation(`PayPal requests must use HTTPS (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new PayPalSandboxViolation('PayPal URLs must not embed credentials');
  }
  if (parsed.port !== '') {
    throw new PayPalSandboxViolation('PayPal URLs must use the default HTTPS port');
  }
  if (!SANDBOX_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new PayPalSandboxViolation(
      `Refusing non-sandbox PayPal host "${parsed.hostname}". Leash is sandbox-only.`,
    );
  }
  return parsed;
}

/**
 * Scans every PAYPAL_* environment variable for references to PayPal's live
 * API hosts or a "live"/"production" mode. Returns human-readable problems.
 */
export function findLivePayPalReferences(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith('PAYPAL') || value === undefined) continue;
    if (LIVE_HOST_PATTERN.test(value) && !/sandbox\.paypal\.com/i.test(value)) {
      problems.push(`${key} references a live PayPal host`);
    }
    if (/^(live|production|prod)$/i.test(value.trim())) {
      problems.push(`${key} is set to "${value.trim()}"; only sandbox is permitted`);
    }
  }
  return problems;
}
