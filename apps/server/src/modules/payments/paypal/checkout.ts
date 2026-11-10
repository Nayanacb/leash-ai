import { formatMinorAsDecimal } from '@leash/shared';
import { z } from 'zod';
import type { AppConfig } from '../../../config/env.js';
import {
  PaymentProviderError,
  type CaptureDetailView,
  type CreateOrderRequest,
  type OrderView,
  type PaymentProvider,
  type RefundRequest,
  type RefundView,
  type WebhookTransmission,
} from '../provider.js';
import { PayPalClient } from './client.js';

/** The only host a buyer is ever sent to for approval. */
const SANDBOX_CHECKOUT_HOST = 'www.sandbox.paypal.com';

/** PayPal order, capture and refund IDs are short alphanumeric strings; anything else never reaches a URL path. */
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

function checkedId(orderId: string): string {
  if (!ORDER_ID.test(orderId)) {
    throw new PaymentProviderError('not_found', 'INVALID_ID', 'Not a PayPal ID');
  }
  return orderId;
}

/** Untrusted text goes to PayPal only as a short, printable label. */
function printableLabel(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const printable = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ');
  return printable.trim().slice(0, max);
}

const orderDescription = (text: string) => printableLabel(text, 127) || 'Purchase';

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
const LinksSchema = z.array(z.object({ href: z.string(), rel: z.string() })).default([]);
const RefundSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: MoneySchema,
  invoice_id: z.string().optional(),
  links: LinksSchema,
});
const CaptureSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: MoneySchema,
  supplementary_data: z
    .object({ related_ids: z.object({ order_id: z.string().optional() }).optional() })
    .optional(),
});
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
            refunds: z.array(RefundSchema).optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  links: LinksSchema,
});

function unexpected(what: string): PaymentProviderError {
  return new PaymentProviderError(
    'ambiguous',
    'UNEXPECTED_RESPONSE',
    `PayPal returned ${what} in an unexpected format`,
  );
}

/** The capture a refund belongs to, from its `up` link (.../v2/payments/captures/{id}). */
function captureIdFromLinks(links: { href: string; rel: string }[]): string | null {
  const up = links.find((l) => l.rel === 'up')?.href;
  const match = up ? /\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(up) : null;
  return match?.[1] ?? null;
}

function toRefundView(r: z.infer<typeof RefundSchema>): RefundView {
  return {
    id: r.id,
    status: r.status,
    amountValue: r.amount.value,
    currency: r.amount.currency_code,
    invoiceId: r.invoice_id ?? null,
    captureId: captureIdFromLinks(r.links),
  };
}

export function parseRefund(body: unknown): RefundView {
  const parsed = RefundSchema.safeParse(body);
  if (!parsed.success) throw unexpected('a refund');
  return toRefundView(parsed.data);
}

export function parseCapture(body: unknown): CaptureDetailView {
  const parsed = CaptureSchema.safeParse(body);
  if (!parsed.success) throw unexpected('a capture');
  const c = parsed.data;
  return {
    id: c.id,
    status: c.status,
    amountValue: c.amount.value,
    currency: c.amount.currency_code,
    orderId: c.supplementary_data?.related_ids?.order_id ?? null,
  };
}

/** Parses a PayPal order; anything unexpected is treated as an unknown outcome. */
export function parseOrder(body: unknown): OrderView {
  const parsed = OrderSchema.safeParse(body);
  if (!parsed.success) throw unexpected('an order');
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
      refunds: (u.payments?.refunds ?? []).map(toRefundView),
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
    const id = encodeURIComponent(checkedId(orderId));
    return parseOrder(await this.client.request('GET', `/v2/checkout/orders/${id}`));
  }

  async captureOrder(orderId: string, requestId: string): Promise<OrderView> {
    const id = encodeURIComponent(checkedId(orderId));
    return parseOrder(
      await this.client.request('POST', `/v2/checkout/orders/${id}/capture`, { requestId }),
    );
  }
  async refundCapture(
    captureId: string,
    request: RefundRequest,
    requestId: string,
  ): Promise<RefundView> {
    const id = encodeURIComponent(checkedId(captureId));
    const note = request.note ? printableLabel(request.note, 255) : '';
    const body = await this.client.request('POST', `/v2/payments/captures/${id}/refund`, {
      body: {
        amount: {
          currency_code: request.currency,
          value: formatMinorAsDecimal(request.amountMinor, request.currency),
        },
        invoice_id: request.invoiceId,
        ...(note ? { note_to_payer: note } : {}),
      },
      requestId,
    });
    return parseRefund(body);
  }

  async getRefund(refundId: string): Promise<RefundView> {
    const id = encodeURIComponent(checkedId(refundId));
    return parseRefund(await this.client.request('GET', `/v2/payments/refunds/${id}`));
  }

  async getCapture(captureId: string): Promise<CaptureDetailView> {
    const id = encodeURIComponent(checkedId(captureId));
    return parseCapture(await this.client.request('GET', `/v2/payments/captures/${id}`));
  }

  async verifyWebhookSignature(
    t: WebhookTransmission,
    webhookId: string,
    rawBody: string,
  ): Promise<boolean> {
    // The event goes to PayPal exactly as received: re-serializing it can change
    // its bytes and break verification. It must be a single JSON object, so
    // splicing it into the request can't alter the surrounding fields.
    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return false;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    const fields = {
      auth_algo: t.authAlgo,
      cert_url: t.certUrl,
      transmission_id: t.transmissionId,
      transmission_sig: t.transmissionSig,
      transmission_time: t.transmissionTime,
      webhook_id: webhookId,
    };
    const rawJson = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`;
    const body = await this.client.request('POST', '/v1/notifications/verify-webhook-signature', {
      rawJson,
    });
    const status = (body as { verification_status?: unknown } | null)?.verification_status;
    return status === 'SUCCESS';
  }
}

/** The configured provider, or null when PayPal sandbox credentials aren't set. */
export function paymentProviderFromConfig(config: AppConfig): PaymentProvider | null {
  const { clientId, clientSecret } = config.paypal;
  if (!clientId || !clientSecret) return null;
  return new PayPalCheckoutProvider(new PayPalClient({ clientId, clientSecret }));
}
