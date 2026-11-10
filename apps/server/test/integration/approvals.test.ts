import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../src/modules/audit/auditLog.js';
import { expireOverdueApprovals } from '../../src/modules/budget/recovery.js';
import { asAgent, db, makeApp, PASSWORD, UserClient } from './harness.js';
import { FakeEvaluators, setupPurchaser } from './purchaseHarness.js';

const ai = new FakeEvaluators();
const { app } = makeApp({ purchaseEvaluators: ai });

const ASK_FOR_NEW_MERCHANTS = [{ id: 'ask', type: 'new_merchant', action: 'ESCALATE' }];

async function ledger(transactionId: string) {
  return (
    await db().ledgerEntry.findMany({ where: { transactionId }, orderBy: { createdAt: 'asc' } })
  ).map((l) => [l.type, l.amountMinor]);
}

/** A purchaser with one escalated (PENDING_APPROVAL) purchase. */
async function escalated(
  rules: unknown[] = ASK_FOR_NEW_MERCHANTS,
  overrides: Record<string, unknown> = {},
  budget = '400.00',
) {
  const s = await setupPurchaser(app, rules, budget);
  const res = await s.purchase(overrides);
  expect(res.body.status).toBe('PENDING_APPROVAL');
  const detail = (await s.user.get(`/api/v1/transactions/${res.body.id}`)).body;
  return {
    ...s,
    transactionId: res.body.id as string,
    approvalId: detail.approval.id as string,
    snapshotHash: detail.approval.snapshotHash as string,
  };
}

const stepUp = (user: UserClient, password = PASSWORD) =>
  user.post('/api/v1/auth/step-up', { password });
const approve = (user: UserClient, approvalId: string, body: object) =>
  user.post(`/api/v1/approvals/${approvalId}/approve`, body);
const reject = (user: UserClient, approvalId: string, body: object = {}) =>
  user.post(`/api/v1/approvals/${approvalId}/reject`, body);

describe('step-up re-authentication', () => {
  it('confirms the password, opens a window on this session only, and is audited', async () => {
    const user = await UserClient.register(app);
    expect((await user.get('/api/v1/auth/session')).body.stepUpExpiresAt).toBeNull();

    const wrong = await stepUp(user, 'not my password');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_PASSWORD');

    const ok = await stepUp(user);
    expect(ok.status).toBe(200);
    const window = new Date(ok.body.stepUpExpiresAt).getTime() - Date.now();
    expect(window).toBeGreaterThan(4 * 60_000);
    expect(window).toBeLessThanOrEqual(5 * 60_000);
    expect((await user.get('/api/v1/auth/session')).body.stepUpExpiresAt).toBe(
      ok.body.stepUpExpiresAt,
    );

    // Another session of the same user is not stepped up.
    const other = new UserClient(app);
    await other.http
      .post('/api/v1/auth/login')
      .send({ email: user.user.email, password: PASSWORD })
      .expect(200);
    expect((await other.get('/api/v1/auth/session')).body.stepUpExpiresAt).toBeNull();

    const actions = (
      await db().auditEvent.findMany({ where: { userId: user.user.id }, orderBy: { seq: 'asc' } })
    ).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['user.step_up_failed', 'user.step_up_succeeded']),
    );
  });

  it('requires a CSRF token', async () => {
    const user = await UserClient.register(app);
    expect((await user.http.post('/api/v1/auth/step-up').send({ password: PASSWORD })).status).toBe(
      403,
    );
  });

  it('the window length is configurable', async () => {
    const { app: short } = makeApp({
      purchaseEvaluators: ai,
      env: { STEP_UP_WINDOW_MINUTES: '1' },
    });
    const user = await UserClient.register(short);
    const ok = await stepUp(user);
    expect(new Date(ok.body.stepUpExpiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
  });
});

