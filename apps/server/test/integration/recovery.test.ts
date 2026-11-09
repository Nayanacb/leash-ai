import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { startBackgroundJobs } from '../../src/jobs/scheduler.js';
import { verifyAuditChain } from '../../src/modules/audit/auditLog.js';
import {
  lockUserBudget,
  periodSpend,
  reserveForPurchase,
} from '../../src/modules/budget/ledger.js';
import {
  expireStuckEvaluations,
  reconcileOrphanedReservations,
  sweepReservations,
} from '../../src/modules/budget/recovery.js';
import { captureLogger, testConfig } from '../helpers.js';
import { db, makeApp, UserClient } from './harness.js';
import { testDatabaseUrl } from './testDatabase.js';

const { app } = makeApp();
const LIMITS = { sandboxMaxTransactionMinor: 50_000 };
const TIMEOUT_MS = 120_000;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function setup() {
  const user = await UserClient.register(app);
  const agent = await user.createAgent();
  const merchant = await user.createMerchant();
  const task = await user.createTask({
    agentId: agent.id,
    merchantIds: [merchant.id],
    budget: '400.00',
  });
  await db().policyVersion.create({
    data: {
      userId: user.user.id,
      version: 1,
      status: 'ACTIVE',
      sourceText: 'test',
      compiledRules: { dslVersion: 1, currency: 'USD', timezone: 'UTC', rules: [] },
      rulesHash: '0'.repeat(64),
      compilerModel: 'test',
      promptVersion: 'test',
      confirmedAt: new Date(),
    },
  });
  const reserve = (at: Date, amountMinor = 1000) =>
    reserveForPurchase(
      db(),
      {
        userId: user.user.id,
        agentId: agent.id,
        taskId: task.id,
        merchantId: merchant.id,
        idempotencyKey: randomUUID(),
        requestHash: 'h',
        amountMinor,
        currency: 'USD',
        itemDescription: 'x',
        quantity: 1,
        at,
      },
      LIMITS,
    );
  return { user, reserve };
}

async function ledgerOf(transactionId: string) {
  return (
    await db().ledgerEntry.findMany({ where: { transactionId }, orderBy: { createdAt: 'asc' } })
  ).map((l) => [l.type, l.amountMinor]);
}

describe('expiring stuck evaluations', () => {
  it('expires an overdue EVALUATING purchase, releases its funds and audits both', async () => {
    const { user, reserve } = await setup();
    const stuck = await reserve(minutesAgo(10), 2500);
    expect(
      (await periodSpend(db(), user.user.id, 'USD', 'UTC', new Date())).day.committedMinor,
    ).toBe(2500);

    const result = await expireStuckEvaluations(db(), { timeoutMs: TIMEOUT_MS });
    expect(result.expired).toContain(stuck.transactionId);

    const tx = await db().transaction.findUniqueOrThrow({ where: { id: stuck.transactionId } });
    expect(tx.status).toBe('EXPIRED');
    expect(tx.reasonCodes).toContain('EVALUATION_TIMEOUT');
    expect(await ledgerOf(stuck.transactionId)).toEqual([
      ['RESERVE', 2500],
      ['RELEASE', 2500],
    ]);
    expect(
      (await periodSpend(db(), user.user.id, 'USD', 'UTC', new Date())).day.committedMinor,
    ).toBe(0);

    const audit = await db().auditEvent.findMany({
      where: { transactionId: stuck.transactionId },
      orderBy: { seq: 'asc' },
    });
    expect(audit.map((e) => [e.action, e.actorType])).toEqual([
      ['purchase.policy_evaluated', 'AGENT'],
      ['purchase.reservation_released', 'SYSTEM'],
      ['purchase.evaluation_expired', 'SYSTEM'],
    ]);
    expect(audit[2]!.data).toMatchObject({ timeoutSeconds: 120, releasedMinor: 2500 });
  });

  it('leaves evaluations that are still within the timeout alone', async () => {
    const { reserve } = await setup();
    const fresh = await reserve(new Date());
    await expireStuckEvaluations(db(), { timeoutMs: TIMEOUT_MS });
    expect(
      (await db().transaction.findUniqueOrThrow({ where: { id: fresh.transactionId } })).status,
    ).toBe('EVALUATING');
    expect(await ledgerOf(fresh.transactionId)).toEqual([['RESERVE', 1000]]);
  });

  it('never touches purchases in other states', async () => {
    const { reserve } = await setup();
    const old = await reserve(minutesAgo(30));
    await db().transaction.update({
      where: { id: old.transactionId },
      data: { status: 'AUTHORIZED' },
    });
    await expireStuckEvaluations(db(), { timeoutMs: TIMEOUT_MS });
    expect(
      (await db().transaction.findUniqueOrThrow({ where: { id: old.transactionId } })).status,
    ).toBe('AUTHORIZED');
    expect(await ledgerOf(old.transactionId)).toEqual([['RESERVE', 1000]]);
  });

  it('is idempotent', async () => {
    const { reserve } = await setup();
    const stuck = await reserve(minutesAgo(10));
    await expireStuckEvaluations(db(), { timeoutMs: TIMEOUT_MS });
    const second = await expireStuckEvaluations(db(), { timeoutMs: TIMEOUT_MS });
    expect(second.expired).not.toContain(stuck.transactionId);
    expect(await ledgerOf(stuck.transactionId)).toEqual([
      ['RESERVE', 1000],
      ['RELEASE', 1000],
    ]);
  });
});

