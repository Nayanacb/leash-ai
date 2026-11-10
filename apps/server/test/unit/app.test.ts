import { HealthResponseSchema, ReadinessResponseSchema } from '@leash/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type DatabaseProbe } from '../../src/db.js';
import { captureLogger, testConfig } from '../helpers.js';

function buildApp(db: DatabaseProbe = { ping: async () => {} }) {
  const { logger } = captureLogger();
  // The client is never used by these tests (no query is issued), so it points nowhere.
  const unusedDb = createDatabase('postgresql://unused:unused@127.0.0.1:1/unused');
  return createApp({ config: testConfig(), logger, db: unusedDb, probe: db, version: '9.9.9' });
}

describe('health endpoints', () => {
  it('GET /healthz reports liveness without touching the database', async () => {
    const res = await request(
      buildApp({ ping: () => Promise.reject(new Error('db should not be called')) }),
    ).get('/healthz');
    expect(res.status).toBe(200);
    const body = HealthResponseSchema.parse(res.body);
    expect(body).toMatchObject({ status: 'ok', version: '9.9.9', paypalEnvironment: 'sandbox' });
  });

  it('is also served under /api for the dashboard proxy', async () => {
    const res = await request(buildApp()).get('/api/healthz');
    expect(res.status).toBe(200);
  });

  it('GET /readyz is 200 when the database responds', async () => {
    const res = await request(buildApp()).get('/readyz');
    expect(res.status).toBe(200);
    expect(ReadinessResponseSchema.parse(res.body)).toEqual({
      status: 'ready',
      checks: { database: 'ok' },
    });
  });

  it('GET /readyz is 503 when the database is unreachable', async () => {
    const res = await request(
      buildApp({ ping: () => Promise.reject(new Error('ECONNREFUSED')) }),
    ).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { database: 'error' } });
  });
});

describe('HTTP hardening', () => {
  it('sets security headers and hides the framework', async () => {
    const res = await request(buildApp()).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not emit CORS headers for cross-origin requests', async () => {
    const res = await request(buildApp()).get('/healthz').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('echoes a safe X-Request-Id and replaces an unsafe one', async () => {
    const app = buildApp();
    const safe = await request(app).get('/healthz').set('X-Request-Id', 'abc-123');
    expect(safe.headers['x-request-id']).toBe('abc-123');
    const unsafe = await request(app)
      .get('/healthz')
      .set('X-Request-Id', '<script>alert(1)</script>');
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('error responses', () => {
  it('returns a JSON 404 envelope for unknown routes', async () => {
    const res = await request(buildApp()).get('/api/does-not-exist').set('X-Request-Id', 'req-1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'No route for GET /api/does-not-exist',
        requestId: 'req-1',
      },
    });
  });

  it('returns 400 INVALID_JSON for malformed bodies', async () => {
    const res = await request(buildApp())
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send('{"oops"');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('returns 413 for oversized bodies', async () => {
    const res = await request(buildApp())
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