describe('approving', () => {
  it('requires a recent step-up, then authorizes with funds still held; the agent sees it', async () => {
    const s = await escalated();
    const without = await approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash });
    expect(without.status).toBe(403);
    expect(without.body.error.code).toBe('STEP_UP_REQUIRED');

    await stepUp(s.user).expect(200);
    const res = await approve(s.user, s.approvalId, {
      snapshotHash: s.snapshotHash,
      note: 'Looks right',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'AUTHORIZED',
      approval: { status: 'APPROVED', note: 'Looks right' },
    });
    const ttl = new Date(res.body.authorizationExpiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(await ledger(s.transactionId)).toEqual([['RESERVE', 1899]]);

    const audit = await db().auditEvent.findFirstOrThrow({
      where: { transactionId: s.transactionId, action: 'purchase.approved' },
    });
    expect(audit).toMatchObject({ actorType: 'USER', actorId: s.user.user.id });
    expect(audit.data).toMatchObject({
      snapshotHash: s.snapshotHash,
      note: 'Looks right',
      recheck: { decision: 'ESCALATE' },
    });

    const polled = await s.bot.get(`/api/agent/v1/purchase-requests/${s.transactionId}`);
    expect(polled.body).toMatchObject({
      status: 'AUTHORIZED',
      decision: 'ESCALATE',
      approvalExpiresAt: null,
    });
    expect(polled.body.reasonCodes).toContain('APPROVED');
    expect(polled.body.authorizationExpiresAt).toEqual(expect.any(String));
  });

  it('refuses once the step-up window has passed', async () => {
    const s = await escalated();
    await stepUp(s.user).expect(200);
    await db().session.updateMany({
      where: { userId: s.user.user.id },
      data: { stepUpAt: new Date(Date.now() - 6 * 60_000) },
    });
    const res = await approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('requires a CSRF token', async () => {
    const s = await escalated();
    await stepUp(s.user).expect(200);
    const res = await s.user.http
      .post(`/api/v1/approvals/${s.approvalId}/approve`)
      .send({ snapshotHash: s.snapshotHash });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('approve what you saw: a different snapshot hash is refused', async () => {
    const s = await escalated();
    await stepUp(s.user).expect(200);
    const res = await approve(s.user, s.approvalId, { snapshotHash: 'f'.repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SNAPSHOT_MISMATCH');
    expect(
      (await db().transaction.findUniqueOrThrow({ where: { id: s.transactionId } })).status,
    ).toBe('PENDING_APPROVAL');
  });

  it('refuses if the payee changed after escalation (stale snapshot), but not for cosmetic changes', async () => {
    const s = await escalated();
    await stepUp(s.user).expect(200);
    await s.user
      .patch(`/api/v1/merchants/${s.merchant.id}`, { displayName: 'Cable Co (renamed)' })
      .expect(200);
    await s.user
      .patch(`/api/v1/merchants/${s.merchant.id}`, { paypalEmail: 'attacker@evil.example.test' })
      .expect(200);
    const res = await approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SNAPSHOT_STALE');

    const cosmetic = await escalated();
    await stepUp(cosmetic.user).expect(200);
    await cosmetic.user
      .patch(`/api/v1/merchants/${cosmetic.merchant.id}`, { displayName: 'New name' })
      .expect(200);
    expect(
      (await approve(cosmetic.user, cosmetic.approvalId, { snapshotHash: cosmetic.snapshotHash }))
        .status,
    ).toBe(200);
  });

  it('refuses after the approval window has passed (and never auto-approves)', async () => {
    const s = await escalated();
    await stepUp(s.user).expect(200);
    await db().approval.update({
      where: { id: s.approvalId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPROVAL_EXPIRED');
    await expireOverdueApprovals(db());
    expect(
      (await db().transaction.findUniqueOrThrow({ where: { id: s.transactionId } })).status,
    ).toBe('EXPIRED');
    expect(await ledger(s.transactionId)).toEqual([
      ['RESERVE', 1899],
      ['RELEASE', 1899],
    ]);
  });

  it('is safe to retry: approving twice returns the same result and audits once', async () => {
    const s = await escalated();
    await stepUp(s.user).expect(200);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash }),
      ),
    );
    for (const r of results) expect(r.body.status).toBe('AUTHORIZED');
    expect(
      await db().auditEvent.count({
        where: { transactionId: s.transactionId, action: 'purchase.approved' },
      }),
    ).toBe(1);
  });
});

describe('deterministic re-check at approval time', () => {
  async function confirmPolicy(user: UserClient, rules: unknown[]) {
    const draft = await user.post('/api/v1/policies/drafts', {
      compiledRules: { dslVersion: 1, currency: 'USD', timezone: 'UTC', rules },
    });
    await user
      .post(`/api/v1/policies/versions/${draft.body.id}/confirm`, {
        rulesHash: draft.body.rulesHash,
        password: PASSWORD,
      })
      .expect(200);
  }

  it('refuses when spending has been paused (no active policy)', async () => {
    const s = await escalated();
    await s.user.post('/api/v1/policies/pause', { password: PASSWORD }).expect(204);
    await stepUp(s.user).expect(200);
    const res = await approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POLICY_NOW_BLOCKS');
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ reasonCode: 'NO_ACTIVE_POLICY' }),
    ]);
    // Still pending: the user can reject it (or it expires).
    expect((await reject(s.user, s.approvalId)).body.status).toBe('REJECTED');
  });

  it('refuses when a newer policy now blocks the purchase', async () => {
    const s = await escalated();
    await confirmPolicy(s.user, [
      { id: 'ask', type: 'new_merchant', action: 'ESCALATE' },
      { id: 'cap', type: 'max_amount_per_transaction', amountMinor: 1000, action: 'BLOCK' },
    ]);
    await stepUp(s.user).expect(200);
    const res = await approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ reasonCode: 'AMOUNT_OVER_LIMIT' }),
    ]);
  });

  it('refuses when the task is no longer active', async () => {
    const s = await escalated();
    await s.user.post(`/api/v1/tasks/${s.task.id}/cancel`).expect(200);
    await stepUp(s.user).expect(200);
    const res = await approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ reasonCode: 'TASK_NOT_ACTIVE' })]),
    );
  });

  it('does not count the purchase’s own held funds against it (exact weekly limit)', async () => {
    const s = await escalated(
      [
        { id: 'ask', type: 'new_merchant', action: 'ESCALATE' },
        {
          id: 'week',
          type: 'max_spend_per_period',
          period: 'week',
          amountMinor: 1899,
          action: 'BLOCK',
        },
      ],
      {},
    );
    await stepUp(s.user).expect(200);
    expect((await approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash })).status).toBe(
      200,
    );
  });

  it('does not count the purchase’s own held funds against it (exact task budget)', async () => {
    const s = await escalated(ASK_FOR_NEW_MERCHANTS, {}, '18.99');
    await stepUp(s.user).expect(200);
    expect((await approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash })).status).toBe(
      200,
    );
  });
});

