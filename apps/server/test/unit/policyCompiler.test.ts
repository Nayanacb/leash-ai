import { describe, expect, it } from 'vitest';
import { createAnthropicClient } from '../../src/llm/anthropic.js';
import { AnthropicPolicyCompiler } from '../../src/llm/policyCompiler.js';
import { POLICY_COMPILER_PROMPT_VERSION } from '../../src/llm/prompts/policyCompiler.js';
import { PolicyCompilerError, type CompileInput } from '../../src/modules/policies/compiler.js';

const MERCHANT = '0196a1b2-c3d4-7e5f-8a9b-000000000001';
const INPUT: CompileInput = {
  sourceText: 'Never spend more than $50 on one purchase. Ask me before buying from Cable Co.',
  defaultCurrency: 'USD',
  defaultTimezone: 'Europe/London',
  merchants: [{ id: MERCHANT, displayName: 'Cable Co', category: 'electronics' }],
};

const GOOD_OUTPUT = {
  policy: {
    dslVersion: 1,
    currency: 'USD',
    timezone: 'Europe/London',
    rules: [
      {
        id: 'max-per-purchase',
        action: 'BLOCK',
        type: 'max_amount_per_transaction',
        amountMinor: 5000,
      },
      {
        id: 'ask-cable-co',
        action: 'ESCALATE',
        type: 'merchant_blocklist',
        merchantIds: [MERCHANT],
      },
    ],
  },
  unmappedClauses: [],
  assumptions: ['Read "$50" as 50.00 USD.'],
};

function message(text: string, stop_reason = 'end_turn', model = 'model-from-api') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function stubbedCompiler(
  respond: () => Response,
  options: { model?: string; effort?: 'low' } = {},
) {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetchStub = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    return respond();
  };
  const client = createAnthropicClient({
    apiKey: 'test-key-not-real',
    timeoutMs: 5000,
    fetch: fetchStub as typeof fetch,
  });
  const compiler = new AnthropicPolicyCompiler({
    client,
    model: options.model ?? 'configured-model-id',
    effort: options.effort,
  });
  return { compiler, requests };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AnthropicPolicyCompiler — request contract', () => {
  it('sends the configured model with a structured-output schema, a system prompt, and no tools', async () => {
    const { compiler, requests } = stubbedCompiler(() =>
      json(200, message(JSON.stringify(GOOD_OUTPUT))),
    );
    await compiler.compile(INPUT);

    expect(requests).toHaveLength(1);
    const { url, body, headers } = requests[0]!;
    expect(url).toMatch(/\/v1\/messages$/);
    // The key is sent only to the API, by the SDK (header name depends on SDK version).
    expect(`${headers.get('x-api-key') ?? ''} ${headers.get('authorization') ?? ''}`).toContain(
      'test-key-not-real',
    );
    expect(body.model).toBe('configured-model-id');
    expect(body.tools).toBeUndefined();
    expect(body.system).toEqual(expect.stringContaining('Leash Policy DSL'));
    const format = (
      body.output_config as { format: { type: string; schema: Record<string, unknown> } }
    ).format;
    expect(format.type).toBe('json_schema');
    expect(JSON.stringify(format.schema)).toContain('max_spend_per_period');
    expect((body.output_config as Record<string, unknown>).effort).toBeUndefined();

    // The user's text is delimited as data, alongside the defaults and merchant list.
    const userContent = (body.messages as { role: string; content: string }[])[0]!;
    expect(userContent.role).toBe('user');
    expect(userContent.content).toContain('<spending_rules>\nNever spend more than $50');
    expect(userContent.content).toContain(MERCHANT);
    expect(userContent.content).toContain('timezone: Europe/London');
  });

  it('sends effort only when configured', async () => {
    const { compiler, requests } = stubbedCompiler(
      () => json(200, message(JSON.stringify(GOOD_OUTPUT))),
      { effort: 'low' },
    );
    await compiler.compile(INPUT);
    expect((requests[0]!.body.output_config as Record<string, unknown>).effort).toBe('low');
  });

  it('returns the parsed draft with the model the API reports and the prompt version', async () => {
    const { compiler } = stubbedCompiler(() => json(200, message(JSON.stringify(GOOD_OUTPUT))));
    const out = await compiler.compile(INPUT);
    expect(out).toEqual({
      policy: GOOD_OUTPUT.policy,
      unmappedClauses: [],
      assumptions: GOOD_OUTPUT.assumptions,
      model: 'model-from-api',
      promptVersion: POLICY_COMPILER_PROMPT_VERSION,
    });
  });
});

describe('AnthropicPolicyCompiler — failures never produce a policy', () => {
  async function failureCode(respond: () => Response): Promise<string> {
    const { compiler } = stubbedCompiler(respond);
    const err = await compiler.compile(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyCompilerError);
    return (err as PolicyCompilerError).code;
  }

  it('refusal', async () => {
    expect(await failureCode(() => json(200, message('', 'refusal')))).toBe('LLM_REFUSED');
  });

  it('truncation', async () => {
    expect(await failureCode(() => json(200, message('{"policy":', 'max_tokens')))).toBe(
      'LLM_TRUNCATED',
    );
  });

  it('output that is not JSON', async () => {
    expect(await failureCode(() => json(200, message('Sure! Here is your policy...')))).toBe(
      'LLM_INVALID_OUTPUT',
    );
  });

  it('JSON that does not match the output schema', async () => {
    expect(
      await failureCode(() =>
        json(200, message(JSON.stringify({ policy: { rules: 'all of them' } }))),
      ),
    ).toBe('LLM_INVALID_OUTPUT');
  });

  it('bad API key', async () => {
    expect(
      await failureCode(() =>
        json(401, {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
      ),
    ).toBe('LLM_AUTH_FAILED');
  });

  it('unknown model ID', async () => {
    expect(
      await failureCode(() =>
        json(404, { type: 'error', error: { type: 'not_found_error', message: 'model: nope' } }),
      ),
    ).toBe('LLM_MODEL_NOT_FOUND');
  });
});
