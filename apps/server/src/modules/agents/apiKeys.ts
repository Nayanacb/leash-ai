import { randomToken, sha256Hex } from '../../lib/crypto.js';

export const API_KEY_PREFIX = 'lsh_';
/** "lsh_" + 43 base64url characters (256 bits). */
const API_KEY_PATTERN = /^lsh_[A-Za-z0-9_-]{43}$/;
/** Characters of the key shown in the UI to identify it (not enough to guess the rest). */
const DISPLAY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  /** Shown to the user exactly once, never stored. */
  secret: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const secret = `${API_KEY_PREFIX}${randomToken(32)}`;
  return { secret, prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH), hash: hashApiKey(secret) };
}

/**
 * Keys carry 256 bits of entropy, so a fast hash is appropriate (no salt or
 * slow KDF needed) and lets us look keys up by hash in a unique index.
 */
export function hashApiKey(secret: string): string {
  return sha256Hex(secret);
}

export function looksLikeApiKey(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}

export function apiKeyStatus(
  key: { revokedAt: Date | null; expiresAt: Date | null },
  now = new Date(),
) {
  if (key.revokedAt) return 'REVOKED' as const;
  if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return 'EXPIRED' as const;
  return 'ACTIVE' as const;
}
