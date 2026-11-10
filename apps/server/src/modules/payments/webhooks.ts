import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Prisma, TransactionStatus } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/prismaErrors.js';
import { recordAuditEvent } from '../audit/auditLog.js';
import {
  requireProvider,
  runCompletion,
  settleFromOrder,
  type PaymentDeps,
} from './checkout.service.js';
import { PaymentProviderError, type WebhookTransmission } from './provider.js';
import { recordReversal, syncRefundFromPayPal } from './refunds.service.js';

/**
 * PayPal webhooks (docs/ARCHITECTURE.md §6.4).
 *
 * - Only deliveries PayPal itself verifies (verify-webhook-signature, with the
 *   configured webhook ID and the raw body byte for byte) are stored or acted on.
 * - A delivery is a hint, never proof: every handler re-reads the order,
 *   capture or refund from PayPal and reuses the checkout/refund code.
 * - Webhooks never authorize: no handler moves a purchase into AUTHORIZED, and
 *   capture only happens through the same checks as the return page.
 * - Duplicates (same event ID) are processed once; ordering doesn't matter
 *   because handlers act on PayPal's current state with forward-only CAS.
 */

/** PayPal signs with certificates from these sandbox hosts only. */
const CERT_HOSTS = new Set(['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com']);
/** Deliveries older (or newer) than this are rejected as replays. */
export const TRANSMISSION_WINDOW_MS = 15 * 60_000;
export const MAX_WEBHOOK_ATTEMPTS = 5;

type HeaderReader = (name: string) => string | undefined;

/** Reads and sanity-checks the signed transmission headers (cheap checks before calling PayPal). */
export function readTransmission(
  header: HeaderReader,
  now: Date,
): { ok: true; transmission: WebhookTransmission } | { ok: false; reason: string } {
  const get = (name: string, max: number, pattern?: RegExp) => {
    const value = header(name);
    if (!value || value.length > max || (pattern && !pattern.test(value))) return null;
    return value;
  };
  const transmissionId = get('paypal-transmission-id', 128, /^[A-Za-z0-9-]+$/);
  const transmissionTime = get('paypal-transmission-time', 64);
  const transmissionSig = get('paypal-transmission-sig', 2048, /^[A-Za-z0-9+/=_-]+$/);
  const certUrl = get('paypal-cert-url', 512);
  const authAlgo = get('paypal-auth-algo', 32, /^[A-Za-z0-9]+$/);
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    return { ok: false, reason: 'MISSING_HEADERS' };
  }
  let cert: URL;
  try {
    cert = new URL(certUrl);
  } catch {
    return { ok: false, reason: 'BAD_CERT_URL' };
  }
  if (cert.protocol !== 'https:' || !CERT_HOSTS.has(cert.hostname) || cert.port !== '') {
    return { ok: false, reason: 'BAD_CERT_URL' };
  }
  const sentAt = Date.parse(transmissionTime);
  if (Number.isNaN(sentAt) || Math.abs(now.getTime() - sentAt) > TRANSMISSION_WINDOW_MS) {
    return { ok: false, reason: 'STALE_TRANSMISSION' };
  }
  return {
    ok: true,
    transmission: { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo },
  };
}

const EventSchema = z.object({
  id: z.string().min(1).max(128),
  event_type: z.string().min(1).max(128),
  resource_type: z.string().max(64).optional(),
  create_time: z.string().max(64).optional(),
  resource: z.record(z.string(), z.unknown()),
});

/** What Leash keeps of an event: identifiers, status and amount — no payer details. */
export interface WebhookSummary {
  eventType: string;
  resourceType: string | null;
  resourceId: string | null;
  status: string | null;
  amount: { currency: string; value: string } | null;
  orderId: string | null;
  createTime: string | null;
}

const str = (v: unknown, max = 128) => (typeof v === 'string' && v.length <= max ? v : null);

export function summarizeEvent(event: z.infer<typeof EventSchema>): WebhookSummary {
  const r = event.resource;
  const amount = r.amount as { currency_code?: unknown; value?: unknown } | undefined;
  const related = (r.supplementary_data as { related_ids?: { order_id?: unknown } } | undefined)
    ?.related_ids;
  return {
    eventType: event.event_type,
    resourceType: str(event.resource_type, 64),
    resourceId: str(r.id),
    status: str(r.status, 64),
    amount:
      amount && str(amount.currency_code, 3) && str(amount.value, 32)
        ? { currency: amount.currency_code as string, value: amount.value as string }
        : null,
    orderId: event.event_type.startsWith('CHECKOUT.ORDER.') ? str(r.id) : str(related?.order_id),
    createTime: str(event.create_time, 64),
  };
}

