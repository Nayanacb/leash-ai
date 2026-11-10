import Anthropic from '@anthropic-ai/sdk';

/**
 * The only place an Anthropic client is constructed. The key comes from the
 * validated config; model IDs are always passed in by callers from config.
 */
export function createAnthropicClient(options: {
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: 2,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
