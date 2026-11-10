import express from 'express';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/lib/errors.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';
import { requestId } from '../../src/middleware/requestId.js';
import { validateBody } from '../../src/middleware/validate.js';
import { captureLogger } from '../helpers.js';

function appWith(exposeInternalErrors: boolean) {
  const { logger, lines } = captureLogger();
  const app = express();
  app.use(requestId);
  app.use(pinoHttp({ logger, autoLogging: false }));
  app.use(express.json());
  app.get('/boom', () => {
    throw new Error('secret internal detail');
  });
  app.get('/async-boom', async () => {
    await Promise.resolve();
    throw new Error('async failure');
  });
  app.get('/conflict', () => {
    throw AppError.conflict('Already exists', { id: 'x' });
  });
  app.post('/validated', validateBody(z.object({ name: z.string().min(1) })), (req, res) => {
    res.json({ got: req.body });
  });
  app.use(createErrorHandler({ exposeInternalErrors }));
  return { app, lines };
}

describe('error handler', () => {
  it('hides internal error details in production mode but logs them', async () => {
    const { app, lines } = appWith(false);
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
    expect(JSON.stringify(lines())).toContain('secret internal detail');
  });

  it('includes error details outside production', async () => {
    const res = await request(appWith(true).app).get('/boom');
    expect(res.body.error.details).toEqual({ name: 'Error', message: 'secret internal detail' });
  });

  it('catches rejected async handlers (Express 5)', async () => {
    const res = await request(appWith(false).app).get('/async-boom');
    expect(res.status).toBe(500);
  });

  it('maps AppError to its status and code', async () => {
    const res = await request(appWith(false).app).get('/conflict');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'Already exists',
      details: { id: 'x' },
    });
  });

  it('maps Zod validation failures to 400 with field paths', async () => {
    const { app } = appWith(false);
    const bad = await request(app).post('/validated').send({ name: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error.details[0].path).toBe('name');
    const good = await request(app).post('/validated').send({ name: 'ok', extra: 1 });
    expect(good.body).toEqual({ got: { name: 'ok' } });
  });
});