type Outcome = { result: string; transactionId: string | null };

const SYSTEM_COMPLETER = { type: 'SYSTEM' as const, id: null };
const CHECKOUT_STARTED: TransactionStatus[] = ['ORDER_CREATED', 'BUYER_APPROVED'];

/** Acts on one stored event. Throws only for failures worth retrying. */
export async function processWebhookEvent(
  deps: PaymentDeps,
  eventId: string,
  summary: WebhookSummary,
): Promise<Outcome> {
  const provider = requireProvider(deps.provider);
  const { db } = deps;
  const id = summary.resourceId;
  if (!id) return { result: 'ignored', transactionId: null };

  switch (summary.eventType) {
    case 'CHECKOUT.ORDER.APPROVED': {
      const t = await db.transaction.findFirst({ where: { paypalOrderId: id } });
      if (!t) return unknownResource(deps, eventId, summary);
      if (!CHECKOUT_STARTED.includes(t.status)) return { result: 'ignored', transactionId: t.id };
      try {
        // Exactly the return page's flow: PayPal is re-read and every check re-run.
        await runCompletion(deps, t, { ...SYSTEM_COMPLETER, meta: { webhookEventId: eventId } });
      } catch (err) {
        // 409s (not approved yet, expired, mismatch, policy now blocks…) are outcomes, already recorded.
        if (err instanceof AppError && err.status < 500) {
          return { result: `checkout:${err.code}`, transactionId: t.id };
        }
        throw err;
      }
      return { result: 'checkout_completed', transactionId: t.id };
    }
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.CAPTURE.PENDING':
    case 'PAYMENT.CAPTURE.DENIED': {
      const t = await db.transaction.findFirst({
        where: {
          OR: [
            { paypalCaptureId: id },
            ...(summary.orderId ? [{ paypalOrderId: summary.orderId }] : []),
          ],
        },
      });
      if (!t) return unknownResource(deps, eventId, summary);
      if (t.status !== 'CAPTURING' || !t.paypalOrderId) {
        return { result: 'ignored', transactionId: t.id };
      }
      const order = await provider.getOrder(t.paypalOrderId);
      const settled = await settleFromOrder(deps, t, order, SYSTEM_COMPLETER);
      return { result: `capture:${settled}`, transactionId: t.id };
    }
    case 'PAYMENT.CAPTURE.REFUNDED': {
      const result = await syncRefundFromPayPal(deps, id);
      const refund = await db.refund.findFirst({ where: { paypalRefundId: id } });
      if (result === 'unknown') return unknownResource(deps, eventId, summary);
      return { result: `refund:${result}`, transactionId: refund?.transactionId ?? null };
    }
    case 'PAYMENT.CAPTURE.REVERSED': {
      const result = await recordReversal(deps, id);
      if (result === 'unknown') return unknownResource(deps, eventId, summary);
      const t = await db.transaction.findFirst({ where: { paypalCaptureId: id } });
      return { result: `reversal:${result}`, transactionId: t?.id ?? null };
    }
    default:
      return { result: 'ignored', transactionId: null };
  }
}

/** A verified event about something Leash doesn't know: recorded, nothing changes. */
async function unknownResource(
  deps: PaymentDeps,
  eventId: string,
  summary: WebhookSummary,
): Promise<Outcome> {
  await recordAuditEvent(deps.db, {
    actorType: 'SYSTEM',
    actorId: null,
    userId: null,
    action: 'payment.webhook_unmatched',
    data: { eventId, eventType: summary.eventType, resourceId: summary.resourceId },
  });
  return { result: 'unmatched', transactionId: null };
}

