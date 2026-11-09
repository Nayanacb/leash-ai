import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reserveForPurchase } from '../../src/modules/budget/ledger.js';
import {
  PolicyCompilerError,
  type CompileInput,
  type CompileOutput,
  type PolicyCompiler,
} from '../../src/modules/policies/compiler.js';
import { db, makeApp, PASSWORD, UserClient } from './harness.js';

/** Stand-in for the LLM: returns whatever the test scripts, and records what it was asked. */
class FakeCompiler implements PolicyCompiler {
  calls: CompileInput[] = [];
  next: ((input: CompileInput) => Partial<CompileOutput>) | Error = () => ({});
  async compile(input: CompileInput): Promise<CompileOutput> {
    this.calls.push(input);
    if (this.next instanceof Error) throw this.next;
    return {
      policy: {
        dslVersion: 1,
        currency: input.defaultCurrency,
        timezone: input.defaultTimezone,
        rules: [],
      },
      unmappedClauses: [],
      assumptions: [],
      model: 'fake-model',
      promptVersion: 'test/v1',
      ...this.next(input),
    };
  }
}

const compiler = new FakeCompiler();
const { app } = makeApp({ policyCompiler: compiler });
const LIMITS = { sandboxMaxTransactionMinor: 50_000 };

async function setup() {
  const user = await UserClient.register(app);
  const agent = await user.createAgent();
  const merchant = await user.createMerchant({ displayName: 'Cable Co' });
  const task = await user.createTask({
    agentId: agent.id,
    merchantIds: [merchant.id],
    budget: '400.00',
  });
  return { user, agent, merchant, task };
}

function compileWithRules(user: UserClient, rules: unknown[], extra: Partial<CompileOutput> = {}) {
  compiler.next = (input) => ({
    policy: { dslVersion: 1, currency: 'USD', timezone: input.defaultTimezone, rules },
    ...extra,
  });
  return user.post('/api/v1/policies/compile', {
    sourceText: 'my rules',
    timezone: 'Europe/London',
  });
}

function confirm(
  user: UserClient,
  draft: { id: string; rulesHash: string },
  extra: Record<string, unknown> = {},
) {
  return user.post(`/api/v1/policies/versions/${draft.id}/confirm`, {
    rulesHash: draft.rulesHash,
    password: PASSWORD,
    ...extra,
  });
}

const purchase = (s: Awaited<ReturnType<typeof setup>>, amountMinor: number) =>
  reserveForPurchase(
    db(),
    {
      userId: s.user.user.id,
      agentId: s.agent.id,
      taskId: s.task.id,
      merchantId: s.merchant.id,
      idempotencyKey: randomUUID(),
      requestHash: 'h',
      amountMinor,
      currency: 'USD',
      itemDescription: 'x',
      quantity: 1,
    },
    LIMITS,
  );

