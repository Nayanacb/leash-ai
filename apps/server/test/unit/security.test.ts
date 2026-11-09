import { describe, expect, it } from 'vitest';
import {
  apiKeyStatus,
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
} from '../../src/modules/agents/apiKeys.js';
import { canonicalJson } from '../../src/modules/audit/canonicalJson.js';
import { computeAuditHash, sanitizeAuditData } from '../../src/modules/audit/auditLog.js';
import {
  csrfTokenFor,
  isValidCsrfToken,
  sessionCookieName,
  sessionCookieOptions,
} from '../../src/modules/auth/sessions.js';
import { testConfig } from '../helpers.js';

describe('canonicalJson', () => {
  it('is independent of key order and whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('rejects values JSON cannot represent faithfully', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson({ n: 1n })).toThrow();
  });
});

describe('audit hashing', () => {
  const fields = {
    prevHash: '0'.repeat(64),
    id: 'id',
    userId: null,
    transactionId: null,
    actorType: 'USER',
    actorId: 'u',
    action: 'x.y',
    data: { a: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('changes when any field changes', () => {
    const base = computeAuditHash(fields);
    for (const [k, v] of Object.entries({
      prevHash: '1'.repeat(64),
      action: 'x.z',
      data: { a: 2 },
      actorId: 'v',
    })) {
      expect(computeAuditHash({ ...fields, [k]: v })).not.toBe(base);
    }
  });

  it('redacts secret-looking keys and strips NUL characters', () => {
    expect(
      sanitizeAuditData({
        apiKey: 'k',
        nested: { password: 'p', clientSecret: 's', ok: 'a\u0000b' },
        when: new Date(0),
      }),
    ).toEqual({
      apiKey: '[REDACTED]',
      nested: { password: '[REDACTED]', clientSecret: '[REDACTED]', ok: 'ab' },
      when: '1970-01-01T00:00:00.000Z',
    });
  });
});

describe('API keys', () => {
  it('generates unique 256-bit keys with a recognisable prefix', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.secret).not.toBe(b.secret);
    expect(looksLikeApiKey(a.secret)).toBe(true);
    expect(a.prefix).toBe(a.secret.slice(0, 12));
    expect(a.hash).toBe(hashApiKey(a.secret));
    expect(a.hash).not.toContain(a.secret.slice(4));
  });

  it('derives status from revocation and expiry', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(apiKeyStatus({ revokedAt: null, expiresAt: new Date('2026-07-01') }, now)).toBe(
      'ACTIVE',
    );
    expect(apiKeyStatus({ revokedAt: null, expiresAt: new Date('2026-05-01') }, now)).toBe(
      'EXPIRED',
    );
    expect(
      apiKeyStatus({ revokedAt: new Date('2026-05-01'), expiresAt: new Date('2026-07-01') }, now),
    ).toBe('REVOKED');
  });
});

describe('CSRF tokens', () => {
  it('are bound to the session token', () => {
    const token = csrfTokenFor('session-a'.padEnd(43, 'x'));
    expect(isValidCsrfToken('session-a'.padEnd(43, 'x'), token)).toBe(true);
    expect(isValidCsrfToken('session-b'.padEnd(43, 'x'), token)).toBe(false);
    expect(isValidCsrfToken('session-a'.padEnd(43, 'x'), undefined)).toBe(false);
    expect(isValidCsrfToken('session-a'.padEnd(43, 'x'), '')).toBe(false);
  });
});

describe('session cookie', () => {
  it('uses the __Host- prefix and Secure in production', () => {
    const prod = testConfig({ NODE_ENV: 'production' });
    expect(sessionCookieName(prod)).toBe('__Host-leash_session');
    expect(sessionCookieOptions(prod)).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
    });
  });

  it('is not Secure in development (plain-HTTP localhost)', () => {
    const dev = testConfig({ NODE_ENV: 'development' });
    expect(sessionCookieName(dev)).toBe('leash_session');
    expect(sessionCookieOptions(dev).secure).toBe(false);
  });

  it('accepts only the configured dashboard origin (and its localhost twin in dev)', () => {
    expect(testConfig({ NODE_ENV: 'development' }).allowedOrigins.sort()).toEqual([
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]);
    expect(
      testConfig({ NODE_ENV: 'production', WEB_ORIGIN: 'https://leash.example' }).allowedOrigins,
    ).toEqual(['https://leash.example']);
  });
});