describe('rejecting', () => {
  it('needs no step-up, releases the funds once, records the note, and the agent sees it', async () => {
    const s = await escalated();
    const results = await Promise.all([
      reject(s.user, s.approvalId, { note: 'Not this one' }),
      reject(s.user, s.approvalId),
    ]);
    for (const r of results) expect(r.body).toMatchObject({ status: 'REJECTED', heldMinor: 0 });
    expect(results[0]!.body.approval).toMatchObject({ status: 'REJECTED' });
    expect(await ledger(s.transactionId)).toEqual([
      ['RESERVE', 1899],
      ['RELEASE', 1899],
    ]);
    expect(
      await db().auditEvent.count({
        where: { transactionId: s.transactionId, action: 'purchase.rejected' },
      }),
    ).toBe(1);
    const polled = await s.bot.get(`/api/agent/v1/purchase-requests/${s.transactionId}`);
    expect(polled.body).toMatchObject({ status: 'REJECTED' });
    expect(polled.body.reasonCodes).toContain('REJECTED');
  });

  it('cannot reject an approved purchase, nor approve a rejected one', async () => {
    const a = await escalated();
    await stepUp(a.user).expect(200);
    await approve(a.user, a.approvalId, { snapshotHash: a.snapshotHash }).expect(200);
    expect((await reject(a.user, a.approvalId)).body.error.code).toBe('APPROVAL_NOT_PENDING');

    const b = await escalated();
    await reject(b.user, b.approvalId).expect(200);
    await stepUp(b.user).expect(200);
    expect(
      (await approve(b.user, b.approvalId, { snapshotHash: b.snapshotHash })).body.error.code,
    ).toBe('APPROVAL_NOT_PENDING');
  });
});

describe('races: exactly one outcome, funds consistent', () => {
  function expectConsistent(status: string, entries: unknown[]) {
    if (status === 'AUTHORIZED') expect(entries).toEqual([['RESERVE', 1899]]);
    else
      expect(entries).toEqual([
        ['RESERVE', 1899],
        ['RELEASE', 1899],
      ]);
  }

  it('approve vs reject', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await escalated();
      await stepUp(s.user).expect(200);
      await Promise.all([
        approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash }),
        reject(s.user, s.approvalId),
      ]);
      const tx = await db().transaction.findUniqueOrThrow({
        where: { id: s.transactionId },
        include: { approval: true },
      });
      expect(['AUTHORIZED', 'REJECTED']).toContain(tx.status);
      expect(tx.approval!.status).toBe(tx.status === 'AUTHORIZED' ? 'APPROVED' : 'REJECTED');
      expectConsistent(tx.status, await ledger(s.transactionId));
    }
  });

  it('approve vs the agent cancelling', async () => {
    const s = await escalated();
    await stepUp(s.user).expect(200);
    await Promise.all([
      approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash }),
      s.bot.post(`/api/agent/v1/purchase-requests/${s.transactionId}/cancel`),
    ]);
    const tx = await db().transaction.findUniqueOrThrow({ where: { id: s.transactionId } });
    // Cancel can follow an approval (an authorized purchase is still cancellable), so either end state is valid.
    expect(['AUTHORIZED', 'CANCELLED']).toContain(tx.status);
    expectConsistent(tx.status, await ledger(s.transactionId));
  });

  it('approve vs the expiry sweep', async () => {
    const s = await escalated();
    await stepUp(s.user).expect(200);
    await Promise.all([
      approve(s.user, s.approvalId, { snapshotHash: s.snapshotHash }),
      expireOverdueApprovals(db(), { now: new Date(Date.now() + 2 * 60 * 60_000) }),
    ]);
    const tx = await db().transaction.findUniqueOrThrow({
      where: { id: s.transactionId },
      include: { approval: true },
    });
    expect(['AUTHORIZED', 'EXPIRED']).toContain(tx.status);
    expect(tx.approval!.status).toBe(tx.status === 'AUTHORIZED' ? 'APPROVED' : 'EXPIRED');
    expectConsistent(tx.status, await ledger(s.transactionId));
  });
});

