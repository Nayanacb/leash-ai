import { describe, expect, it } from 'vitest';
import {
  assertPayPalSandboxUrl,
  findLivePayPalReferences,
  PAYPAL_SANDBOX_API_BASE,
  PayPalSandboxViolation,
} from '../../src/config/paypalSandbox.js';

describe('assertPayPalSandboxUrl', () => {
  it('accepts sandbox API URLs', () => {
    expect(assertPayPalSandboxUrl(`${PAYPAL_SANDBOX_API_BASE}/v2/checkout/orders`).hostname).toBe(
      'api-m.sandbox.paypal.com',
    );
    expect(() =>
      assertPayPalSandboxUrl('https://api.sandbox.paypal.com/v1/oauth2/token'),
    ).not.toThrow();
  });

  it.each([
    'https://api-m.paypal.com/v2/checkout/orders',
    'https://api.paypal.com/v1/oauth2/token',
    'http://api-m.sandbox.paypal.com/v2/checkout/orders',
    'https://api-m.sandbox.paypal.com:8443/v2',
    'https://user:pass@api-m.sandbox.paypal.com/v2',
    'https://api-m.sandbox.paypal.com.evil.example/v2',
    'https://evil.example/?u=api-m.sandbox.paypal.com',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => assertPayPalSandboxUrl(url)).toThrow(PayPalSandboxViolation);
  });
});

describe('findLivePayPalReferences', () => {
  it('ignores non-PayPal variables and sandbox values', () => {
    expect(
      findLivePayPalReferences({
        OTHER_URL: 'https://api-m.paypal.com',
        PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
        PAYPAL_ENV: 'sandbox',
      }),
    ).toEqual([]);
  });

  it('flags live hosts and live modes', () => {
    expect(
      findLivePayPalReferences({
        PAYPAL_API_BASE: 'https://api-m.paypal.com',
        PAYPAL_MODE: 'production',
      }),
    ).toHaveLength(2);
  });
});
