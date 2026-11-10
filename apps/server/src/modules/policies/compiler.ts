import type { Currency, MerchantCategory, UnmappedClause } from '@leash/shared';

/**
 * The policy compiler turns a user's natural-language rules into a *draft*
 * Policy DSL document. Its output is untrusted: it is strictly validated, shown
 * to the user as a deterministic rendering, and only becomes enforceable when
 * the user confirms it. The compiler never authorizes anything.
 */

export interface CompileInput {
  sourceText: string;
  /** Defaults the compiler should use when the text does not say. */
  defaultCurrency: Currency;
  defaultTimezone: string;
  /** The user's registered merchants. The compiler may only reference these IDs. */
  merchants: { id: string; displayName: string; category: MerchantCategory }[];
}

export interface CompileOutput {
  /** Unvalidated policy document as produced by the model. */
  policy: unknown;
  unmappedClauses: UnmappedClause[];
  assumptions: string[];
  /** Model ID that served the request (as reported by the API). */
  model: string;
  promptVersion: string;
}

export interface PolicyCompiler {
  compile(input: CompileInput): Promise<CompileOutput>;
}

export type CompilerErrorCode =
  | 'LLM_REFUSED'
  | 'LLM_TRUNCATED'
  | 'LLM_INVALID_OUTPUT'
  | 'LLM_UNAVAILABLE'
  | 'LLM_AUTH_FAILED'
  | 'LLM_MODEL_NOT_FOUND'
  | 'LLM_RATE_LIMITED';

export class PolicyCompilerError extends Error {
  constructor(
    public readonly code: CompilerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyCompilerError';
  }
}
