/**
 * Approved defaults (docs/ARCHITECTURE.md §0). Environment variables may
 * tighten these but the server refuses to start if they are loosened past
 * the hard caps.
 */
export const DEFAULT_APPROVAL_TTL_MINUTES = 60;
export const DEFAULT_AUTHORIZATION_TTL_MINUTES = 30;

/** $500.00 — the sandbox per-transaction ceiling no policy can exceed. */
export const SANDBOX_MAX_TRANSACTION_MINOR = 50_000;
export const SANDBOX_MAX_TRANSACTION_CURRENCY = 'USD';
