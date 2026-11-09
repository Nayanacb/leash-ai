import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { auditActions, db, makeApp, PASSWORD, uniqueEmail, UserClient } from './harness.js';

const { app } = makeApp();

describe('registration', () => {
  it('creates the user, starts a session and stores only an Argon2id hash', async () => {
    const email = uniqueEmail();
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: `  ${email.toUpperCase()} `, password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(res.body.csrfToken).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|correct horse/);

    const user = await db().user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(await auditActions(user.id)).toEqual(['user.registered']);
  });

  it('sets a hardened session cookie', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: PASSWORD });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^leash_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    // The raw token is stored only as a hash.
    const token = cookie.split(';')[0]!.split('=')[1]!;
    expect(await db().session.count({ where: { tokenHash: token } })).toBe(0);
  });

  it('rejects weak passwords and invalid emails', async () => {
    const short = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'short' });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('VALIDATION_ERROR');
    const badEmail = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: PASSWORD });
    expect(badEmail.status).toBe(400);
    const huge = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: 'x'.repeat(300) });
    expect(huge.status).toBe(400);
  });

  it('rejects duplicate emails case-insensitively', async () => {
    const email = uniqueEmail();
    await UserClient.register(app, email);
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });
});

describe('login', () => {
  it('signs in with the right password and records it', async () => {
    const email = uniqueEmail();
    const registered = await UserClient.register(app, email);
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(registered.user.id);
    expect(await auditActions(registered.user.id)).toEqual([
      'user.registered',
      'user.login_succeeded',
    ]);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const email = uniqueEmail();
    const user = await UserClient.register(app, email);
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrong password!!' });
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password: PASSWORD });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(await auditActions(user.user.id)).toContain('user.login_failed');
  });

  it('rotates the session: the previous cookie stops working after a new login', async () => {
    const email = uniqueEmail();
    const client = new UserClient(app);
    const first = await client.http
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD });
    const firstCookie = client.cookieHeader(first);
    const second = await client.http.post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(client.cookieHeader(second)).not.toBe(firstCookie);
    expect((await request(app).get('/api/v1/auth/session').set('Cookie', firstCookie)).status).toBe(
      401,
    );
    expect((await client.get('/api/v1/auth/session')).status).toBe(200);
  });
});

describe('sessions', () => {
  it('returns the current user and CSRF token', async () => {
    const client = await UserClient.register(app);
    const res = await client.get('/api/v1/auth/session');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: client.user, csrfToken: client.csrf });
  });

  it('is 401 without a session, with a forged cookie, and with an agent API key', async () => {
    expect((await request(app).get('/api/v1/auth/session')).status).toBe(401);
    const forged = await request(app)
      .get('/api/v1/auth/session')
      .set('Cookie', `leash_session=${'A'.repeat(43)}`);
    expect(forged.status).toBe(401);
    const bearer = await request(app)
      .get('/api/v1/agents')
      .set('Authorization', `Bearer lsh_${'a'.repeat(43)}`);
    expect(bearer.status).toBe(401);
  });

  it('rejects sessions past their absolute expiry and deletes them', async () => {
    const client = await UserClient.register(app);
    await db().session.updateMany({
      where: { userId: client.user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await client.get('/api/v1/auth/session')).status).toBe(401);
    expect(await db().session.count({ where: { userId: client.user.id } })).toBe(0);
  });

  it('rejects sessions idle for longer than the idle timeout', async () => {
    const client = await UserClient.register(app);
    await db().session.updateMany({
      where: { userId: client.user.id },
      data: { lastSeenAt: new Date(Date.now() - 13 * 3_600_000) },
    });
    expect((await client.get('/api/v1/auth/session')).status).toBe(401);
  });
});

describe('logout', () => {
  it('ends the session server-side so a copied cookie stops working', async () => {
    const client = new UserClient(app);
    const res = await client.http
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: PASSWORD });
    client.csrf = res.body.csrfToken;
    client.user = res.body.user;
    const stolenCookie = client.cookieHeader(res);

    const logout = await client.post('/api/v1/auth/logout');
    expect(logout.status).toBe(204);
    expect((logout.headers['set-cookie'] as unknown as string[])[0]).toMatch(/leash_session=;/);
    expect(
      (await request(app).get('/api/v1/auth/session').set('Cookie', stolenCookie)).status,
    ).toBe(401);
    expect(await auditActions(client.user.id)).toContain('user.logged_out');
  });

  it('requires a CSRF token', async () => {
    const client = await UserClient.register(app);
    const res = await client.http.post('/api/v1/auth/logout');
    expect(res.status).toBe(403);
    expect((await client.get('/api/v1/auth/session')).status).toBe(200);
  });

  it('logout-all ends every session for the user', async () => {
    const email = uniqueEmail();
    const laptop = await UserClient.register(app, email);
    const phone = new UserClient(app);
    await phone.http.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);

    expect((await laptop.post('/api/v1/auth/logout-all')).status).toBe(204);
    expect((await phone.get('/api/v1/auth/session')).status).toBe(401);
    expect((await laptop.get('/api/v1/auth/session')).status).toBe(401);
  });
});

describe('rate limiting', () => {
  it('limits failed logins per account', async () => {
    const { app: limited } = makeApp({ rateLimits: { loginFailuresPerAccountPer15Min: 3 } });
    const email = uniqueEmail();
    await UserClient.register(limited, email);
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await request(limited)
            .post('/api/v1/auth/login')
            .send({ email, password: 'wrong password!!' })
        ).status,
      ).toBe(401);
    }
    const blocked = await request(limited)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    // Other accounts are unaffected.
    const other = uniqueEmail();
    await UserClient.register(limited, other);
    expect(
      (await request(limited).post('/api/v1/auth/login').send({ email: other, password: PASSWORD }))
        .status,
    ).toBe(200);
  });

  it('limits auth attempts per IP', async () => {
    const { app: limited } = makeApp({ rateLimits: { authPerIpPer15Min: 2 } });
    await request(limited)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: PASSWORD })
      .expect(201);
    await request(limited)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password: PASSWORD })
      .expect(401);
    const res = await request(limited)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: PASSWORD });
    expect(res.status).toBe(429);
  });

  it('limits overall API traffic', async () => {
    const { app: limited } = makeApp({ rateLimits: { apiPerMinute: 2 } });
    await request(limited).get('/api/healthz').expect(200);
    await request(limited).get('/api/healthz').expect(200);
    expect((await request(limited).get('/api/healthz')).status).toBe(429);
  });
});
