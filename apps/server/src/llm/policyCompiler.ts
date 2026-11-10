import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  PolicyCompilerError,
  type CompileInput,
  type CompileOutput,
  type PolicyCompiler,
} from '../modules/policies/compiler.js';
import {
  buildPolicyCompilerUserMessage,
  CompilerOutputSchema,
  POLICY_COMPILER_PROMPT_VERSION,
  POLICY_COMPILER_SYSTEM_PROMPT,
} from './prompts/policyCompiler.js';

export interface AnthropicPolicyCompilerOptions {
  client: Anthropic;
  /** From LLM_MODEL_POLICY_COMPILER. Never hard-coded. */
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
  maxTokens?: number;
}

/**
 * Policy compiler backed by the Anthropic Messages API with structured
 * outputs. The model gets no tools and no access to anything but the text it
 * is asked to translate. Any refusal, truncation or malformed output is an
 * error — nothing partial is ever returned.
 */
export class AnthropicPolicyCompiler implements PolicyCompiler {
  constructor(private readonly options: AnthropicPolicyCompilerOptions) {}

  async compile(input: CompileInput): Promise<CompileOutput> {
    // JSON schema generated from the Zod output schema (unsupported constraints are stripped by the SDK helper).
    const { schema } = zodOutputFormat(CompilerOutputSchema);

    let response: Anthropic.Message;
    try {
      // messages.create (not .parse) so stop_reason is inspected before any parsing:
      // a refusal or truncation must be reported as such, never as "bad JSON".
      response = await this.options.client.messages.create({
        model: this.options.model,
        max_tokens: this.options.maxTokens ?? 8_000,
        system: POLICY_COMPILER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPolicyCompilerUserMessage(input) }],
        output_config: {
          format: { type: 'json_schema', schema },
          ...(this.options.effort ? { effort: this.options.effort } : {}),
        },
      });
    } catch (err) {
      throw toCompilerError(err);
    }

    if (response.stop_reason === 'refusal') {
      throw new PolicyCompilerError(
        'LLM_REFUSED',
        'The model declined to compile this policy. Rephrase the rules and try again.',
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new PolicyCompilerError(
        'LLM_TRUNCATED',
        'The compiled policy was too long. Try fewer or simpler rules.',
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new PolicyCompilerError(
        'LLM_INVALID_OUTPUT',
        'The model returned output that is not valid JSON.',
      );
    }
    const parsed = CompilerOutputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PolicyCompilerError(
        'LLM_INVALID_OUTPUT',
        'The model returned output that does not match the policy format.',
      );
    }

    return {
      policy: parsed.data.policy,
      unmappedClauses: parsed.data.unmappedClauses,
      assumptions: parsed.data.assumptions,
      model: response.model,
      promptVersion: POLICY_COMPILER_PROMPT_VERSION,
    };
  }
}

function toCompilerError(err: unknown): PolicyCompilerError {
  if (err instanceof PolicyCompilerError) return err;
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return new PolicyCompilerError(
      'LLM_AUTH_FAILED',
      'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.',
    );
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new PolicyCompilerError(
      'LLM_MODEL_NOT_FOUND',
      'The configured compiler model was not found. Check LLM_MODEL_POLICY_COMPILER.',
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new PolicyCompilerError(
      'LLM_RATE_LIMITED',
      'The model provider is rate limiting requests. Try again shortly.',
    );
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new PolicyCompilerError(
      'LLM_UNAVAILABLE',
      `The model provider rejected the request: ${err.message}`,
    );
  }
  return new PolicyCompilerError(
    'LLM_UNAVAILABLE',
    'The policy compiler is unavailable right now. Try again shortly.',
  );
}
