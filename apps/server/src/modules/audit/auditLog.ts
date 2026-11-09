import type { ActorType, AuditEventDto } from '@leash/shared';
import { randomUUID } from 'node:crypto';
import type { Database } from '../../db.js';
import type { AuditEvent, Prisma } from '../../generated/prisma/client.js';
import { sha256Hex } from '../../lib/crypto.js';
import { canonicalJson } from './canonicalJson.js';

/** prevHash of the very first event in the chain. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

/** Key for the transaction-scoped advisory lock that serializes chain appends. */
const AUDIT_CHAIN_LOCK_KEY = 0x4c45_4153_4841_4e00n; // "LEASHAN\0"

const HASH_DOMAIN = 'leash-audit-v1';

/** Keys that must never be persisted in audit data, whatever a caller passes. */
const SECRET_KEY_PATTERN =
  /(secret|password|passwd|token|api[-_]?key|keyhash|authorization|cookie)/i;

export interface AuditInput {
  actorType: ActorType;
  actorId?: string | null;
  /** Owner whose audit trail this belongs to. */
  userId?: string | null;
  transactionId?: string | null;
  /** Dotted, lower-case verb, e.g. "agent_key.revoked". */
  action: string;
  data?: Record<string, unknown>;
}

interface HashedFields {
  prevHash: string;
  id: string;
  userId: string | null;
  transactionId: string | null;
  actorType: string;
  actorId: string | null;
  action: string;
  data: unknown;
  createdAt: string;
}

export function computeAuditHash(fields: HashedFields): string {
  return sha256Hex(`${HASH_DOMAIN}\n${canonicalJson(fields)}`);
}

/**
 * Makes `data` safe and stable to store: JSON round-trip (drops undefined,
 * serializes dates), strips NUL characters (rejected by jsonb), and redacts
 * any secret-looking keys as a last line of defence.
 */
export function sanitizeAuditData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const roundTripped = JSON.parse(JSON.stringify(data ?? {})) as unknown;
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll('\u0000', '');
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : scrub(v),
        ]),
      );
    }
    return value;
  };
  return scrub(roundTripped) as Record<string, unknown>;
}

/**
 * Appends an event to the global hash chain. MUST be called inside the same
 * database transaction as the action it records, so either both persist or
 * neither does. The advisory lock is held until that transaction ends, which
 * makes "read last hash → insert next" atomic across concurrent writers.
 * Call it as the last step of the transaction to keep the lock short.
 */
export async function appendAuditEvent(
  tx: Prisma.TransactionClient,
  input: AuditInput,
): Promise<AuditEvent> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`;

  const last = await tx.auditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
  const prevHash = last?.hash ?? AUDIT_GENESIS_HASH;
  const id = randomUUID();
  const createdAt = new Date();
  const data = sanitizeAuditData(input.data);
  const fields: HashedFields = {
    prevHash,
    id,
    userId: input.userId ?? null,
    transactionId: input.transactionId ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    data,
    createdAt: createdAt.toISOString(),
  };

  return tx.auditEvent.create({
    data: {
      id,
      userId: fields.userId,
      transactionId: fields.transactionId,
      actorType: input.actorType,
      actorId: fields.actorId,
      action: input.action,
      data: data as Prisma.InputJsonObject,
      prevHash,
      hash: computeAuditHash(fields),
      createdAt,
    },
  });
}

/** Convenience wrapper for events that are not part of a larger write. */
export function recordAuditEvent(db: Database, input: AuditInput): Promise<AuditEvent> {
  return db.$transaction((tx) => appendAuditEvent(tx, input));
}

export type ChainVerification =
  | { valid: true; checked: number; lastSeq: bigint | null; lastHash: string }
  | {
      valid: false;
      checked: number;
      brokenAtSeq: bigint;
      reason: 'prev_hash_mismatch' | 'hash_mismatch' | 'anchor_not_found';
    };

type ChainReader = Pick<Prisma.TransactionClient, 'auditEvent'>;

/**
 * Recomputes every hash and checks every link, in chain order.
 *
 * By default verification starts at the genesis hash. Passing `fromSeq`
 * treats that event as a trusted anchor and verifies everything after it —
 * used for incremental verification against a previously verified checkpoint.
 *
 * Detects modification, insertion, deletion and reordering of events before
 * the latest one. (Truncating the newest events is only detectable against an
 * externally stored checkpoint — a later-phase addition.)
 */
export async function verifyAuditChain(
  reader: ChainReader,
  options: { fromSeq?: bigint; batchSize?: number } = {},
): Promise<ChainVerification> {
  const batchSize = options.batchSize ?? 500;
  let expectedPrev = AUDIT_GENESIS_HASH;
  let cursor: bigint | undefined;
  let checked = 0;
  let lastSeq: bigint | null = null;

  if (options.fromSeq !== undefined) {
    const anchor = await reader.auditEvent.findUnique({ where: { seq: options.fromSeq } });
    if (!anchor)
      return { valid: false, checked: 0, brokenAtSeq: options.fromSeq, reason: 'anchor_not_found' };
    expectedPrev = anchor.hash;
    cursor = anchor.seq;
    lastSeq = anchor.seq;
  }

  for (;;) {
    const batch = await reader.auditEvent.findMany({
      where: cursor === undefined ? {} : { seq: { gt: cursor } },
      orderBy: { seq: 'asc' },
      take: batchSize,
    });
    if (batch.length === 0) break;

    for (const event of batch) {
      if (event.prevHash !== expectedPrev) {
        return { valid: false, checked, brokenAtSeq: event.seq, reason: 'prev_hash_mismatch' };
      }
      const recomputed = computeAuditHash({
        prevHash: event.prevHash,
        id: event.id,
        userId: event.userId,
        transactionId: event.transactionId,
        actorType: event.actorType,
        actorId: event.actorId,
        action: event.action,
        data: event.data,
        createdAt: event.createdAt.toISOString(),
      });
      if (recomputed !== event.hash) {
        return { valid: false, checked, brokenAtSeq: event.seq, reason: 'hash_mismatch' };
      }
      expectedPrev = event.hash;
      lastSeq = event.seq;
      checked++;
    }
    cursor = batch[batch.length - 1]!.seq;
  }

  return { valid: true, checked, lastSeq, lastHash: expectedPrev };
}

export function toAuditEventDto(event: AuditEvent): AuditEventDto {
  return {
    id: event.id,
    seq: event.seq.toString(),
    actorType: event.actorType,
    actorId: event.actorId,
    action: event.action,
    transactionId: event.transactionId,
    data: (event.data ?? {}) as Record<string, unknown>,
    prevHash: event.prevHash,
    hash: event.hash,
    createdAt: event.createdAt.toISOString(),
  };
}
