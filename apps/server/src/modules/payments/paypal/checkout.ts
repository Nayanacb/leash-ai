import { formatMinorAsDecimal } from '@leash/shared';
import { z } from 'zod';
import type { AppConfig } from '../../../config/env.js';
import {
  PaymentProviderError,
  type CreateOrderRequest,
  type OrderView,
  type PaymentProvider,
} from '../provider.js';
import { PayPalClient } from './client.js';

/** The only host a buyer is ever sent to for approval. */
const SANDBOX_CHECKOUT_HOST = 'www.sandbox.paypal.com';

/** PayPal order IDs are short alphanumeric strings; anything else never reaches a URL path. */
const ORDER_ID = /^[A-Z0-9]{8,64}$/;

/** Throws unless `url` is an HTTPS PayPal sandbox checkout page. */
export function assertSandboxApproveUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PaymentProviderError(
      'rejected',
      'BAD_APPROVE_URL',
      'PayPal returned an invalid link',
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== SANDBOX_CHECKOUT_HOST ||
    parsed.port !== '' ||
    parsed.username ||
    parsed.password
  ) {
    throw new PaymentProviderError(
      'rejected',
      'BAD_APPROVE_URL',
      'PayPal returned an approval link outside the sandbox',
    );
  }
  return parsed.toString();
}

function sandboxApproveUrlOrNull(url: string): string | null {
  try {
    return assertSandboxApproveUrl(url);
  } catch {
    return null;
  }
}

function checkedOrderId(orderId: string): string {
  if (!ORDER_ID.test(orderId)) {
    throw new PaymentProviderError('not_found', 'INVALID_ORDER_ID', 'Not a PayPal order ID');
  }
  return orderId;
}

/** Agent-written text goes to PayPal only as a short, printable label. */
function orderDescription(text: string): string {
  // eslint-disable-next-line no-control-regex
  const printable = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ');
  return printable.trim().slice(0, 127) || 'Purchase';
}

/** The order body: every value comes from the stored, authorized transaction. */
export function buildOrderBody(request: CreateOrderRequest) {
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: request.transactionId,
        custom_id: request.transactionId,
        invoice_id: request.transactionId,
        description: orderDescription(request.description),
        amount: {
          currency_code: request.currency,
          value: formatMinorAsDecimal(request.amountMinor, request.currency),
        },
        payee: { email_address: request.payeeEmail },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Leash (sandbox)',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: request.returnUrl,
          cancel_url: request.cancelUrl,
        },
      },
    },
  };
}

const MoneySchema = z.object({ currency_code: z.string(), value: z.string() });
const OrderSchema = z.object({
  id: z.string(),
  status: z.string(),
  purchase_units: z
    .array(
      z.object({
        // Capture responses may omit the order amount; a missing amount never matches.
        amount: MoneySchema.optional(),
        payee: z
          .object({ email_address: z.string().optional(), merchant_id: z.string().optional() })
          .optional(),
        custom_id: z.string().optional(),
        invoice_id: z.string().optional(),
        payments: z
          .object({
            captures: z
              .array(z.object({ id: z.string(), status: z.string(), amount: MoneySchema }))
              .optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  links: z.array(z.object({ href: z.string(), rel: z.string() })).default([]),
});

/** Parses a PayPal order; anything unexpected is treated as an unknown outcome. */
export function parseOrder(body: unknown): OrderView {
  const parsed = OrderSchema.safeParse(body);
  if (!parsed.success) {
    throw new PaymentProviderError(
      'ambiguous',
      'UNEXPECTED_RESPONSE',
      'PayPal returned an order in an unexpected format',
    );
  }
  const o = parsed.data;
  const link = o.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return {
    id: o.id,
    status: o.status,
    purchaseUnits: o.purchase_units.map((u) => ({
      amountValue: u.amount?.value ?? '',
      currency: u.amount?.currency_code ?? '',
      payeeEmail: u.payee?.email_address ?? null,
      payeeMerchantId: u.payee?.merchant_id ?? null,
      customId: u.custom_id ?? null,
      invoiceId: u.invoice_id ?? null,
      captures: (u.payments?.captures ?? []).map((c) => ({
        id: c.id,
        status: c.status,
        amountValue: c.amount.value,
        currency: c.amount.currency_code,
      })),
    })),
    approveUrl: link ? sandboxApproveUrlOrNull(link.href) : null,
  };
}

/** PayPal Checkout (Orders v2, buyer approval), sandbox only. */
export class PayPalCheckoutProvider implements PaymentProvider {
  constructor(private readonly client: PayPalClient) {}

  async createOrder(request: CreateOrderRequest, requestId: string): Promise<OrderView> {
    const body = await this.client.request('POST', '/v2/checkout/orders', {
      body: buildOrderBody(request),
      requestId,
    });
    return parseOrder(body);
  }

  async getOrder(orderId: string): Promise<OrderView> {
    const id = encodeURIComponent(checkedOrderId(orderId));
    return parseOrder(await this.client.request('GET', `/v2/checkout/orders/${id}`));
  }

  async captureOrder(orderId: string, requestId: string): Promise<OrderView> {
    const id = encodeURIComponent(checkedOrderId(orderId));
    return parseOrder(
      await this.client.request('POST', `/v2/checkout/orders/${id}/capture`, { requestId }),
    );
  }
}

/** The configured provider, or null when PayPal sandbox credentials aren't set. */
export function paymentProviderFromConfig(config: AppConfig): PaymentProvider | null {
  const { clientId, clientSecret } = config.paypal;
  if (!clientId || !clientSecret) return null;
  return new PayPalCheckoutProvider(new PayPalClient({ clientId, clientSecret }));
}
