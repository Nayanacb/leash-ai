import type { AppConfig } from '../config/env.js';
import type { PolicyCompiler } from '../modules/policies/compiler.js';
import { createAnthropicClient } from './anthropic.js';
import { AnthropicPolicyCompiler } from './policyCompiler.js';

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
