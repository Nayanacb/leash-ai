import type {
  CreateMerchantInput,
  MerchantCategory,
  MerchantDto,
  UpdateMerchantInput,
} from '@leash/shared';
import type { Database } from '../../db.js';
import type { Merchant } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/prismaErrors.js';
import type { Actor } from '../agents/agents.service.js';
import { appendAuditEvent } from '../audit/auditLog.js';

export function toMerchantDto(m: Merchant): MerchantDto {
  return {
    id: m.id,
    displayName: m.displayName,
    paypalEmail: m.paypalEmail,
    paypalMerchantId: m.paypalMerchantId,
    domain: m.domain,
    category: m.category as MerchantCategory,
    archived: m.archivedAt !== null,
    archivedAt: m.archivedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

function duplicate(): AppError {
  return new AppError(
    409,
    'MERCHANT_EXISTS',
    'You already registered a merchant with this PayPal email',
  );
}

export async function listMerchants(
  db: Database,
  userId: string,
  includeArchived: boolean,
): Promise<MerchantDto[]> {
  const merchants = await db.merchant.findMany({
    where: { userId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { displayName: 'asc' }],
  });
  return merchants.map(toMerchantDto);
}

export async function getMerchant(db: Database, userId: string, id: string): Promise<MerchantDto> {
  const merchant = await db.merchant.findFirst({ where: { id, userId } });
  if (!merchant) throw AppError.notFound('Merchant not found');
  return toMerchantDto(merchant);
}

export async function createMerchant(
  db: Database,
  actor: Actor,
  input: CreateMerchantInput,
): Promise<MerchantDto> {
  try {
    const merchant = await db.$transaction(async (tx) => {
      const created = await tx.merchant.create({
        data: {
          userId: actor.userId,
          displayName: input.displayName,
          paypalEmail: input.paypalEmail,
          paypalMerchantId: input.paypalMerchantId ?? null,
          domain: input.domain ?? null,
          category: input.category,
        },
      });
      await appendAuditEvent(tx, {
        actorType: 'USER',
        actorId: actor.userId,
        userId: actor.userId,
        action: 'merchant.created',
        data: { merchantId: created.id, ...input, ...actor.meta },
      });
      return created;
    });
    return toMerchantDto(merchant);
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate();
    throw err;
  }
}

const EDITABLE_FIELDS = [
  'displayName',
  'paypalEmail',
  'paypalMerchantId',
  'domain',
  'category',
] as const;

/**
 * Updates are audited field by field (before → after). Changing the PayPal
 * email changes who gets paid, so it is called out explicitly.
 */
export async function updateMerchant(
  db: Database,
  actor: Actor,
  id: string,
  patch: UpdateMerchantInput,
): Promise<MerchantDto> {
  try {
    const merchant = await db.$transaction(async (tx) => {
      const current = await tx.merchant.findFirst({ where: { id, userId: actor.userId } });
      if (!current) throw AppError.notFound('Merchant not found');

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const data: Record<string, unknown> = {};
      for (const field of EDITABLE_FIELDS) {
        const next = patch[field];
        if (next !== undefined && next !== current[field]) {
          changes[field] = { from: current[field], to: next };
          data[field] = next;
        }
      }
      const archiveChange =
        patch.archived === undefined || patch.archived === (current.archivedAt !== null)
          ? null
          : patch.archived;
      if (archiveChange !== null) data.archivedAt = archiveChange ? new Date() : null;

      if (Object.keys(data).length === 0) return current;
      const updated = await tx.merchant.update({ where: { id: current.id }, data });

      if (Object.keys(changes).length > 0) {
        await appendAuditEvent(tx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          action: 'merchant.updated',
          data: { merchantId: id, changes, payeeChanged: 'paypalEmail' in changes, ...actor.meta },
        });
      }
      if (archiveChange !== null) {
        await appendAuditEvent(tx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          action: archiveChange ? 'merchant.archived' : 'merchant.restored',
          data: { merchantId: id, ...actor.meta },
        });
      }
      return updated;
    });
    return toMerchantDto(merchant);
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate();
    throw err;
  }
}
