import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type {
  ClassifierOutcome,
  IntentOutcome,
  PurchaseEvaluators,
  PurchaseForEvaluation,
} from '../../src/modules/evaluation/evaluators.js';
import { AiEvaluationError } from '../../src/modules/evaluation/evaluators.js';
import { asAgent, PASSWORD, UserClient } from './harness.js';

type Script<T> =
  Partial<T> | Error | 'hang' | ((input: PurchaseForEvaluation) => Promise<Partial<T>>);

/** Scriptable stand-in for the LLM classifier and intent verifier. */
export class FakeEvaluators implements PurchaseEvaluators {
  injection: Script<ClassifierOutcome> = {};
  intent: Script<IntentOutcome> = {};
  calls = { injection: 0, intent: 0 };
  seen: PurchaseForEvaluation[] = [];

  reset() {
    this.injection = {};
    this.intent = {};
    this.calls = { injection: 0, intent: 0 };
    this.seen = [];
  }

  private async run<T>(
    script: Script<T>,
    input: PurchaseForEvaluation,
    signal: AbortSignal,
    base: T,
  ): Promise<T> {
    if (script instanceof Error) throw script;
    if (script === 'hang') {
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () =>
          reject(new AiEvaluationError('LLM_TIMEOUT', 'aborted')),
        ),
      );
    }
    const extra = typeof script === 'function' ? await script(input) : script;
    return { ...base, ...extra };
  }

  async classifyInjection(
    input: PurchaseForEvaluation,
    signal: AbortSignal,
  ): Promise<ClassifierOutcome> {
    this.calls.injection++;
    this.seen.push(input);
    return this.run(this.injection, input, signal, {
      verdict: 'clean',
      confidence: 0.95,
      findings: [],
      model: 'fake-classifier',
      promptVersion: 'test',
    });
  }

  async verifyIntent(input: PurchaseForEvaluation, signal: AbortSignal): Promise<IntentOutcome> {
    this.calls.intent++;
    return this.run(this.intent, input, signal, {
      verdict: 'match',
      confidence: 0.9,
      reasons: ['consistent'],
      model: 'fake-classifier',
      promptVersion: 'test',
    });
  }
}

/** A user with an agent + key, two merchants, a task, and an active policy (created via JSON + confirmation). */
export async function setupPurchaser(app: Express, rules: unknown[] = [], taskBudget = '400.00') {
  const user = await UserClient.register(app);
  const agent = await user.createAgent('Buyer bot');
  const { secret } = await user.createKey(agent.id);
  const merchant = await user.createMerchant({ displayName: 'Cable Co' });
  const other = await user.createMerchant({
    displayName: 'Paper Planet',
    category: 'office_supplies',
  });
  const task = await user.createTask({
    agentId: agent.id,
    merchantIds: [merchant.id, other.id],
    budget: taskBudget,
  });
  if (rules !== null) {
    const draft = await user.post('/api/v1/policies/drafts', {
      compiledRules: { dslVersion: 1, currency: 'USD', timezone: 'UTC', rules },
    });
    if (draft.status !== 201) throw new Error(`draft: ${JSON.stringify(draft.body)}`);
    const confirmed = await user.post(`/api/v1/policies/versions/${draft.body.id}/confirm`, {
      rulesHash: draft.body.rulesHash,
      password: PASSWORD,
    });
    if (confirmed.status !== 200) throw new Error(`confirm: ${JSON.stringify(confirmed.body)}`);
  }
  const bot = asAgent(app, secret);
  const body = (overrides: Record<string, unknown> = {}) => ({
    taskId: task.id,
    merchantId: merchant.id,
    amount: { currency: 'USD', value: '18.99' },
    item: { description: 'USB-C cable, 2 m', quantity: 1 },
    justification: 'The cheapest 2 m cable from an allowed merchant.',
    sourceContext: [
      {
        kind: 'web_page',
        url: 'https://cable.example/p/1',
        title: 'USB-C cable',
        content: 'USB-C cable 2 m. $18.99.',
      },
    ],
    ...overrides,
  });
  const purchase = (overrides: Record<string, unknown> = {}, key: string = randomUUID()) =>
    bot.post('/api/agent/v1/purchase-requests', body(overrides)).set('Idempotency-Key', key);
  return { user, agent, secret, bot, merchant, other, task, body, purchase };
}
