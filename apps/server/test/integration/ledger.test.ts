import type { PolicyDocument, PolicyRule } from '@leash/shared';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  periodSpend,
  releaseReservation,
  reserveForPurchase,
  type ReservationRequest,
} from '../../src/modules/budget/ledger.js';
import { verifyAuditChain } from '../../src/modules/audit/auditLog.js';
import { db, makeApp, UserClient } from './harness.js';

const { app } = makeApp();
const LIMITS = { sandboxMaxTransactionMinor: 50_000 };

async function activatePolicy(
  userId: string,
  rules: PolicyRule[],
  overrides: Partial<PolicyDocument> = {},
) {
  const document: PolicyDocument = {
    dslVersion: 1,
    currency: 'USD',
    timezone: 'UTC',
    rules,
    ...overrides,
  };
  const latest = await db().policyVersion.findFirst({
    where: { userId },
    orderBy: { version: 'desc' },
  });
  await db().policyVersion.updateMany({
    where: { userId, status: 'ACTIVE' },
    data: { status: 'SUPERSEDED' },
  });
  return db().policyVersion.create({
    data: {
      userId,
      version: (latest?.version ?? 0) + 1,
      status: 'ACTIVE',
      sourceText: 'test',
      compiledRules: document,
      rulesHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      compilerModel: 'test',
      promptVersion: 'test',
      confirmedAt: new Date(),
    },
  });
}

async function setup(budget = '500.00') {
  const user = await UserClient.register(app);
  const agent = await user.createAgent();
  const merchant = await user.createMerchant();
  const task = await user.createTask({ agentId: agent.id, merchantIds: [merchant.id], budget });
  const request = (o: Partial<ReservationRequest> = {}): ReservationRequest => ({
    userId: user.user.id,
    agentId: agent.id,
    taskId: task.id,
    merchantId: merchant.id,
    idempotencyKey: randomUUID(),
    requestHash: 'hash',
    amountMinor: 1000,
    currency: 'USD',
    itemDescription: 'USB-C cable',
    quantity: 1,
    ...o,
  });
  return { user, agent, merchant, task, request };
}

