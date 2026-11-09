import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import {
  AiEvaluationError,
  type ClassifierOutcome,
  type IntentOutcome,
  type PurchaseEvaluators,
  type PurchaseForEvaluation,
} from '../modules/evaluation/evaluators.js';
import {
  buildClassifierMessage,
  buildIntentMessage,
  ClassifierOutputSchema,
  INJECTION_CLASSIFIER_PROMPT_VERSION,
  INJECTION_CLASSIFIER_SYSTEM_PROMPT,
  INTENT_VERIFIER_PROMPT_VERSION,
  INTENT_VERIFIER_SYSTEM_PROMPT,
  IntentOutputSchema,
} from './prompts/purchaseEvaluation.js';

export interface AnthropicPurchaseEvaluatorOptions {
  client: Anthropic;
  /** From LLM_MODEL_CLASSIFIER. Never hard-coded. */
  model: string;
  timeoutMs: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
}

/**
 * Injection classifier and intent verifier on the Anthropic Messages API.
 * Strict per-call timeout, no retries (a slow answer must not delay the
 * decision — it simply escalates), structured outputs, no tools.
 */
export class AnthropicPurchaseEvaluators implements PurchaseEvaluators {
  constructor(private readonly options: AnthropicPurchaseEvaluatorOptions) {}

  async classifyInjection(
    input: PurchaseForEvaluation,
    signal: AbortSignal,
  ): Promise<ClassifierOutcome> {
    const { output, model } = await this.call(
      INJECTION_CLASSIFIER_SYSTEM_PROMPT,
      buildClassifierMessage(input),
      ClassifierOutputSchema,
      signal,
    );
    return {
      ...output,
      findings: output.findings.slice(0, 20),
      model,
      promptVersion: INJECTION_CLASSIFIER_PROMPT_VERSION,
    };
  }

  async verifyIntent(input: PurchaseForEvaluation, signal: AbortSignal): Promise<IntentOutcome> {
    const { output, model } = await this.call(
      INTENT_VERIFIER_SYSTEM_PROMPT,
      buildIntentMessage(input),
      IntentOutputSchema,
      signal,
    );
    return {
      ...output,
      reasons: output.reasons.slice(0, 10),
      model,
      promptVersion: INTENT_VERIFIER_PROMPT_VERSION,
    };
  }

  private async call<S extends z.ZodType<{ confidence: number }>>(
    system: string,
    user: string,
    schema: S,
    signal: AbortSignal,
  ): Promise<{ output: z.infer<S>; model: string }> {
    let response: Anthropic.Message;
    try {
      response = await this.options.client.messages.create(
        {
          model: this.options.model,
          max_tokens: 2_000,
          system,
          messages: [{ role: 'user', content: user }],
          output_config: {
            format: { type: 'json_schema', schema: zodOutputFormat(schema).schema },
            ...(this.options.effort ? { effort: this.options.effort } : {}),
          },
        },
        { timeout: this.options.timeoutMs, maxRetries: 0, signal },
      );
    } catch (err) {
      if (
        err instanceof Anthropic.APIConnectionTimeoutError ||
        err instanceof Anthropic.APIUserAbortError
      ) {
        throw new AiEvaluationError('LLM_TIMEOUT', 'the model did not answer in time');
      }
      if (err instanceof Anthropic.APIError) {
        throw new AiEvaluationError(
          'LLM_UNAVAILABLE',
          `model provider error ${err.status ?? ''}`.trim(),
        );
      }
      throw new AiEvaluationError('LLM_UNAVAILABLE', 'model provider unreachable');
    }

    if (response.stop_reason === 'refusal')
      throw new AiEvaluationError('LLM_REFUSED', 'the model declined to evaluate');
    if (response.stop_reason === 'max_tokens')
      throw new AiEvaluationError('LLM_TRUNCATED', 'the evaluation was cut off');

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AiEvaluationError(
        'LLM_INVALID_OUTPUT',
        'the model returned output that is not JSON',
      );
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success || parsed.data.confidence < 0 || parsed.data.confidence > 1) {
      throw new AiEvaluationError(
        'LLM_INVALID_OUTPUT',
        'the model returned output in the wrong shape',
      );
    }
    return { output: parsed.data, model: response.model };
  }
}
