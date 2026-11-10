import { describe, expect, it } from 'vitest';
import { asAgent, db, makeApp, UserClient } from './harness.js';

const { app } = makeApp();

/** Alice owns everything; Bob tries to reach it. Every attempt must look like "not found". */
async function setup() {
  const alice = await UserClient.register(app);
  const bob = await UserClient.register(app);
  const agent = await alice.createAgent('Alice bot');
  const { apiKey } = await alice.createKey(agent.id);
  const merchant = await alice.createMerchant({ displayName: 'Alice store' });
  const task = await alice.createTask({ agentId: agent.id, merchantIds: [merchant.id] });
  return { alice, bob, agent, apiKey, merchant, task };
}

describe('cross-user isolation (IDOR)', () => {
  it('Bob cannot read Alice’s resources', async () => {
    const { bob, agent, merchant, task } = await setup();
    for (const path of [
      `/api/v1/agents/${agent.id}`,
      `/api/v1/merchants/${merchant.id}`,
      `/api/v1/tasks/${task.id}`,
    ]) {
      const res = await bob.get(path);
      expect(res.status, path).toBe(404);
    }
  });

  it('Bob’s lists never include Alice’s data', async () => {
    const { bob } = await setup();
    expect((await bob.get('/api/v1/agents')).body.agents).toEqual([]);
    expect((await bob.get('/api/v1/merchants?includeArchived=true')).body.merchants).toEqual([]);
    expect((await bob.get('/api/v1/tasks')).body.tasks).toEqual([]);
    const audit = await bob.get('/api/v1/audit-events');
    expect(audit.body.events.map((e: { action: string }) => e.action)).toEqual(['user.registered']);
  });

  it('Bob cannot modify Alice’s resources', async () => {
    const { bob, agent, apiKey, merchant, task } = await setup();
    const attempts = [
      bob.patch(`/api/v1/agents/${agent.id}`, { status: 'SUSPENDED' }),
      bob.patch(`/api/v1/agents/${agent.id}`, { name: 'pwned' }),
      bob.post(`/api/v1/agents/${agent.id}/keys`, { expiresInDays: 30 }),
      bob.delete(`/api/v1/agents/${agent.id}/keys/${apiKey.id}`),
      bob.patch(`/api/v1/merchants/${merchant.id}`, { paypalEmail: 'attacker@evil.example.test' }),
      bob.post(`/api/v1/tasks/${task.id}/cancel`),
      bob.post(`/api/v1/tasks/${task.id}/complete`),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);

    const [a, k, m, t] = await Promise.all([
      db().agent.findUniqueOrThrow({ where: { id: agent.id } }),
      db().agentApiKey.findUniqueOrThrow({ where: { id: apiKey.id } }),
      db().merchant.findUniqueOrThrow({ where: { id: merchant.id } }),
      db().task.findUniqueOrThrow({ where: { id: task.id } }),
    ]);
    expect(a).toMatchObject({ status: 'ACTIVE', name: 'Alice bot' });
    expect(k.revokedAt).toBeNull();
    expect(m.paypalEmail).not.toContain('attacker');
    expect(t.status).toBe('ACTIVE');
  });

  it('Bob cannot build a task from Alice’s agent or merchants', async () => {
    const { bob, agent, merchant } = await setup();
    const bobAgent = await bob.createAgent();
    const bobMerchant = await bob.createMerchant();
    const base = {
      instruction: 'x',
      budget: { currency: 'USD', value: '5.00' },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const withAliceAgent = await bob.post('/api/v1/tasks', {
      ...base,
      agentId: agent.id,
      allowedMerchantIds: [bobMerchant.id],
    });
    expect(withAliceAgent.status).toBe(400);
    expect(withAliceAgent.body.error.code).toBe('INVALID_REFERENCE');
    const withAliceMerchant = await bob.post('/api/v1/tasks', {
      ...base,
      agentId: bobAgent.id,
      allowedMerchantIds: [bobMerchant.id, merchant.id],
    });
    expect(withAliceMerchant.status).toBe(400);
  });

  it('agents see only their own tasks — not another user’s, nor a sibling agent’s', async () => {
    const { alice, bob, task } = await setup();
    const sibling = await alice.createAgent('Sibling');
    const { secret: siblingKey } = await alice.createKey(sibling.id);
    const bobAgent = await bob.createAgent();
    const { secret: bobKey } = await bob.createKey(bobAgent.id);

    expect((await asAgent(app, siblingKey).get(`/api/agent/v1/tasks/${task.id}`)).status).toBe(404);
    expect((await asAgent(app, bobKey).get(`/api/agent/v1/tasks/${task.id}`)).status).toBe(404);
    expect((await asAgent(app, siblingKey).get('/api/agent/v1/tasks')).body.tasks).toEqual([]);
  });

  it('cannot assign ownership through the request body (mass assignment)', async () => {
    const { alice, bob } = await setup();
    const res = await bob.post('/api/v1/agents', {
      name: 'mine',
      userId: alice.user.id,
      status: 'REVOKED',
    });
    expect(res.status).toBe(201);
    const created = await db().agent.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(created).toMatchObject({ userId: bob.user.id, status: 'ACTIVE' });
  });
});