describe('concurrency', () => {
  /** What the Phase 5 pipeline will do when evaluation finishes: CAS out of EVALUATING under the budget lock. */
  async function finishEvaluation(userId: string, transactionId: string): Promise<boolean> {
    return db().$transaction(async (tx) => {
      await lockUserBudget(tx, userId);
      const { count } = await tx.transaction.updateMany({
        where: { id: transactionId, status: 'EVALUATING' },
        data: { status: 'AUTHORIZED', decision: 'ALLOW' },
      });
      return count === 1;
    });
  }

  it('a sweep racing the evaluation’s own completion: exactly one wins, funds stay consistent', async () => {
    const { user, reserve } = await setup();
    const stuck = await Promise.all(Array.from({ length: 12 }, () => reserve(minutesAgo(10))));
    const [, ...finished] = await Promise.all([
      expireStuckEvaluations(db(), { timeoutMs: TIMEOUT_MS }),
      ...stuck.map((s) => finishEvaluation(user.user.id, s.transactionId)),
    ]);

    for (const [i, s] of stuck.entries()) {
      const tx = await db().transaction.findUniqueOrThrow({ where: { id: s.transactionId } });
      const ledger = await ledgerOf(s.transactionId);
      if (finished[i]) {
        // Evaluation won: still funded, never released.
        expect(tx.status).toBe('AUTHORIZED');
        expect(ledger).toEqual([['RESERVE', 1000]]);
      } else {
        // Sweep won: expired and released exactly once.
        expect(tx.status).toBe('EXPIRED');
        expect(ledger).toEqual([
          ['RESERVE', 1000],
          ['RELEASE', 1000],
        ]);
      }
    }
  });

  it('overlapping sweeps (e.g. two server instances) release each reservation exactly once', async () => {
    const { reserve } = await setup();
    const stuck = await Promise.all(Array.from({ length: 8 }, () => reserve(minutesAgo(10))));
    await Promise.all(
      Array.from({ length: 5 }, () => sweepReservations(db(), { evaluationTimeoutMs: TIMEOUT_MS })),
    );
    for (const s of stuck) {
      expect(await ledgerOf(s.transactionId)).toEqual([
        ['RESERVE', 1000],
        ['RELEASE', 1000],
      ]);
    }
    const expiredEvents = await db().auditEvent.count({
      where: {
        action: 'purchase.evaluation_expired',
        transactionId: { in: stuck.map((s) => s.transactionId) },
      },
    });
    expect(expiredEvents).toBe(8);
    expect((await verifyAuditChain(db())).valid).toBe(true);
  });
});

describe('reconciliation safety net', () => {
  it('releases funds still held by a purchase that ended in a never-paid state', async () => {
    const { reserve } = await setup();
    const orphan = await reserve(new Date());
    // Simulate a bug elsewhere: status moved to CANCELLED without releasing.
    await db().transaction.update({
      where: { id: orphan.transactionId },
      data: { status: 'CANCELLED' },
    });

    const result = await reconcileOrphanedReservations(db());
    expect(result.reconciled).toContain(orphan.transactionId);
    expect(await ledgerOf(orphan.transactionId)).toEqual([
      ['RESERVE', 1000],
      ['RELEASE', 1000],
    ]);
    const audit = await db().auditEvent.findFirstOrThrow({
      where: { transactionId: orphan.transactionId, action: 'purchase.reservation_released' },
    });
    expect(audit.data).toMatchObject({ reason: expect.stringContaining('reconciliation') });
  });

  it('does not release funds for purchases that may still be paid', async () => {
    const { reserve } = await setup();
    const evaluating = await reserve(new Date());
    const authorized = await reserve(new Date());
    await db().transaction.update({
      where: { id: authorized.transactionId },
      data: { status: 'AUTHORIZED' },
    });
    await reconcileOrphanedReservations(db());
    expect(await ledgerOf(evaluating.transactionId)).toEqual([['RESERVE', 1000]]);
    expect(await ledgerOf(authorized.transactionId)).toEqual([['RESERVE', 1000]]);
  });
});

describe('background scheduler', () => {
  it('sweeps at startup and on demand, and stops cleanly', async () => {
    const { reserve } = await setup();
    const stuck = await reserve(minutesAgo(10));
    const config = testConfig({
      DATABASE_URL: testDatabaseUrl(),
      RESERVATION_SWEEP_INTERVAL_SECONDS: '3600',
    });
    const jobs = startBackgroundJobs({ db: db(), config, logger: captureLogger().logger });
    await jobs.runNow(); // joins the startup sweep if it is still running
    expect(
      (await db().transaction.findUniqueOrThrow({ where: { id: stuck.transactionId } })).status,
    ).toBe('EXPIRED');
    await jobs.stop();
  });
});
