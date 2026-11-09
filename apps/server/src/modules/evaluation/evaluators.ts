import type { Currency, SourceContextItem } from '@leash/shared';

/**
 * Advisory AI evaluators. Their outputs become signals for the deterministic
 * combiner; they never decide anything themselves.
 */

export interface PurchaseForEvaluation {
  /** Written by the user (trusted). */
  taskInstruction: string;
  /** From the user's merchant registry (trusted). */
  merchant: { displayName: string; category: string };
  amount: { currency: Currency; value: string };
  /** Everything below is agent-supplied and UNTRUSTED. */
  item: { description: string; quantity: number; category?: string | undefined };
  justification?: string | undefined;
  sourceContext: SourceContextItem[];
}

export interface ClassifierOutcome {
  verdict: 'clean' | 'suspicious' | 'malicious';
  confidence: number;
  findings: { source: string; excerpt: string; reason: string }[];
  model: string;
  promptVersion: string;
}

export interface IntentOutcome {
  verdict: 'match' | 'partial' | 'mismatch' | 'uncertain';
  confidence: number;
  reasons: string[];
  model: string;
  promptVersion: string;
}

export interface PurchaseEvaluators {
  classifyInjection(input: PurchaseForEvaluation, signal: AbortSignal): Promise<ClassifierOutcome>;
  verifyIntent(input: PurchaseForEvaluation, signal: AbortSignal): Promise<IntentOutcome>;
}

export type AiEvaluationErrorCode =
  'LLM_TIMEOUT' | 'LLM_REFUSED' | 'LLM_TRUNCATED' | 'LLM_INVALID_OUTPUT' | 'LLM_UNAVAILABLE';

export class AiEvaluationError extends Error {
  constructor(
    public readonly code: AiEvaluationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiEvaluationError';
  }
}
