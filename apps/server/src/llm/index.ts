import type { AppConfig } from '../config/env.js';
import type { PolicyCompiler } from '../modules/policies/compiler.js';
import { createAnthropicClient } from './anthropic.js';
import { AnthropicPolicyCompiler } from './policyCompiler.js';
import { AnthropicPurchaseEvaluators } from './purchaseEvaluators.js';
import type { PurchaseEvaluators } from '../modules/evaluation/evaluators.js';

/** Builds the policy compiler from configuration, or null when it isn't configured. */
export function policyCompilerFromConfig(config: AppConfig): PolicyCompiler | null {
  const { apiKey, policyCompilerModel, policyCompilerTimeoutMs, policyCompilerEffort } = config.llm;
  if (!apiKey || !policyCompilerModel) return null;
  return new AnthropicPolicyCompiler({
    client: createAnthropicClient({ apiKey, timeoutMs: policyCompilerTimeoutMs }),
    model: policyCompilerModel,
    effort: policyCompilerEffort,
  });
}

/** Builds the injection classifier + intent verifier, or null when not configured (purchases then fail closed). */
export function purchaseEvaluatorsFromConfig(config: AppConfig): PurchaseEvaluators | null {
  const { apiKey, classifierModel, classifierTimeoutMs, classifierEffort } = config.llm;
  if (!apiKey || !classifierModel) return null;
  return new AnthropicPurchaseEvaluators({
    client: createAnthropicClient({ apiKey, timeoutMs: classifierTimeoutMs }),
    model: classifierModel,
    timeoutMs: classifierTimeoutMs,
    effort: classifierEffort,
  });
}
