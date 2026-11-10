/**
 * Live check of the PayPal SANDBOX integration (no money moves, nothing is captured).
 *
 *   npm run paypal:smoke -w @leash/server -- --payee <sandbox business account email>
 *
 * 1. Gets an OAuth token with PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox only).
 * 2. Creates one 1.00 USD order to the given payee, exactly as checkout would.
 * 3. Fetches it back and verifies amount, currency, payee and IDs with the app's own checks.
 * The order is never captured; PayPal discards it after a few hours.
 * Never prints the client secret or OAuth token. Exit codes: 0 = pass, 1 = fail, 2 = not configured.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ConfigError, parseConfig } from '../src/config/env.js';
import { paymentProviderFromConfig } from '../src/modules/payments/paypal/checkout.js';
import { orderRequestId, PaymentProviderError } from '../src/modules/payments/provider.js';
import { orderMismatches } from '../src/modules/payments/verify.js';

function line(ok: boolean, label: string, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function main(): Promise<number> {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.log(err.message);
      return 1;
    }
    throw err;
  }
  console.log(`PayPal environment: ${config.paypal.environment} (${config.paypal.apiBase})`);
  const provider = paymentProviderFromConfig(config);
  if (!provider) {
    console.log(
      '\nNot configured: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox app) in apps/server/.env.',
    );
    return 2;
  }
  const i = process.argv.indexOf('--payee');
  const payee = i > 0 ? process.argv[i + 1] : undefined;
  if (!payee || !payee.includes('@')) {
    console.log(
      '\nUsage: npm run paypal:smoke -w @leash/server -- --payee <sandbox business email>',
    );
    return 2;
  }

  const transactionId = randomUUID();
  const base = config.webOrigin.replace(/\/$/, '');
  try {
    const created = await provider.createOrder(
      {
        transactionId,
        amountMinor: 100,
        currency: 'USD',
        payeeEmail: payee,
        description: 'Leash sandbox smoke test (not captured)',
        returnUrl: `${base}/transactions/${transactionId}/paypal-return`,
        cancelUrl: `${base}/transactions/${transactionId}?paypal=cancelled`,
      },
      orderRequestId(transactionId),
    );
    let ok = line(true, 'OAuth token + order created', `order ${created.id}, ${created.status}`);
    ok = line(Boolean(created.approveUrl), 'sandbox approval link returned') && ok;

    const fetched = await provider.getOrder(created.id);
    const expected = {
      orderId: created.id,
      transactionId,
      amountMinor: 100,
      currency: 'USD' as const,
      payeeEmail: payee,
    };
    const mismatches = orderMismatches(fetched, expected);
    ok = line(mismatches.length === 0, 'fetched order matches', mismatches.join(', ')) && ok;

    const again = await provider.createOrder(
      {
        transactionId,
        amountMinor: 100,
        currency: 'USD',
        payeeEmail: payee,
        description: 'Leash sandbox smoke test (not captured)',
        returnUrl: `${base}/transactions/${transactionId}/paypal-return`,
        cancelUrl: `${base}/transactions/${transactionId}?paypal=cancelled`,
      },
      orderRequestId(transactionId),
    );
    ok = line(again.id === created.id, 'same request ID returns the same order') && ok;
    console.log(
      `\nOptional: open this link and approve with a sandbox PERSONAL account to see the buyer page\n(nothing is captured): ${created.approveUrl ?? '(none)'}`,
    );
    return ok ? 0 : 1;
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      line(false, 'PayPal sandbox request', `${err.kind}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : 'unknown');
    process.exit(1);
  },
);