describe('reservations', () => {
  it('blocks everything when no policy is active, without reserving', async () => {
    const { request } = await setup();
    const result = await reserveForPurchase(db(), request(), LIMITS);
    expect(result).toMatchObject({
      policyDecision: 'BLOCK',
      reasonCodes: ['NO_ACTIVE_POLICY'],
      reservedMinor: 0,
    });
    const tx = await db().transaction.findUniqueOrThrow({
      where: { id: result.transactionId },
      include: { ledgerEntries: true },
    });
    expect(tx).toMatchObject({ status: 'BLOCKED', decision: 'BLOCK' });
    expect(tx.ledgerEntries).toEqual([]);
  });

  it('reserves an allowed purchase, records the evaluation, and audits it', async () => {
    const { user, request } = await setup();
    await activatePolicy(user.user.id, [
      { id: 'cap', type: 'max_amount_per_transaction', amountMinor: 5000, action: 'BLOCK' },
    ]);
    const result = await reserveForPurchase(db(), request({ amountMinor: 1999 }), LIMITS);
    expect(result).toMatchObject({ policyDecision: 'ALLOW', reservedMinor: 1999, replayed: false });

    const tx = await db().transaction.findUniqueOrThrow({
      where: { id: result.transactionId },
      include: { ledgerEntries: true, evaluations: true },
    });
    expect(tx.status).toBe('EVALUATING');
    expect(tx.decision).toBeNull(); // final decision waits for the AI layers
    expect(tx.ledgerEntries.map((l) => [l.type, l.amountMinor])).toEqual([['RESERVE', 1999]]);
    expect(tx.evaluations[0]).toMatchObject({ layer: 'POLICY', verdict: 'PASS' });
    const audit = await db().auditEvent.findFirstOrThrow({ where: { transactionId: tx.id } });
    expect(audit).toMatchObject({ action: 'purchase.policy_evaluated', actorType: 'AGENT' });
  });

  it('reserves ESCALATE outcomes too (funds are held while a human decides)', async () => {
    const { user, request } = await setup();
    await activatePolicy(user.user.id, [
      { id: 'ask', type: 'max_amount_per_transaction', amountMinor: 500, action: 'ESCALATE' },
    ]);
    expect(await reserveForPurchase(db(), request(), LIMITS)).toMatchObject({
      policyDecision: 'ESCALATE',
      reservedMinor: 1000,
    });
  });

  it('is idempotent per agent + key, and rejects a reused key with a different payload', async () => {
    const { user, request } = await setup();
    await activatePolicy(user.user.id, []);
    const req = request();
    const first = await reserveForPurchase(db(), req, LIMITS);
    const replay = await reserveForPurchase(db(), req, LIMITS);
    expect(replay).toMatchObject({
      transactionId: first.transactionId,
      replayed: true,
      reservedMinor: 1000,
    });
    expect(await db().ledgerEntry.count({ where: { transactionId: first.transactionId } })).toBe(1);
    await expect(
      reserveForPurchase(db(), { ...req, requestHash: 'different' }, LIMITS),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('refuses tasks belonging to another agent or user, and unknown merchants', async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      reserveForPurchase(db(), a.request({ taskId: b.task.id }), LIMITS),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(
      reserveForPurchase(db(), a.request({ merchantId: b.merchant.id }), LIMITS),
    ).rejects.toMatchObject({
      code: 'MERCHANT_NOT_FOUND',
    });
    const sibling = await a.user.createAgent('sibling');
    await expect(
      reserveForPurchase(db(), a.request({ agentId: sibling.id }), LIMITS),
    ).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });
});

describe('weekly and monthly budgets', () => {
  it('tracks committed spend per calendar period and enforces the weekly limit', async () => {
    const { user, request } = await setup();
    await activatePolicy(user.user.id, [
      {
        id: 'week',
        type: 'max_spend_per_period',
        period: 'week',
        amountMinor: 5000,
        action: 'BLOCK',
      },
      {
        id: 'month',
        type: 'max_spend_per_period',
        period: 'month',
        amountMinor: 20_000,
        action: 'ESCALATE',
      },
    ]);
    const wed = new Date('2026-11-11T12:00:00Z');
    await reserveForPurchase(db(), request({ amountMinor: 3000, at: wed }), LIMITS);
    await reserveForPurchase(db(), request({ amountMinor: 2000, at: wed }), LIMITS);
    // The week is now exactly at its 50.00 limit.
    expect(await periodSpend(db(), user.user.id, 'USD', 'UTC', wed)).toMatchObject({
      week: { committedMinor: 5000, transactionCount: 2 },
      month: { committedMinor: 5000, transactionCount: 2 },
    });
    const over = await reserveForPurchase(db(), request({ amountMinor: 1, at: wed }), LIMITS);
    expect(over).toMatchObject({ policyDecision: 'BLOCK', reasonCodes: ['PERIOD_SPEND_LIMIT'] });

    // Next Monday is a new week, but the month still remembers.
    const nextMonday = new Date('2026-11-16T00:00:00Z');
    expect(await periodSpend(db(), user.user.id, 'USD', 'UTC', nextMonday)).toMatchObject({
      week: { committedMinor: 0 },
      month: { committedMinor: 5000 },
    });
    expect(
      (await reserveForPurchase(db(), request({ amountMinor: 4000, at: nextMonday }), LIMITS))
        .policyDecision,
    ).toBe('ALLOW');
  });

  it('released reservations no longer count, and release is idempotent', async () => {
    const { user, request } = await setup();
    await activatePolicy(user.user.id, [
      {
        id: 'week',
        type: 'max_spend_per_period',
        period: 'week',
        amountMinor: 1000,
        action: 'BLOCK',
      },
    ]);
    const at = new Date('2026-11-11T12:00:00Z');
    const first = await reserveForPurchase(db(), request({ amountMinor: 1000, at }), LIMITS);
    expect(
      (await reserveForPurchase(db(), request({ amountMinor: 1000, at }), LIMITS)).policyDecision,
    ).toBe('BLOCK');

    const actor = { type: 'SYSTEM' as const, id: null };
    expect(
      await releaseReservation(db(), {
        userId: user.user.id,
        transactionId: first.transactionId,
        reason: 'test',
        actor,
      }),
    ).toEqual({
      releasedMinor: 1000,
    });
    expect(
      await releaseReservation(db(), {
        userId: user.user.id,
        transactionId: first.transactionId,
        reason: 'again',
        actor,
      }),
    ).toEqual({
      releasedMinor: 0,
    });
    expect((await periodSpend(db(), user.user.id, 'USD', 'UTC', at)).week).toEqual({
      committedMinor: 0,
      transactionCount: 0,
    });
    expect(
      (await reserveForPurchase(db(), request({ amountMinor: 1000, at }), LIMITS)).policyDecision,
    ).toBe('ALLOW');
  });

  it('attributes spend to the policy time zone’s calendar', async () => {
    const { user, request } = await setup();
    await activatePolicy(user.user.id, [], { timezone: 'America/Los_Angeles' });
    // 2026-11-02 05:00 UTC is still Sunday 1 Nov in Los Angeles: last week, not this one.
    await reserveForPurchase(db(), request({ at: new Date('2026-11-02T05:00:00Z') }), LIMITS);
    const mondayLA = new Date('2026-11-02T18:00:00Z');
    expect(
      (await periodSpend(db(), user.user.id, 'USD', 'America/Los_Angeles', mondayLA)).week
        .committedMinor,
    ).toBe(0);
    expect(
      (await periodSpend(db(), user.user.id, 'USD', 'UTC', mondayLA)).week.committedMinor,
    ).toBe(1000);
  });

  it('counts transactions per period and enforces task budgets', async () => {
    const { user, request } = await setup('35.00');
    await activatePolicy(user.user.id, [
      { id: 'n', type: 'max_transactions_per_period', period: 'day', count: 2, action: 'ESCALATE' },
    ]);
    const at = new Date('2026-11-11T12:00:00Z');
    expect((await reserveForPurchase(db(), request({ at }), LIMITS)).policyDecision).toBe('ALLOW');
    expect((await reserveForPurchase(db(), request({ at }), LIMITS)).policyDecision).toBe('ALLOW');
    const third = await reserveForPurchase(db(), request({ at }), LIMITS);
    expect(third).toMatchObject({
      policyDecision: 'ESCALATE',
      reasonCodes: ['PERIOD_TRANSACTION_LIMIT'],
    });
    // 30.00 reserved of a 35.00 task budget: 5.00 fits, 5.01 does not.
    expect(
      (await reserveForPurchase(db(), request({ at, amountMinor: 501 }), LIMITS)).reasonCodes,
    ).toContain('TASK_BUDGET_EXCEEDED');
    expect(
      (await reserveForPurchase(db(), request({ at, amountMinor: 500 }), LIMITS)).reasonCodes,
    ).not.toContain('TASK_BUDGET_EXCEEDED');
  });

  it('flags duplicates within the window but not failed attempts', async () => {
    const { user, request } = await setup();
    await activatePolicy(user.user.id, [
      { id: 'dup', type: 'duplicate_window', minutes: 30, action: 'ESCALATE' },
    ]);
    const t0 = new Date('2026-11-11T12:00:00Z');
    const first = await reserveForPurchase(db(), request({ at: t0 }), LIMITS);
    const dup = await reserveForPurchase(
      db(),
      request({ at: new Date(t0.getTime() + 10 * 60_000) }),
      LIMITS,
    );
    expect(dup.reasonCodes).toEqual(['DUPLICATE_PURCHASE']);
    expect(
      (await reserveForPurchase(db(), request({ at: t0, amountMinor: 1001 }), LIMITS))
        .policyDecision,
    ).toBe('ALLOW');

    const actor = { type: 'SYSTEM' as const, id: null };
    await releaseReservation(db(), {
      userId: user.user.id,
      transactionId: first.transactionId,
      reason: 'x',
      actor,
    });
    await releaseReservation(db(), {
      userId: user.user.id,
      transactionId: dup.transactionId,
      reason: 'x',
      actor,
    });
    expect(
      (
        await reserveForPurchase(
          db(),
          request({ at: new Date(t0.getTime() + 11 * 60_000) }),
          LIMITS,
        )
      ).policyDecision,
    ).toBe('ALLOW');
  });
});

describe('concurrency', () => {
  it('parallel purchases can never jointly exceed a weekly limit', async () => {
    const { user, request } = await setup();
    await activatePolicy(user.user.id, [
      {
        id: 'week',
        type: 'max_spend_per_period',
        period: 'week',
        amountMinor: 10_000,
        action: 'BLOCK',
      },
    ]);
    const at = new Date('2026-11-11T12:00:00Z');
    // 25 × 10.00 against a 100.00 weekly limit, all at once.
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        reserveForPurchase(db(), request({ amountMinor: 1000, at }), LIMITS),
      ),
    );
    expect(results.filter((r) => r.policyDecision === 'ALLOW')).toHaveLength(10);
    expect(results.filter((r) => r.policyDecision === 'BLOCK')).toHaveLength(15);
    expect((await periodSpend(db(), user.user.id, 'USD', 'UTC', at)).week.committedMinor).toBe(
      10_000,
    );
  });

  it('parallel purchases can never jointly exceed a task budget (uneven amounts)', async () => {
    const { user, request } = await setup('100.00');
    await activatePolicy(user.user.id, []);
    const amounts = [3700, 2900, 4100, 1800, 2500, 3300, 900, 4600, 2200, 1500, 3800, 2700];
    const results = await Promise.all(
      amounts.map((amountMinor) => reserveForPurchase(db(), request({ amountMinor }), LIMITS)),
    );
    const reserved = results.reduce((sum, r) => sum + r.reservedMinor, 0);
    expect(reserved).toBeLessThanOrEqual(10_000);
    // Every blocked purchase really would not have fit at the moment it was evaluated.
    expect(results.some((r) => r.policyDecision === 'BLOCK')).toBe(true);
  });

  it('parallel releases and reservations keep the ledger consistent', async () => {
    const { user, request } = await setup();
    await activatePolicy(user.user.id, [
      {
        id: 'week',
        type: 'max_spend_per_period',
        period: 'week',
        amountMinor: 5000,
        action: 'BLOCK',
      },
    ]);
    const at = new Date('2026-11-11T12:00:00Z');
    const initial = await Promise.all(
      Array.from({ length: 5 }, () =>
        reserveForPurchase(db(), request({ amountMinor: 1000, at }), LIMITS),
      ),
    );
    const actor = { type: 'SYSTEM' as const, id: null };
    await Promise.all([
      ...initial.map((r) =>
        releaseReservation(db(), {
          userId: user.user.id,
          transactionId: r.transactionId,
          reason: 'parallel',
          actor,
        }),
      ),
      // Double-release attempts racing the first ones.
      ...initial.map((r) =>
        releaseReservation(db(), {
          userId: user.user.id,
          transactionId: r.transactionId,
          reason: 'parallel',
          actor,
        }),
      ),
      ...Array.from({ length: 10 }, () =>
        reserveForPurchase(db(), request({ amountMinor: 1000, at }), LIMITS),
      ),
    ]);

    // Ledger invariant: never more released than reserved, for every transaction.
    const rows = await db().$queryRaw<{ id: string; reserved: bigint; released: bigint }[]>`
      SELECT t."id",
             COALESCE(SUM(l."amountMinor") FILTER (WHERE l."type" = 'RESERVE'), 0)::bigint AS reserved,
             COALESCE(SUM(l."amountMinor") FILTER (WHERE l."type" = 'RELEASE'), 0)::bigint AS released
        FROM "Transaction" t LEFT JOIN "LedgerEntry" l ON l."transactionId" = t."id"
       WHERE t."userId" = ${user.user.id}::uuid
       GROUP BY t."id"`;
    for (const r of rows) expect(Number(r.released)).toBeLessThanOrEqual(Number(r.reserved));
    expect(
      (await periodSpend(db(), user.user.id, 'USD', 'UTC', at)).week.committedMinor,
    ).toBeLessThanOrEqual(5000);
  });

  it('different users do not block each other, and the audit chain stays valid', async () => {
    const users = await Promise.all(Array.from({ length: 4 }, () => setup()));
    await Promise.all(users.map((u) => activatePolicy(u.user.user.id, [])));
    const results = await Promise.all(
      users.flatMap((u) =>
        Array.from({ length: 5 }, () => reserveForPurchase(db(), u.request(), LIMITS)),
      ),
    );
    expect(results.every((r) => r.policyDecision === 'ALLOW')).toBe(true);
    expect((await verifyAuditChain(db())).valid).toBe(true);
  });
});
