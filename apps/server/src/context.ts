import type { AppConfig } from './config/env.js';
import type { Database } from './db.js';
import type { Logger } from './lib/logger.js';
import type { RateLimiters } from './middleware/rateLimit.js';
import type { PurchaseEvaluators } from './modules/evaluation/evaluators.js';
import type { PaymentProvider } from './modules/payments/provider.js';
import type { PolicyCompiler } from './modules/policies/compiler.js';

/** Dependencies shared by every router. */
export interface AppContext {
  config: AppConfig;
  db: Database;
  logger: Logger;
  limiters: RateLimiters;
  /** Null when the LLM is not configured; compilation then answers 503. */
  policyCompiler: PolicyCompiler | null;
  /** Null when the classifier is not configured; purchases then fail closed (escalate). */
  purchaseEvaluators: PurchaseEvaluators | null;
  /** Null when PayPal sandbox credentials aren't set; checkout then answers 503. */
  paymentProvider: PaymentProvider | null;
}
