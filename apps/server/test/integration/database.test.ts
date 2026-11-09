import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, databaseProbe, type Database } from '../../src/db.js';
import { captureLogger, testConfig } from '../helpers.js';
import { testDatabaseUrl } from './testDatabase.js';

let db: Database;

beforeAll(() => {
  db = createDatabase(testDatabaseUrl());
});

afterAll(async () => {
  await db.$disconnect();
});

/** Creates a user with an agent, task and one transaction. Unique per call, so tests never collide. */
async function seedGraph() {
  const user = await db.user.create({
    data: { email: `${randomUUID()}@example.test`, passwordHash: 'not-a-real-hash' },
  });
  const agent = await db.agent.create({ data: { userId: user.id, name: 'test agent' } });
  const task = await db.task.create({
    data: {
      userId: user.id,
      agentId: agent.id,
      instruction: 'Buy a cable',
      budgetMinor: 2000,
      currency: 'USD',
    },
  });
  const transaction = await db.transaction.create({
    data: {
      userId: user.id,
      agentId: agent.id,
      taskId: task.id,
      idempotencyKey: randomUUID(),
      requestHash: 'h',
      amountMinor: 1899,
      currency: 'USD',
      itemDescription: 'USB-C cable',
      quantity: 1,
    },
  });
  return { user, agent, task, transaction };
}

function policyData(userId: string, version: number, status: 'DRAFT' | 'ACTIVE' = 'DRAFT') {
  return {
    userId,
    version,
    status,
    sourceText: 'Never spend more than $50 per purchase',
    compiledRules: {
      rules: [{ type: 'max_amount_per_transaction', amountMinor: 5000, action: 'BLOCK' }],
    },
    rulesHash: `hash-${version}`,
    compilerModel: 'test-model',
    promptVersion: 'v1',
  };
}

describe('database connectivity', () => {
  it('migrations are applied and /readyz reports ready against real Postgres', async () => {
    const app = createApp({
      config: testConfig(),
      logger: captureLogger().logger,
      db: databaseProbe(db),
      version: 'test',
    });
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.checks.database).toBe('ok');
  });
});

describe('append-only tables', () => {
  it('AuditEvent rejects UPDATE, DELETE and TRUNCATE', async () => {
    const event = await db.auditEvent.create({
      data: { actorType: 'SYSTEM', action: 'test.event', prevHash: 'genesis', hash: randomUUID() },
    });
    await expect(
      db.auditEvent.update({ where: { seq: event.seq }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.auditEvent.delete({ where: { seq: event.seq } })).rejects.toThrow(
      /append-only/,
    );
    await expect(db.$executeRawUnsafe('TRUNCATE "AuditEvent"')).rejects.toThrow(/append-only/);
    const still = await db.auditEvent.findUnique({ where: { seq: event.seq } });
    expect(still?.action).toBe('test.event');
  });

  it('LedgerEntry rejects UPDATE and DELETE', async () => {
    const { user, transaction } = await seedGraph();
    const entry = await db.ledgerEntry.create({
      data: {
        userId: user.id,
        transactionId: transaction.id,
        type: 'RESERVE',
        amountMinor: 1899,
        currency: 'USD',
      },
    });
    await expect(
      db.ledgerEntry.update({ where: { id: entry.id }, data: { amountMinor: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
  });
});

describe('policy versions', () => {
  it('allows at most one ACTIVE version per user', async () => {
    const { user } = await seedGraph();
    await db.policyVersion.create({ data: policyData(user.id, 1, 'ACTIVE') });
    await expect(
      db.policyVersion.create({ data: policyData(user.id, 2, 'ACTIVE') }),
    ).rejects.toThrow();
    // A different user may have their own ACTIVE version.
    const other = await seedGraph();
    await expect(
      db.policyVersion.create({ data: policyData(other.user.id, 1, 'ACTIVE') }),
    ).resolves.toBeDefined();
  });

  it('DRAFT versions are editable; confirmed versions are immutable', async () => {
    const { user } = await seedGraph();
    const draft = await db.policyVersion.create({ data: policyData(user.id, 1) });
    await db.policyVersion.update({
      where: { id: draft.id },
      data: { sourceText: 'edited draft' },
    });

    const active = await db.policyVersion.update({
      where: { id: draft.id },
      data: { status: 'ACTIVE', confirmedAt: new Date() },
    });
    await expect(
      db.policyVersion.update({ where: { id: active.id }, data: { compiledRules: { rules: [] } } }),
    ).rejects.toThrow(/immutable/);
    await expect(db.policyVersion.delete({ where: { id: active.id } })).rejects.toThrow(
      /cannot be deleted/,
    );

    // The one permitted transition: ACTIVE → SUPERSEDED with content unchanged.
    const superseded = await db.policyVersion.update({
      where: { id: active.id },
      data: { status: 'SUPERSEDED' },
    });
    expect(superseded.status).toBe('SUPERSEDED');
    await expect(
      db.policyVersion.update({ where: { id: active.id }, data: { status: 'ACTIVE' } }),
    ).rejects.toThrow(/immutable/);
  });
});

describe('money constraints', () => {
  it('rejects non-positive amounts and malformed currencies', async () => {
    const { user, agent, task, transaction } = await seedGraph();
    const base = {
      userId: user.id,
      agentId: agent.id,
      taskId: task.id,
      requestHash: 'h',
      currency: 'USD',
      itemDescription: 'x',
      quantity: 1,
    };
    await expect(
      db.transaction.create({ data: { ...base, idempotencyKey: randomUUID(), amountMinor: 0 } }),
    ).rejects.toThrow();
    await expect(
      db.transaction.create({
        data: { ...base, idempotencyKey: randomUUID(), amountMinor: 100, currency: 'usd' },
      }),
    ).rejects.toThrow();
    await expect(
      db.ledgerEntry.create({
        data: {
          userId: user.id,
          transactionId: transaction.id,
          type: 'RESERVE',
          amountMinor: -5,
          currency: 'USD',
        },
      }),
    ).rejects.toThrow();
  });

  it('refunded amount can never exceed the captured amount', async () => {
    const { transaction } = await seedGraph();
    await db.transaction.update({
      where: { id: transaction.id },
      data: { capturedMinor: 1899, refundedMinor: 1899 },
    });
    await expect(
      db.transaction.update({ where: { id: transaction.id }, data: { refundedMinor: 1900 } }),
    ).rejects.toThrow();
  });

  it('enforces idempotency-key uniqueness per agent', async () => {
    const { user, agent, task, transaction } = await seedGraph();
    await expect(
      db.transaction.create({
        data: {
          userId: user.id,
          agentId: agent.id,
          taskId: task.id,
          idempotencyKey: transaction.idempotencyKey,
          requestHash: 'h2',
          amountMinor: 100,
          currency: 'USD',
          itemDescription: 'dup',
          quantity: 1,
        },
      }),
    ).rejects.toThrow();
  });
});
