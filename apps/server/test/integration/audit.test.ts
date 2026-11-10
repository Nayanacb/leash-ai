import { describe, expect, it } from 'vitest';
import {
  AUDIT_GENESIS_HASH,
  computeAuditHash,
  recordAuditEvent,
  verifyAuditChain,
} from '../../src/modules/audit/auditLog.js';
import { db, makeApp, UserClient } from './harness.js';

const { app } = makeApp();

class Rollback extends Error {}

/** Runs `fn` in a transaction that is always rolled back, so tampering never persists. */
async function inRolledBackTransaction(fn: Parameters<ReturnType<typeof db>['$transaction']>[0]) {
  await expect(
    db().$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

describe('audit log integrity', () => {
  it('starts at genesis and verifies end to end after real activity', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent();
    await user.createKey(agent.id);
    await user.createMerchant();

    const first = await db().auditEvent.findFirstOrThrow({ orderBy: { seq: 'asc' } });
    expect(first.prevHash).toBe(AUDIT_GENESIS_HASH);

    const result = await verifyAuditChain(db());
    expect(result.valid).toBe(true);
    const res = await user.get('/api/v1/audit-events/verify');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, verifiedAt: expect.any(String) });
  });

  it('records who acted, on whose behalf, and when', async () => {
    const before = Date.now();
    const user = await UserClient.register(app);
    const agent = await user.createAgent('Audited');
    const res = await user.get('/api/v1/audit-events?limit=1');
    const [event] = res.body.events;
    expect(event).toMatchObject({
      actorType: 'USER',
      actorId: user.user.id,
      action: 'agent.created',
      data: expect.objectContaining({ agentId: agent.id, name: 'Audited', ip: expect.any(String) }),
    });
    expect(new Date(event.createdAt).getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stays a single linear chain under concurrent writers', async () => {
    const user = await UserClient.register(app);
    await Promise.all([
      ...Array.from({ length: 40 }, (_, i) =>
        recordAuditEvent(db(), { actorType: 'SYSTEM', action: 'test.concurrent', data: { i } }),
      ),
      // Real API writes interleaved with direct appends.
      ...Array.from({ length: 10 }, (_, i) =>
        user.post('/api/v1/agents', { name: `parallel ${i}` }),
      ),
    ]);

    const result = await verifyAuditChain(db());
    expect(result.valid).toBe(true);

    // No fork: every prevHash is used exactly once.
    const events = await db().auditEvent.findMany({ select: { prevHash: true } });
    expect(new Set(events.map((e) => e.prevHash)).size).toBe(events.length);
  });

  it('detects a modified event', async () => {
    await recordAuditEvent(db(), {
      actorType: 'SYSTEM',
      action: 'test.target',
      data: { amount: 100 },
    });
    await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only"',
      );
      await tx.$executeRawUnsafe(
        `UPDATE "AuditEvent" SET "data" = '{"amount": 1}' WHERE "seq" = (SELECT max("seq") FROM "AuditEvent" WHERE "action" = 'test.target')`,
      );
      const result = await verifyAuditChain(tx);
      expect(result).toMatchObject({ valid: false, reason: 'hash_mismatch' });
    });
    expect((await verifyAuditChain(db())).valid).toBe(true);
  });

  it('detects a deleted event', async () => {
    await recordAuditEvent(db(), { actorType: 'SYSTEM', action: 'test.victim' });
    await recordAuditEvent(db(), { actorType: 'SYSTEM', action: 'test.after' });
    await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_append_only"',
      );
      await tx.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE "action" = 'test.victim'`);
      const result = await verifyAuditChain(tx);
      expect(result).toMatchObject({ valid: false, reason: 'prev_hash_mismatch' });
    });
  });

  it('detects a forged event inserted with a self-consistent-looking hash', async () => {
    await inRolledBackTransaction(async (tx) => {
      const last = await tx.auditEvent.findFirstOrThrow({ orderBy: { seq: 'desc' } });
      // Forger links to the real chain but cannot make the *next* real event point at it.
      const forged = {
        prevHash: last.prevHash,
        id: '00000000-0000-4000-8000-000000000000',
        userId: null,
        transactionId: null,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'test.forged',
        data: {},
        createdAt: new Date().toISOString(),
      };
      await tx.$executeRawUnsafe(
        `INSERT INTO "AuditEvent" ("seq","id","actorType","action","data","prevHash","hash","createdAt")
         VALUES ($1, $2::uuid, 'SYSTEM', 'test.forged', '{}', $3, $4, $5::timestamptz)`,
        -1,
        forged.id,
        forged.prevHash,
        computeAuditHash(forged),
        forged.createdAt,
      );
      const result = await verifyAuditChain(tx);
      expect(result.valid).toBe(false);
    });
  });

  it('supports incremental verification from a trusted anchor', async () => {
    const anchor = await recordAuditEvent(db(), { actorType: 'SYSTEM', action: 'test.anchor' });
    await recordAuditEvent(db(), { actorType: 'SYSTEM', action: 'test.next' });
    const result = await verifyAuditChain(db(), { fromSeq: anchor.seq });
    expect(result).toMatchObject({ valid: true, checked: 1 });
    expect(await verifyAuditChain(db(), { fromSeq: 999_999_999n })).toMatchObject({
      valid: false,
      reason: 'anchor_not_found',
    });
  });

  it('paginates the user’s own events, newest first', async () => {
    const user = await UserClient.register(app);
    for (let i = 0; i < 3; i++) await user.createAgent(`a${i}`);
    const page1 = await user.get('/api/v1/audit-events?limit=2');
    expect(page1.body.events.map((e: { action: string }) => e.action)).toEqual([
      'agent.created',
      'agent.created',
    ]);
    expect(page1.body.nextBefore).toEqual(expect.any(String));
    const page2 = await user.get(`/api/v1/audit-events?limit=2&before=${page1.body.nextBefore}`);
    expect(page2.body.events.map((e: { action: string }) => e.action)).toEqual([
      'agent.created',
      'user.registered',
    ]);
    expect(page2.body.nextBefore).toBeNull();
    const filtered = await user.get('/api/v1/audit-events?action=user.');
    expect(filtered.body.events.map((e: { action: string }) => e.action)).toEqual([
      'user.registered',
    ]);
  });

  it('cannot be altered through the database even by the application role', async () => {
    const event = await recordAuditEvent(db(), { actorType: 'SYSTEM', action: 'test.locked' });
    await expect(
      db().auditEvent.update({ where: { seq: event.seq }, data: { action: 'x' } }),
    ).rejects.toThrow(/append-only/);
  });
});
