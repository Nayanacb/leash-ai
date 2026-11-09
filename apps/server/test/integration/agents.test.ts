import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hashApiKey } from '../../src/modules/agents/apiKeys.js';
import { asAgent, auditActions, db, makeApp, UserClient } from './harness.js';

const { app, logs } = makeApp();

describe('agent management', () => {
  it('creates, renames, suspends and reactivates an agent, auditing each step', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent('Procurement bot');
    expect(agent.status).toBe('ACTIVE');

    expect((await user.patch(`/api/v1/agents/${agent.id}`, { name: 'Office bot' })).body.name).toBe(
      'Office bot',
    );
    expect(
      (await user.patch(`/api/v1/agents/${agent.id}`, { status: 'SUSPENDED' })).body.status,
    ).toBe('SUSPENDED');
    expect((await user.patch(`/api/v1/agents/${agent.id}`, { status: 'ACTIVE' })).body.status).toBe(
      'ACTIVE',
    );

    const list = await user.get('/api/v1/agents');
    expect(list.body.agents.map((a: { id: string }) => a.id)).toEqual([agent.id]);
    expect(await auditActions(user.user.id)).toEqual([
      'user.registered',
      'agent.created',
      'agent.renamed',
      'agent.suspended',
      'agent.reactivated',
    ]);
  });

  it('revoking an agent revokes its keys and is permanent', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent();
    const { secret } = await user.createKey(agent.id);

    const revoked = await user.patch(`/api/v1/agents/${agent.id}`, { status: 'REVOKED' });
    expect(revoked.body.status).toBe('REVOKED');
    expect(revoked.body.apiKeys.every((k: { status: string }) => k.status === 'REVOKED')).toBe(
      true,
    );
    expect((await asAgent(app, secret).get('/api/agent/v1/me')).status).toBe(401);

    const reactivate = await user.patch(`/api/v1/agents/${agent.id}`, { status: 'ACTIVE' });
    expect(reactivate.status).toBe(409);
    expect((await user.post(`/api/v1/agents/${agent.id}/keys`, { expiresInDays: 30 })).status).toBe(
      409,
    );
  });
});

describe('API key generation', () => {
  it('shows the secret exactly once and stores only its hash', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent();
    const res = await user.post(`/api/v1/agents/${agent.id}/keys`, {
      expiresInDays: 30,
      label: 'ci runner',
    });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { secret, apiKey } = res.body;
    expect(secret).toMatch(/^lsh_[A-Za-z0-9_-]{43}$/);
    expect(apiKey).toMatchObject({
      label: 'ci runner',
      status: 'ACTIVE',
      prefix: secret.slice(0, 12),
    });
    expect(new Date(apiKey.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    // Never retrievable again.
    const detail = await user.get(`/api/v1/agents/${agent.id}`);
    expect(JSON.stringify(detail.body)).not.toContain(secret);
    expect(JSON.stringify(detail.body)).not.toContain(hashApiKey(secret));

    // Stored as a hash only.
    const stored = await db().agentApiKey.findUniqueOrThrow({ where: { id: apiKey.id } });
    expect(stored.keyHash).toBe(hashApiKey(secret));
    expect(JSON.stringify(stored)).not.toContain(secret);

    // Never in the audit log or application logs.
    const audit = await db().auditEvent.findMany({ where: { userId: user.user.id } });
    expect(JSON.stringify(audit.map((e) => e.data))).not.toContain(secret);
    expect(JSON.stringify(logs())).not.toContain(secret);
  });

  it('only offers fixed lifetimes, so every key expires', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent();
    for (const expiresInDays of [0, 3, 10_000, null, '30']) {
      expect((await user.post(`/api/v1/agents/${agent.id}/keys`, { expiresInDays })).status).toBe(
        400,
      );
    }
  });

  it('caps active keys per agent', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent();
    for (let i = 0; i < 5; i++) await user.createKey(agent.id);
    expect((await user.post(`/api/v1/agents/${agent.id}/keys`, { expiresInDays: 7 })).status).toBe(
      409,
    );
  });
});