describe('compiling natural-language policies', () => {
  it('answers 503 when the LLM is not configured', async () => {
    const { app: unconfigured } = makeApp({ policyCompiler: null });
    const user = await UserClient.register(unconfigured);
    const res = await user.post('/api/v1/policies/compile', {
      sourceText: 'Never spend more than $50',
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('LLM_NOT_CONFIGURED');
  });

  it('creates an inert DRAFT with a deterministic summary', async () => {
    const s = await setup();
    const archived = await s.user.createMerchant({ displayName: 'Old shop' });
    await s.user.patch(`/api/v1/merchants/${archived.id}`, { archived: true });

    const res = await compileWithRules(
      s.user,
      [
        { id: 'cap', type: 'max_amount_per_transaction', amountMinor: 5000, action: 'BLOCK' },
        {
          id: 'week',
          type: 'max_spend_per_period',
          period: 'week',
          amountMinor: 20_000,
          action: 'ESCALATE',
        },
        {
          id: 'only-cable',
          type: 'merchant_allowlist',
          merchantIds: [s.merchant.id],
          action: 'BLOCK',
        },
      ],
      {
        assumptions: ['Weeks run Monday–Sunday.'],
        unmappedClauses: [{ text: 'prefer fast shipping', reason: 'Not a spending rule' }],
      },
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      version: 1,
      compilerModel: 'fake-model',
      rulesHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      assumptions: ['Weeks run Monday–Sunday.'],
      unmappedClauses: [{ text: 'prefer fast shipping', reason: 'Not a spending rule' }],
    });
    expect(res.body.rendered.map((r: { text: string }) => r.text)).toEqual([
      'Block any single purchase over 50.00 USD.',
      'Ask me to approve purchases that would take total spending above 200.00 USD per week (Monday–Sunday).',
      'Block purchases from any merchant other than Cable Co.',
    ]);
    expect(res.body.builtInRules[0]).toContain('500.00 USD');

    // The compiler saw the user's text, defaults, and only active merchants.
    const call = compiler.calls.at(-1)!;
    expect(call).toMatchObject({
      sourceText: 'my rules',
      defaultTimezone: 'Europe/London',
      defaultCurrency: 'USD',
    });
    expect(call.merchants.map((m) => m.id)).toEqual([s.merchant.id]);

    // A draft enforces nothing.
    expect((await purchase(s, 100)).reasonCodes).toEqual(['NO_ACTIVE_POLICY']);
  });

  it('rejects compiler output that references another user’s merchant', async () => {
    const s = await setup();
    const other = await setup();
    const res = await compileWithRules(s.user, [
      { id: 'x', type: 'merchant_allowlist', merchantIds: [other.merchant.id], action: 'BLOCK' },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COMPILED_POLICY_INVALID');
    expect(res.body.error.details[0].message).toContain('unknown merchant');
    expect(await db().policyVersion.count({ where: { userId: s.user.user.id } })).toBe(0);
  });

  it.each([
    ['an unknown rule type', [{ id: 'x', type: 'approve_everything', action: 'BLOCK' }]],
    [
      'a negative amount',
      [{ id: 'x', type: 'max_amount_per_transaction', amountMinor: -1, action: 'BLOCK' }],
    ],
    [
      'a fractional amount',
      [{ id: 'x', type: 'max_amount_per_transaction', amountMinor: 10.5, action: 'BLOCK' }],
    ],
    [
      'an unknown action',
      [{ id: 'x', type: 'max_amount_per_transaction', amountMinor: 100, action: 'ALLOW' }],
    ],
    [
      'duplicate rule ids',
      [
        { id: 'x', type: 'new_merchant', action: 'BLOCK' },
        { id: 'x', type: 'new_merchant', action: 'ESCALATE' },
      ],
    ],
    [
      'an inverted time window',
      [{ id: 'x', type: 'time_window', days: [1], startHour: 18, endHour: 9, action: 'BLOCK' }],
    ],
    ['extra fields', [{ id: 'x', type: 'new_merchant', action: 'BLOCK', override: true }]],
  ])('rejects compiler output with %s', async (_name, rules) => {
    const s = await setup();
    const res = await compileWithRules(s.user, rules);
    expect(res.status).toBe(422);
    expect(await db().policyVersion.count({ where: { userId: s.user.user.id } })).toBe(0);
  });

  it('rejects an invalid time zone from the compiler', async () => {
    const s = await setup();
    compiler.next = () => ({
      policy: { dslVersion: 1, currency: 'USD', timezone: 'Mars/Olympus', rules: [] },
    });
    expect((await s.user.post('/api/v1/policies/compile', { sourceText: 'x' })).status).toBe(422);
  });

  it('surfaces LLM failures without creating anything', async () => {
    const s = await setup();
    compiler.next = new PolicyCompilerError('LLM_REFUSED', 'declined');
    const res = await s.user.post('/api/v1/policies/compile', { sourceText: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LLM_REFUSED');
    expect(await db().policyVersion.count({ where: { userId: s.user.user.id } })).toBe(0);
    const audit = await db().auditEvent.findFirst({
      where: { userId: s.user.user.id, action: 'policy.compile_failed' },
    });
    expect(audit?.data).toMatchObject({ reason: 'LLM_REFUSED' });
  });

  it('rate-limits compilations per user', async () => {
    const { app: limited } = makeApp({
      policyCompiler: compiler,
      rateLimits: { policyCompilesPerUserPerHour: 1 },
    });
    compiler.next = () => ({});
    const user = await UserClient.register(limited);
    expect((await user.post('/api/v1/policies/compile', { sourceText: 'x' })).status).toBe(201);
    expect((await user.post('/api/v1/policies/compile', { sourceText: 'x' })).status).toBe(429);
  });
});

describe('reviewing and confirming', () => {
  it('confirmation requires the password, the reviewed hash, and acknowledgement of unmapped clauses', async () => {
    const s = await setup();
    const draft = (
      await compileWithRules(
        s.user,
        [{ id: 'cap', type: 'max_amount_per_transaction', amountMinor: 5000, action: 'BLOCK' }],
        {
          unmappedClauses: [{ text: 'only eco-friendly brands', reason: 'Not expressible' }],
        },
      )
    ).body;

    const wrongPassword = await confirm(s.user, draft, {
      password: 'not my password',
      acknowledgeUnmapped: true,
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_PASSWORD');

    const wrongHash = await confirm(
      s.user,
      { id: draft.id, rulesHash: '0'.repeat(64) },
      { acknowledgeUnmapped: true },
    );
    expect(wrongHash.status).toBe(409);
    expect(wrongHash.body.error.code).toBe('POLICY_CHANGED');

    const unacknowledged = await confirm(s.user, draft);
    expect(unacknowledged.status).toBe(400);
    expect(unacknowledged.body.error.code).toBe('UNMAPPED_NOT_ACKNOWLEDGED');

    expect((await db().policyVersion.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      'DRAFT',
    );

    const ok = await confirm(s.user, draft, { acknowledgeUnmapped: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ACTIVE', confirmedAt: expect.any(String) });

    // Now enforced by the deterministic engine.
    expect((await purchase(s, 5000)).policyDecision).toBe('ALLOW');
    expect((await purchase(s, 5001)).reasonCodes).toEqual(['AMOUNT_OVER_LIMIT']);

    const actions = (
      await db().auditEvent.findMany({ where: { userId: s.user.user.id }, orderBy: { seq: 'asc' } })
    ).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['policy.draft_compiled', 'user.step_up_failed', 'policy.confirmed']),
    );
  });

  it('a new confirmation supersedes the previous policy', async () => {
    const s = await setup();
    const v1 = (await compileWithRules(s.user, [])).body;
    await confirm(s.user, v1).expect(200);
    const v2 = (
      await compileWithRules(s.user, [{ id: 'n', type: 'new_merchant', action: 'ESCALATE' }])
    ).body;
    await confirm(s.user, v2).expect(200);
    const versions = (await s.user.get('/api/v1/policies/versions')).body.versions;
    expect(versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual(
      [
        [2, 'ACTIVE'],
        [1, 'SUPERSEDED'],
      ],
    );
    expect((await s.user.get('/api/v1/policies/active')).body.policy.id).toBe(v2.id);
  });

  it('concurrent confirmations leave exactly one active policy', async () => {
    const s = await setup();
    const drafts = [];
    for (let i = 0; i < 4; i++) drafts.push((await compileWithRules(s.user, [])).body);
    const results = await Promise.all(drafts.map((d) => confirm(s.user, d)));
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(
      await db().policyVersion.count({ where: { userId: s.user.user.id, status: 'ACTIVE' } }),
    ).toBe(1);
  });

  it('hand-edited JSON is validated, marks the draft edited, and changes the hash to confirm against', async () => {
    const s = await setup();
    const draft = (
      await compileWithRules(s.user, [
        { id: 'cap', type: 'max_amount_per_transaction', amountMinor: 5000, action: 'BLOCK' },
      ])
    ).body;

    const invalid = await s.user.patch(`/api/v1/policies/versions/${draft.id}`, {
      compiledRules: {
        ...draft.compiledRules,
        rules: [
          { id: 'cap', type: 'max_amount_per_transaction', amountMinor: 'lots', action: 'BLOCK' },
        ],
      },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details.length).toBeGreaterThan(0);

    const edited = await s.user.patch(`/api/v1/policies/versions/${draft.id}`, {
      compiledRules: {
        ...draft.compiledRules,
        rules: [
          { id: 'cap', type: 'max_amount_per_transaction', amountMinor: 2500, action: 'BLOCK' },
        ],
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ editedManually: true });
    expect(edited.body.rulesHash).not.toBe(draft.rulesHash);
    expect(edited.body.rendered[0].text).toBe('Block any single purchase over 25.00 USD.');

    // Confirming against the pre-edit hash fails: you confirm what you saw.
    expect((await confirm(s.user, draft)).status).toBe(409);
    expect((await confirm(s.user, edited.body)).status).toBe(200);
  });

  it('the validate endpoint previews without saving', async () => {
    const s = await setup();
    const res = await s.user.post('/api/v1/policies/validate', {
      compiledRules: {
        dslVersion: 1,
        currency: 'USD',
        timezone: 'UTC',
        rules: [{ id: 'n', type: 'new_merchant', action: 'ESCALATE' }],
      },
    });
    expect(res.body).toMatchObject({
      valid: true,
      errors: [],
      rendered: [{ id: 'n', action: 'ESCALATE' }],
    });
    const bad = await s.user.post('/api/v1/policies/validate', {
      compiledRules: { rules: 'nope' },
    });
    expect(bad.body.valid).toBe(false);
    expect(await db().policyVersion.count({ where: { userId: s.user.user.id } })).toBe(0);
  });

  it('confirmed versions cannot be edited, confirmed again, or rejected', async () => {
    const s = await setup();
    const draft = (await compileWithRules(s.user, [])).body;
    await confirm(s.user, draft).expect(200);
    expect(
      (
        await s.user.patch(`/api/v1/policies/versions/${draft.id}`, {
          compiledRules: draft.compiledRules,
        })
      ).status,
    ).toBe(409);
    expect((await confirm(s.user, draft)).status).toBe(409);
    expect((await s.user.post(`/api/v1/policies/versions/${draft.id}/reject`)).status).toBe(409);
    // And the database itself refuses, whatever the application does.
    await expect(
      db().policyVersion.update({ where: { id: draft.id }, data: { assumptions: ['tampered'] } }),
    ).rejects.toThrow(/immutable/);
  });

  it('drafts can be rejected; any version can be duplicated into a new draft', async () => {
    const s = await setup();
    const draft = (
      await compileWithRules(s.user, [{ id: 'n', type: 'new_merchant', action: 'BLOCK' }])
    ).body;
    expect((await s.user.post(`/api/v1/policies/versions/${draft.id}/reject`)).body.status).toBe(
      'REJECTED',
    );
    const copy = await s.user.post(`/api/v1/policies/versions/${draft.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ status: 'DRAFT', version: 2, rulesHash: draft.rulesHash });
  });
});

describe('pausing all spending', () => {
  it('deactivates the policy so everything is blocked, after a password check', async () => {
    const s = await setup();
    const draft = (await compileWithRules(s.user, [])).body;
    await confirm(s.user, draft).expect(200);
    expect((await purchase(s, 100)).policyDecision).toBe('ALLOW');

    expect((await s.user.post('/api/v1/policies/pause', { password: 'wrong' })).status).toBe(401);
    expect((await s.user.post('/api/v1/policies/pause', { password: PASSWORD })).status).toBe(204);
    expect((await purchase(s, 100)).reasonCodes).toEqual(['NO_ACTIVE_POLICY']);
    expect((await s.user.get('/api/v1/policies/active')).body.policy).toBeNull();
    expect((await s.user.post('/api/v1/policies/pause', { password: PASSWORD })).status).toBe(409);
  });
});

describe('simulation and budget status', () => {
  it('simulates a purchase against real spend without reserving anything', async () => {
    const s = await setup();
    const draft = (
      await compileWithRules(s.user, [
        {
          id: 'week',
          type: 'max_spend_per_period',
          period: 'week',
          amountMinor: 10_000,
          action: 'BLOCK',
        },
      ])
    ).body;
    const body = {
      policyVersionId: draft.id,
      taskId: s.task.id,
      merchantId: s.merchant.id,
      amount: { currency: 'USD', value: '60.00' },
    };
    expect((await s.user.post('/api/v1/policies/simulate', body)).body.decision).toBe('ALLOW');

    await confirm(s.user, draft).expect(200);
    await purchase(s, 5000);
    const after = await s.user.post('/api/v1/policies/simulate', {
      ...body,
      policyVersionId: undefined,
    });
    expect(after.body).toMatchObject({ decision: 'BLOCK', reasonCodes: ['PERIOD_SPEND_LIMIT'] });
    expect(after.body.note).toContain('nothing was reserved');
    expect(await db().ledgerEntry.count({ where: { userId: s.user.user.id } })).toBe(1);
  });

  it('reports weekly and monthly spend against the tightest limit', async () => {
    const s = await setup();
    const draft = (
      await compileWithRules(s.user, [
        {
          id: 'w1',
          type: 'max_spend_per_period',
          period: 'week',
          amountMinor: 30_000,
          action: 'ESCALATE',
        },
        {
          id: 'w2',
          type: 'max_spend_per_period',
          period: 'week',
          amountMinor: 20_000,
          action: 'BLOCK',
        },
        {
          id: 'm',
          type: 'max_spend_per_period',
          period: 'month',
          amountMinor: 80_000,
          action: 'BLOCK',
        },
      ])
    ).body;
    await confirm(s.user, draft).expect(200);
    await purchase(s, 4500);

    const status = (await s.user.get('/api/v1/policies/budget-status')).body;
    expect(status).toMatchObject({ hasActivePolicy: true, timezone: 'Europe/London' });
    const byPeriod = Object.fromEntries(
      status.periods.map((p: { period: string }) => [p.period, p]),
    );
    expect(byPeriod.week).toMatchObject({
      committedMinor: 4500,
      transactionCount: 1,
      limitMinor: 20_000,
      limitAction: 'BLOCK',
      remainingMinor: 15_500,
    });
    expect(byPeriod.month).toMatchObject({
      committedMinor: 4500,
      limitMinor: 80_000,
      remainingMinor: 75_500,
    });
    expect(byPeriod.day).toMatchObject({
      committedMinor: 4500,
      limitMinor: null,
      remainingMinor: null,
    });
  });
});

describe('isolation', () => {
  it('users cannot see, confirm, edit or simulate with each other’s policies', async () => {
    const a = await setup();
    const b = await setup();
    const draft = (await compileWithRules(a.user, [])).body;
    expect((await b.user.get(`/api/v1/policies/versions/${draft.id}`)).status).toBe(404);
    expect((await confirm(b.user, draft)).status).toBe(404);
    expect(
      (
        await b.user.patch(`/api/v1/policies/versions/${draft.id}`, {
          compiledRules: draft.compiledRules,
        })
      ).status,
    ).toBe(404);
    expect((await b.user.post(`/api/v1/policies/versions/${draft.id}/duplicate`)).status).toBe(404);
    expect(
      (
        await b.user.post('/api/v1/policies/simulate', {
          policyVersionId: draft.id,
          taskId: b.task.id,
          merchantId: b.merchant.id,
          amount: { currency: 'USD', value: '1.00' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await b.user.post('/api/v1/policies/simulate', {
          taskId: a.task.id,
          merchantId: a.merchant.id,
          amount: { currency: 'USD', value: '1.00' },
        })
      ).status,
    ).toBe(404);
    expect((await b.user.get('/api/v1/policies/versions')).body.versions).toEqual([]);
  });
});
