import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { db, makeApp, ORIGIN, PASSWORD, uniqueEmail, UserClient } from './harness.js';

const { app } = makeApp();

describe('CSRF protection', () => {
  it('rejects authenticated mutations without a CSRF token', async () => {
    const client = await UserClient.register(app);
    const res = await client.http.post('/api/v1/agents').send({ name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
    expect(await db().agent.count({ where: { userId: client.user.id } })).toBe(0);
  });

  it('rejects a wrong token and a token from another session', async () => {
    const victim = await UserClient.register(app);
    const attacker = await UserClient.register(app);
    const wrong = await victim.http
      .post('/api/v1/agents')
      .set('X-CSRF-Token', 'not-the-token')
      .send({ name: 'x' });
    expect(wrong.status).toBe(403);
    const foreign = await victim.http
      .post('/api/v1/agents')
      .set('X-CSRF-Token', attacker.csrf)
      .send({ name: 'x' });
    expect(foreign.status).toBe(403);
  });

  it('accepts the session’s own token', async () => {
    const client = await UserClient.register(app);
    expect((await client.post('/api/v1/agents', { name: 'ok' })).status).toBe(201);
  });

  it('refuses cross-origin requests even with a valid token', async () => {
    const client = await UserClient.register(app);
    const res = await client
      .post('/api/v1/agents', { name: 'x' })
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('refuses requests marked cross-site by the browser', async () => {
    const client = await UserClient.register(app);
    const res = await client
      .post('/api/v1/agents', { name: 'x' })
      .set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(403);
  });

  it('allows the dashboard origin', async () => {
    const client = await UserClient.register(app);
    const res = await client
      .post('/api/v1/agents', { name: 'x' })
      .set('Origin', ORIGIN)
      .set('Sec-Fetch-Site', 'same-origin');
    expect(res.status).toBe(201);
  });

  it('protects login and registration from cross-site form posts (login CSRF)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: uniqueEmail(), password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it.each([
    ['text/plain', '{"name":"x"}'],
    ['application/x-www-form-urlencoded', 'name=x'],
    [
      'multipart/form-data; boundary=x',
      '--x\r\nContent-Disposition: form-data; name="name"\r\n\r\nx\r\n--x--',
    ],
  ])('rejects non-JSON bodies (%s) — the shapes an HTML form can send', async (type, body) => {
    const client = await UserClient.register(app);
    const res = await client.http
      .post('/api/v1/agents')
      .set('X-CSRF-Token', client.csrf)
      .set('Content-Type', type)
      .send(body);
    expect(res.status).toBe(415);
  });

  it('does not require a token for reads', async () => {
    const client = await UserClient.register(app);
    expect((await client.get('/api/v1/agents')).status).toBe(200);
  });
});
