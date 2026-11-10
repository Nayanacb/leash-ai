import { describe, expect, it } from 'vitest';
import { asAgent, auditActions, db, makeApp, UserClient } from './harness.js';

const { app } = makeApp();
const DAY = 86_400_000;

async function setup() {
  const user = await UserClient.register(app);
  const agent = await user.createAgent();
  const { secret } = await user.createKey(agent.id);
  const merchant = await user.createMerchant({
    displayName: 'Cable Co',
    paypalEmail: `pay-${Date.now()}@cable.example.test`,
  });
  return { user, agent, secret, merchant };
}

function taskBody(agentId: string, merchantIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    instruction: 'Buy a 2 m USB-C cable under $20',
    budget: { currency: 'USD', value: '20.00' },
    agentId,
    allowedMerchantIds: merchantIds,
    expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
    ...overrides,
  };
}

describe('creating tasks (mandates)', () => {
  it('stores the instruction, budget, currency, merchants, agent and expiry', async () => {
    const { user, agent, merchant } = await setup();
    const res = await user.post('/api/v1/tasks', taskBody(agent.id, [merchant.id]));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      instruction: 'Buy a 2 m USB-C cable under $20',
      budgetMinor: 2000,
      currency: 'USD',
      committedMinor: 0,
      remainingMinor: 2000,
      status: 'ACTIVE',
      agent: { id: agent.id },
      allowedMerchants: [
        { id: merchant.id, displayName: 'Cable Co', category: 'electronics', archived: false },
      ],
    });
    expect(await auditActions(user.user.id)).toContain('task.created');
  });

  it.each([
    ['expiry in the past', { expiresAt: new Date(Date.now() - DAY).toISOString() }],
    ['expiry beyond 90 days', { expiresAt: new Date(Date.now() + 91 * DAY).toISOString() }],
    ['expiry not a timestamp', { expiresAt: 'next tuesday' }],
    ['zero budget', { budget: { currency: 'USD', value: '0.00' } }],
    ['negative budget', { budget: { currency: 'USD', value: '-5.00' } }],
    ['too many decimals', { budget: { currency: 'USD', value: '1.999' } }],
    ['numeric budget', { budget: { currency: 'USD', value: 20 } }],
    ['unsupported currency', { budget: { currency: 'BTC', value: '1.00' } }],
    ['no merchants', { allowedMerchantIds: [] }],
    ['duplicate merchants', 'DUPLICATE'],
    ['empty instruction', { instruction: '   ' }],
    ['oversized instruction', { instruction: 'x'.repeat(2001) }],
    ['control characters', { instruction: 'Buy\u0007 a cable' }],
  ])('rejects %s', async (_name, override) => {
    const { user, agent, merchant } = await setup();
    const body =
      override === 'DUPLICATE'
        ? taskBody(agent.id, [merchant.id, merchant.id])
        : taskBody(agent.id, [merchant.id], override as Record<string, unknown>);
    const res = await user.post('/api/v1/tasks', body);
    expect(res.status).toBe(400);
    expect(await db().task.count({ where: { userId: user.user.id } })).toBe(0);
  });

  it('rejects archived merchants and revoked agents', async () => {
    const { user, agent, merchant } = await setup();
    await user.patch(`/api/v1/merchants/${merchant.id}`, { archived: true }).expect(200);
    expect((await user.post('/api/v1/tasks', taskBody(agent.id, [merchant.id]))).status).toBe(400);

    const other = await user.createMerchant();
    await user.patch(`/api/v1/agents/${agent.id}`, { status: 'REVOKED' }).expect(200);
    expect((await user.post('/api/v1/tasks', taskBody(agent.id, [other.id]))).status).toBe(400);
  });
});

