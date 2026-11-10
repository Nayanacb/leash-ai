import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/db.js';
import type { RateLimitSettings } from '../../src/middleware/rateLimit.js';
import type { PolicyCompiler } from '../../src/modules/policies/compiler.js';
import type { PaymentProvider } from '../../src/modules/payments/provider.js';
import type { PurchaseEvaluators } from '../../src/modules/evaluation/evaluators.js';
import { captureLogger, testConfig } from '../helpers.js';
import { testDatabaseUrl } from './testDatabase.js';

export const PASSWORD = 'correct horse battery staple';
export const ORIGIN = 'http://localhost:5173';

let database: Database | undefined;

/** One client per test file, disconnected after the file. */
export function db(): Database {
  if (!database) {
    database = createDatabase(testDatabaseUrl());
    afterAll(async () => {
      await database?.$disconnect();
      database = undefined;
    });
  }
  return database;
}

const GENEROUS_LIMITS: RateLimitSettings = {
  apiPerMinute: 100_000,
  authPerIpPer15Min: 100_000,
  loginFailuresPerAccountPer15Min: 100_000,
  agentPerKeyPerMinute: 100_000,
  policyCompilesPerUserPerHour: 100_000,
  purchaseRequestsPerAgentPerMinute: 100_000,
  webhooksPerIpPerMinute: 100_000,
};

export function makeApp(
  options: {
    rateLimits?: Partial<RateLimitSettings>;
    policyCompiler?: PolicyCompiler | null;
    purchaseEvaluators?: PurchaseEvaluators | null;
    paymentProvider?: PaymentProvider | null;
    env?: Record<string, string>;
  } = {},
) {
  const { logger, lines } = captureLogger();
  const app = createApp({
    config: testConfig({ DATABASE_URL: testDatabaseUrl(), ...options.env }),
    logger,
    db: db(),
    version: 'test',
    rateLimits: { ...GENEROUS_LIMITS, ...options.rateLimits },
    // Never call a real LLM from tests unless a test injects a compiler explicitly.
    policyCompiler: options.policyCompiler ?? null,
    purchaseEvaluators: options.purchaseEvaluators ?? null,
    // Never call real PayPal from tests; inject FakePayPal explicitly.
    paymentProvider: options.paymentProvider ?? null,
  });
  return { app, logs: lines };
}

export function uniqueEmail(): string {
  return `user-${randomUUID()}@example.test`;
}

/** A signed-in dashboard user: keeps the session cookie and sends the CSRF token on mutations. */
export class UserClient {
  readonly http: ReturnType<typeof request.agent>;
  csrf = '';
  user!: { id: string; email: string };

  constructor(readonly app: Express) {
    this.http = request.agent(app);
  }

  static async register(
    app: Express,
    email = uniqueEmail(),
    password = PASSWORD,
  ): Promise<UserClient> {
    const client = new UserClient(app);
    const res = await client.http.post('/api/v1/auth/register').send({ email, password });
    if (res.status !== 201)
      throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    client.csrf = res.body.csrfToken;
    client.user = res.body.user;
    return client;
  }

  get(path: string) {
    return this.http.get(path);
  }
  post(path: string, body?: object) {
    return this.http.post(path).set('X-CSRF-Token', this.csrf).send(body);
  }
  patch(path: string, body: object) {
    return this.http.patch(path).set('X-CSRF-Token', this.csrf).send(body);
  }
  delete(path: string) {
    return this.http.delete(path).set('X-CSRF-Token', this.csrf);
  }

  /** The raw session cookie header, to replay it from another client. */
  cookieHeader(res: { headers: Record<string, unknown> }): string {
    const setCookie = res.headers['set-cookie'] as string[];
    return setCookie[0]!.split(';')[0]!;
  }

  async createAgent(name = 'Shopping agent') {
    const res = await this.post('/api/v1/agents', { name });
    if (res.status !== 201)
      throw new Error(`createAgent: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; name: string; status: string };
  }

  async createKey(agentId: string, expiresInDays = 30, label?: string) {
    const res = await this.post(`/api/v1/agents/${agentId}/keys`, {
      expiresInDays,
      ...(label ? { label } : {}),
    });
    if (res.status !== 201) throw new Error(`createKey: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { secret: string; apiKey: { id: string; prefix: string; status: string } };
  }

  async createMerchant(overrides: Record<string, unknown> = {}) {
    const res = await this.post('/api/v1/merchants', {
      displayName: 'Cable Co',
      paypalEmail: `merchant-${randomUUID()}@business.example.test`,
      category: 'electronics',
      ...overrides,
    });
    if (res.status !== 201)
      throw new Error(`createMerchant: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; displayName: string; paypalEmail: string };
  }

  async createTask(input: {
    agentId: string;
    merchantIds: string[];
    budget?: string;
    expiresAt?: Date;
  }) {
    const res = await this.post('/api/v1/tasks', {
      instruction: 'Buy a 2 m USB-C cable under $20',
      budget: { currency: 'USD', value: input.budget ?? '20.00' },
      agentId: input.agentId,
      allowedMerchantIds: input.merchantIds,
      expiresAt: (input.expiresAt ?? new Date(Date.now() + 7 * 86_400_000)).toISOString(),
    });
    if (res.status !== 201)
      throw new Error(`createTask: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; status: string };
  }
}

/** Requests to the agent API with a bearer key. */
export function asAgent(app: Express, secret: string) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${secret}`);
  return {
    get: (path: string) => auth(request(app).get(path)),
    post: (path: string, body?: object) => auth(request(app).post(path)).send(body),
    patch: (path: string, body?: object) => auth(request(app).patch(path)).send(body),
    delete: (path: string) => auth(request(app).delete(path)),
  };
}

/** Everything a user's audit trail contains, oldest first. */
export async function auditActions(userId: string): Promise<string[]> {
  const events = await db().auditEvent.findMany({ where: { userId }, orderBy: { seq: 'asc' } });
  return events.map((e) => e.action);
}