describe('agent authentication', () => {
  it('authenticates a valid key and records last use', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent('Bot');
    const { secret, apiKey } = await user.createKey(agent.id);
    const res = await asAgent(app, secret).get('/api/agent/v1/me');
    expect(res.status).toBe(200);
    expect(res.body.agent).toEqual({ id: agent.id, name: 'Bot' });
    expect(
      (await db().agentApiKey.findUniqueOrThrow({ where: { id: apiKey.id } })).lastUsedAt,
    ).not.toBeNull();
  });

  it.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['malformed key', 'Bearer not-a-key'],
    ['unknown key', `Bearer lsh_${'x'.repeat(43)}`],
    ['injection attempt', "Bearer lsh_' OR 1=1 --"],
  ])('rejects %s', async (_name, header) => {
    const req = request(app).get('/api/agent/v1/me');
    const res = await (header ? req.set('Authorization', header) : req);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_API_KEY',
      message: 'Invalid or inactive API key',
    });
  });

  it('ignores session cookies on the agent API', async () => {
    const user = await UserClient.register(app);
    expect((await user.get('/api/agent/v1/me')).status).toBe(401);
  });
});

describe('API key revocation and expiry', () => {
  it('revocation takes effect on the very next request and is audited', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent();
    const { secret, apiKey } = await user.createKey(agent.id);
    const bot = asAgent(app, secret);
    expect((await bot.get('/api/agent/v1/me')).status).toBe(200);

    const revoke = await user.delete(`/api/v1/agents/${agent.id}/keys/${apiKey.id}`);
    expect(revoke.status).toBe(200);
    expect(revoke.body.status).toBe('REVOKED');

    const after = await bot.get('/api/agent/v1/me');
    expect(after.status).toBe(401);
    // Same message as an unknown key: the caller learns nothing.
    expect(after.body.error.message).toBe('Invalid or inactive API key');

    const events = await db().auditEvent.findMany({
      where: { userId: user.user.id },
      orderBy: { seq: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['agent_key.created', 'agent_key.revoked', 'agent.auth_rejected']),
    );
    const rejection = events.find((e) => e.action === 'agent.auth_rejected')!;
    expect(rejection).toMatchObject({ actorType: 'AGENT', actorId: agent.id });
    expect(rejection.data).toMatchObject({ reason: 'key_revoked', keyPrefix: apiKey.prefix });
  });

  it('revoking twice is harmless', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent();
    const { apiKey } = await user.createKey(agent.id);
    await user.delete(`/api/v1/agents/${agent.id}/keys/${apiKey.id}`).expect(200);
    await user.delete(`/api/v1/agents/${agent.id}/keys/${apiKey.id}`).expect(200);
    expect(
      (await auditActions(user.user.id)).filter((a) => a === 'agent_key.revoked'),
    ).toHaveLength(1);
  });

  it('rejects expired keys', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent();
    const { secret, apiKey } = await user.createKey(agent.id, 7);
    await db().agentApiKey.update({
      where: { id: apiKey.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await asAgent(app, secret).get('/api/agent/v1/me')).status).toBe(401);
    const detail = await user.get(`/api/v1/agents/${agent.id}`);
    expect(detail.body.apiKeys[0].status).toBe('EXPIRED');
    expect(detail.body.activeKeyCount).toBe(0);
  });

  it('suspending the agent disables its keys until reactivated', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent();
    const { secret } = await user.createKey(agent.id);
    await user.patch(`/api/v1/agents/${agent.id}`, { status: 'SUSPENDED' }).expect(200);
    expect((await asAgent(app, secret).get('/api/agent/v1/me')).status).toBe(401);
    await user.patch(`/api/v1/agents/${agent.id}`, { status: 'ACTIVE' }).expect(200);
    expect((await asAgent(app, secret).get('/api/agent/v1/me')).status).toBe(200);
  });

  it('rate-limits each key', async () => {
    const { app: limited } = makeApp({ rateLimits: { agentPerKeyPerMinute: 2 } });
    const user = await UserClient.register(limited);
    const agent = await user.createAgent();
    const { secret } = await user.createKey(agent.id);
    await asAgent(limited, secret).get('/api/agent/v1/me').expect(200);
    await asAgent(limited, secret).get('/api/agent/v1/me').expect(200);
    expect((await asAgent(limited, secret).get('/api/agent/v1/me')).status).toBe(429);
  });
});