describe('task lifecycle and expiry', () => {
  it('cancels and completes active tasks, once', async () => {
    const { user, agent, merchant } = await setup();
    const a = await user.createTask({ agentId: agent.id, merchantIds: [merchant.id] });
    const b = await user.createTask({ agentId: agent.id, merchantIds: [merchant.id] });
    expect((await user.post(`/api/v1/tasks/${a.id}/cancel`)).body.status).toBe('CANCELLED');
    expect((await user.post(`/api/v1/tasks/${b.id}/complete`)).body.status).toBe('COMPLETED');
    const again = await user.post(`/api/v1/tasks/${a.id}/complete`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TASK_NOT_ACTIVE');
  });

  it('reports a task past its expiry as EXPIRED everywhere and refuses to change it', async () => {
    const { user, agent, secret, merchant } = await setup();
    const task = await user.createTask({ agentId: agent.id, merchantIds: [merchant.id] });
    await db().task.update({
      where: { id: task.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await user.get(`/api/v1/tasks/${task.id}`)).body.status).toBe('EXPIRED');
    expect((await asAgent(app, secret).get(`/api/agent/v1/tasks/${task.id}`)).body.status).toBe(
      'EXPIRED',
    );
    expect((await user.get('/api/v1/tasks?status=ACTIVE')).body.tasks).toEqual([]);
    expect(
      (await user.get('/api/v1/tasks?status=EXPIRED')).body.tasks.map((t: { id: string }) => t.id),
    ).toEqual([task.id]);
    expect((await user.post(`/api/v1/tasks/${task.id}/cancel`)).status).toBe(409);
  });
});

describe('agents and mandates', () => {
  it('agents can read their tasks without payee details', async () => {
    const { user, agent, secret, merchant } = await setup();
    const task = await user.createTask({ agentId: agent.id, merchantIds: [merchant.id] });
    const res = await asAgent(app, secret).get(`/api/agent/v1/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: task.id,
      instruction: 'Buy a 2 m USB-C cable under $20',
      budgetMinor: 2000,
      remainingMinor: 2000,
      currency: 'USD',
      status: 'ACTIVE',
      expiresAt: expect.any(String),
      allowedMerchants: [{ id: merchant.id, displayName: 'Cable Co', category: 'electronics' }],
    });
    expect(JSON.stringify(res.body)).not.toContain(merchant.paypalEmail);
    expect((await asAgent(app, secret).get('/api/agent/v1/tasks')).body.tasks).toHaveLength(1);
  });

  it('agents can never create or modify a mandate', async () => {
    const { user, agent, secret, merchant } = await setup();
    const task = await user.createTask({ agentId: agent.id, merchantIds: [merchant.id] });
    const bot = asAgent(app, secret);
    const attempts = [
      bot.post('/api/agent/v1/tasks', taskBody(agent.id, [merchant.id])),
      bot.patch(`/api/agent/v1/tasks/${task.id}`, {
        budget: { currency: 'USD', value: '9999.00' },
      }),
      bot.delete(`/api/agent/v1/tasks/${task.id}`),
      bot.post(`/api/agent/v1/tasks/${task.id}/cancel`),
      bot.post(`/api/agent/v1/tasks/${task.id}/complete`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(405);
      expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
    }
    // The user API refuses agent keys outright.
    expect((await bot.post('/api/v1/tasks', taskBody(agent.id, [merchant.id]))).status).toBe(401);
    expect((await bot.post(`/api/v1/tasks/${task.id}/cancel`)).status).toBe(401);

    const stored = await db().task.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored).toMatchObject({ status: 'ACTIVE', budgetMinor: 2000 });
    expect(await db().task.count({ where: { userId: user.user.id } })).toBe(1);
  });

  it('archived merchants disappear from the agent’s view of a task', async () => {
    const { user, agent, secret, merchant } = await setup();
    const task = await user.createTask({ agentId: agent.id, merchantIds: [merchant.id] });
    await user.patch(`/api/v1/merchants/${merchant.id}`, { archived: true }).expect(200);
    expect(
      (await asAgent(app, secret).get(`/api/agent/v1/tasks/${task.id}`)).body.allowedMerchants,
    ).toEqual([]);
    expect((await user.get(`/api/v1/tasks/${task.id}`)).body.allowedMerchants[0].archived).toBe(
      true,
    );
  });
});