/** Processes a stored event and records the outcome; false if it should be retried. */
async function processStored(
  deps: PaymentDeps,
  row: { id: string; paypalEventId: string; payload: Prisma.JsonValue },
) {
  await deps.db.webhookEvent.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 } },
  });
  try {
    const outcome = await processWebhookEvent(
      deps,
      row.paypalEventId,
      row.payload as unknown as WebhookSummary,
    );
    await deps.db.webhookEvent.update({
      where: { id: row.id },
      data: { processedAt: new Date(), transactionId: outcome.transactionId, error: null },
    });
    return true;
  } catch (err) {
    const message =
      err instanceof PaymentProviderError || err instanceof AppError
        ? `${err.name}: ${err.message}`
        : 'processing failed';
    await deps.db.webhookEvent.update({
      where: { id: row.id },
      data: { error: message.slice(0, 500) },
    });
    deps.logger?.error({ err, eventId: row.paypalEventId }, 'webhook processing failed');
    return false;
  }
}

/** Retries verified events whose processing failed (bounded attempts). */
export async function reprocessWebhookEvents(
  deps: PaymentDeps,
  options: { now?: Date; minAgeMs?: number; batchSize?: number } = {},
): Promise<{ processed: number; failed: number }> {
  if (!deps.provider) return { processed: 0, failed: 0 };
  const now = options.now ?? new Date();
  const rows = await deps.db.webhookEvent.findMany({
    where: {
      processedAt: null,
      verified: true,
      attempts: { lt: MAX_WEBHOOK_ATTEMPTS },
      receivedAt: { lt: new Date(now.getTime() - (options.minAgeMs ?? 60_000)) },
    },
    orderBy: { receivedAt: 'asc' },
    take: options.batchSize ?? 50,
  });
  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    if (await processStored(deps, row)) processed++;
    else failed++;
  }
  return { processed, failed };
}

/** POST /api/webhooks/paypal — mounted with a raw-body parser, before the JSON parser. */
export function paypalWebhookHandler(ctx: AppContext): RequestHandler {
  const deps: PaymentDeps = {
    db: ctx.db,
    config: ctx.config,
    provider: ctx.paymentProvider,
    logger: ctx.logger,
  };
  return async (req: Request, res) => {
    const webhookId = ctx.config.paypal.webhookId;
    if (!ctx.paymentProvider || !webhookId) {
      // PayPal retries; nothing is lost while it's being configured.
      throw new AppError(503, 'WEBHOOKS_NOT_CONFIGURED', 'PayPal webhooks are not configured');
    }
    const checked = readTransmission((name) => req.get(name), new Date());
    if (!checked.ok) throw AppError.badRequest(`Invalid webhook delivery (${checked.reason})`);
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!raw) throw AppError.badRequest('Invalid webhook delivery (EMPTY_BODY)');
    // Shape first (cheap, and saves a verification call for junk); trust only after PayPal verifies.
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw AppError.badRequest('Invalid webhook delivery (EVENT)');
    }
    const parsed = EventSchema.safeParse(body);
    if (!parsed.success) throw AppError.badRequest('Invalid webhook delivery (EVENT)');

    let verified: boolean;
    try {
      verified = await ctx.paymentProvider.verifyWebhookSignature(
        checked.transmission,
        webhookId,
        raw,
      );
    } catch (err) {
      ctx.logger.warn(
        {
          transmissionId: checked.transmission.transmissionId,
          code: (err as PaymentProviderError).code,
        },
        'webhook verification unavailable',
      );
      throw new AppError(503, 'VERIFICATION_UNAVAILABLE', 'Could not verify the webhook right now');
    }
    if (!verified) {
      ctx.logger.warn(
        { transmissionId: checked.transmission.transmissionId },
        'rejected webhook with an invalid signature',
      );
      throw AppError.badRequest('Invalid webhook delivery (SIGNATURE)');
    }

    const summary = summarizeEvent(parsed.data);

    let row;
    try {
      row = await ctx.db.webhookEvent.create({
        data: {
          paypalEventId: parsed.data.id,
          eventType: summary.eventType,
          resourceId: summary.resourceId,
          payload: summary as unknown as Prisma.InputJsonObject,
          verified: true,
          transmissionId: checked.transmission.transmissionId,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      row = await ctx.db.webhookEvent.findUniqueOrThrow({
        where: { paypalEventId: parsed.data.id },
      });
      if (row.processedAt) {
        res.json({ received: true, duplicate: true });
        return;
      }
    }
    if (await processStored(deps, row)) {
      res.json({ received: true });
      return;
    }
    // Non-2xx makes PayPal deliver again; the sweep retries too.
    throw new AppError(500, 'WEBHOOK_PROCESSING_FAILED', 'The event will be retried');
  };
}