describe('who can approve what', () => {
  it('BLOCKED and ALLOWED purchases have nothing to approve', async () => {
    const s = await setupPurchaser(app, [
      { id: 'cap', type: 'max_amount_per_transaction', amountMinor: 100, action: 'BLOCK' },
    ]);
    const blocked = await s.purchase();
    expect(blocked.body.status).toBe('BLOCKED');
    expect((await s.user.get(`/api/v1/transactions/${blocked.body.id}`)).body.approval).toBeNull();
    await stepUp(s.user).expect(200);
    expect((await approve(s.user, randomUUID(), { snapshotHash: '0'.repeat(64) })).status).toBe(
      404,
    );
    expect(await db().approval.count({ where: { transactionId: blocked.body.id } })).toBe(0);
  });

  it('agents cannot approve or reject, even their own purchases', async () => {
    const s = await escalated();
    for (const path of [
      `/api/v1/approvals/${s.approvalId}/approve`,
      `/api/v1/approvals/${s.approvalId}/reject`,
    ]) {
      expect(
        (await asAgent(app, s.secret).post(path, { snapshotHash: s.snapshotHash })).status,
      ).toBe(401);
    }
    expect(
      (
        await asAgent(app, s.secret).post(
          `/api/agent/v1/purchase-requests/${s.transactionId}/approve`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await db().transaction.findUniqueOrThrow({ where: { id: s.transactionId } })).status,
    ).toBe('PENDING_APPROVAL');
  });

  it('other users cannot see, approve or reject', async () => {
    const s = await escalated();
    const other = await UserClient.register(app);
    await stepUp(other).expect(200);
    expect((await other.get('/api/v1/approvals')).body).toEqual({ approvals: [], pendingCount: 0 });
    expect((await approve(other, s.approvalId, { snapshotHash: s.snapshotHash })).status).toBe(404);
    expect((await reject(other, s.approvalId)).status).toBe(404);
  });
});

describe('the approvals queue', () => {
  it('lists pending approvals soonest-to-expire first, with a pending count and history', async () => {
    const s = await setupPurchaser(app, ASK_FOR_NEW_MERCHANTS);
    const first = await s.purchase();
    const second = await s.purchase({
      merchantId: s.other.id,
      amount: { currency: 'USD', value: '5.00' },
    });
    const firstApproval = await db().approval.findUniqueOrThrow({
      where: { transactionId: first.body.id },
    });
    await db().approval.update({
      where: { id: firstApproval.id },
      data: { expiresAt: new Date(Date.now() + 10 * 60_000) },
    });

    const pending = (await s.user.get('/api/v1/approvals')).body;
    expect(pending.pendingCount).toBe(2);
    expect(pending.approvals.map((a: { transaction: { id: string } }) => a.transaction.id)).toEqual(
      [first.body.id, second.body.id],
    );
    expect(pending.approvals[0]).toMatchObject({
      status: 'PENDING',
      snapshotHash: firstApproval.snapshotHash,
      transaction: { agent: { name: 'Buyer bot' } },
    });

    await reject(s.user, firstApproval.id).expect(200);
    expect((await s.user.get('/api/v1/approvals')).body.pendingCount).toBe(1);
    const history = (await s.user.get('/api/v1/approvals?status=REJECTED')).body.approvals;
    expect(history).toHaveLength(1);
    expect((await s.user.get('/api/v1/approvals?status=NOPE')).status).toBe(400);
  });

  it('the audit chain stays valid', async () => {
    expect((await verifyAuditChain(db())).valid).toBe(true);
  });
});
