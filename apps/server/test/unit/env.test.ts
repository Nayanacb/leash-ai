import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../src/config/env.js';
import { BASE_ENV } from '../helpers.js';

function problemsFor(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('parseConfig', () => {
  it('accepts a minimal sandbox configuration and applies approved defaults', () => {
    const config = parseConfig({ ...BASE_ENV });
    expect(config.port).toBe(4000);
    expect(config.paypal.environment).toBe('sandbox');
    expect(config.paypal.apiBase).toBe('https://api-m.sandbox.paypal.com');
    expect(config.paypal.configured).toBe(false);
    expect(config.llm.configured).toBe(false);
    expect(config.limits).toEqual({
      approvalTtlMinutes: 60,
      authorizationTtlMinutes: 30,
      sandboxMaxTransactionMinor: 50_000,
    });
  });

  it('treats blank placeholders as unset', () => {
    const config = parseConfig({
      ...BASE_ENV,
      PAYPAL_CLIENT_ID: '',
      PAYPAL_CLIENT_SECRET: '  ',
      ANTHROPIC_API_KEY: '',
    });
    expect(config.paypal.clientId).toBeUndefined();
    expect(config.llm.apiKey).toBeUndefined();
  });

  it('requires DATABASE_URL to be a postgres URL', () => {
    expect(problemsFor({ ...BASE_ENV, DATABASE_URL: undefined }).join()).toMatch(/DATABASE_URL/);
    expect(problemsFor({ ...BASE_ENV, DATABASE_URL: 'mysql://x' }).join()).toMatch(/DATABASE_URL/);
  });

  it('marks LLM configured only when the key and both model IDs are set', () => {
    const partial = parseConfig({
      ...BASE_ENV,
      ANTHROPIC_API_KEY: 'k',
      LLM_MODEL_CLASSIFIER: 'model-a',
    });
    expect(partial.llm.configured).toBe(false);
    const full = parseConfig({
      ...BASE_ENV,
      ANTHROPIC_API_KEY: 'k',
      LLM_MODEL_CLASSIFIER: 'model-a',
      LLM_MODEL_POLICY_COMPILER: 'model-b',
    });
    expect(full.llm).toMatchObject({
      configured: true,
      classifierModel: 'model-a',
      policyCompilerModel: 'model-b',
    });
  });

  it('rejects malformed model identifiers', () => {
    expect(
      problemsFor({ ...BASE_ENV, LLM_MODEL_CLASSIFIER: 'not a model; rm -rf' }).join(),
    ).toMatch(/LLM_MODEL_CLASSIFIER/);
  });

  it('requires PayPal client ID and secret together', () => {
    expect(problemsFor({ ...BASE_ENV, PAYPAL_CLIENT_ID: 'id' }).join()).toMatch(/set together/);
    expect(
      parseConfig({ ...BASE_ENV, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's' }).paypal
        .configured,
    ).toBe(true);
  });

  it('lets limits be tightened but never loosened past the approved caps', () => {
    expect(
      parseConfig({ ...BASE_ENV, SANDBOX_MAX_TRANSACTION_MINOR: '10000' }).limits
        .sandboxMaxTransactionMinor,
    ).toBe(10_000);
    expect(problemsFor({ ...BASE_ENV, SANDBOX_MAX_TRANSACTION_MINOR: '50001' }).join()).toMatch(
      /may not exceed/,
    );
    expect(problemsFor({ ...BASE_ENV, SANDBOX_MAX_TRANSACTION_MINOR: '0' })).not.toEqual([]);
    expect(problemsFor({ ...BASE_ENV, APPROVAL_TTL_MINUTES: '0' })).not.toEqual([]);
  });
});

describe('PayPal sandbox-only guard (config)', () => {
  it.each(['live', 'production', 'LIVE', '', undefined])('rejects PAYPAL_ENV=%j', (value) => {
    expect(problemsFor({ ...BASE_ENV, PAYPAL_ENV: value }).join()).toMatch(/PAYPAL_ENV/);
  });

  it.each([
    ['PAYPAL_API_BASE', 'https://api-m.paypal.com'],
    ['PAYPAL_BASE_URL', 'https://api.paypal.com/v2'],
    ['PAYPAL_MODE', 'live'],
  ])('rejects %s=%s', (key, value) => {
    expect(problemsFor({ ...BASE_ENV, [key]: value }).join()).toMatch(new RegExp(key));
  });

  it('allows sandbox hosts in other PAYPAL_ variables', () => {
    expect(
      problemsFor({ ...BASE_ENV, PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com' }),
    ).toEqual([]);
  });
});
