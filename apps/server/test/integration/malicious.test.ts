import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { db, makeApp, UserClient } from './harness.js';

const { app } = makeApp();

describe('invalid and malicious requests', () => {
  it('stores SQL-looking input as plain text', async () => {
    const user = await UserClient.register(app);
    const name = `Robert'); DROP TABLE "User";--`;
    const res = await user.post('/api/v1/agents', { name });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(name);
    expect(await db().user.count()).toBeGreaterThan(0);
  });

  it('returns HTML-looking input verbatim as JSON (escaping is the renderer’s job)', async () => {
    const user = await UserClient.register(app);
    const res = await user.post('/api/v1/agents', { name: '<img src=x onerror=alert(1)>' });
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects malformed IDs instead of passing them to the database', async () => {
    const user = await UserClient.register(app);
    for (const path of [
      '/api/v1/agents/1',
      "/api/v1/agents/' OR 1=1",
      '/api/v1/tasks/..%2F..%2Fetc',
      '/api/v1/merchants/null',
    ]) {
      const res = await user.get(path);
      expect(res.status, path).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('ignores prototype-pollution payloads', async () => {
    const user = await UserClient.register(app);
    const res = await user.http
      .post('/api/v1/agents')
      .set('X-CSRF-Token', user.csrf)
      .set('Content-Type', 'application/json')
      .send(
        '{"name":"proto","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
      );
    expect(res.status).toBe(201);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects wrong types and unknown enum values', async () => {
    const user = await UserClient.register(app);
    const agent = await user.createAgent();
    expect((await user.post('/api/v1/agents', { name: 42 })).status).toBe(400);
    expect((await user.post('/api/v1/agents', { name: ['a'] })).status).toBe(400);
    expect((await user.patch(`/api/v1/agents/${agent.id}`, { status: 'GOD_MODE' })).status).toBe(
      400,
    );
    expect((await user.post('/api/v1/agents', {})).status).toBe(400);
  });

  it('rejects malformed and oversized bodies', async () => {
    const user = await UserClient.register(app);
    const malformed = await user.http
      .post('/api/v1/agents')
      .set('X-CSRF-Token', user.csrf)
      .set('Content-Type', 'application/json')
      .send('{"name":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_JSON');
    const huge = await user.post('/api/v1/agents', { name: 'x', padding: 'y'.repeat(200_000) });
    expect(huge.status).toBe(413);
  });

  it('does not reveal which routes exist to unauthenticated callers', async () => {
    for (const path of [
      '/api/v1/agents',
      '/api/v1/does-not-exist',
      '/api/v1/audit-events/verify',
    ]) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
  });

  it('never leaks internals in error responses', async () => {
    const user = await UserClient.register(app);
    const res = await user.get('/api/v1/agents/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|stack|SELECT|postgres/i);
  });
});
