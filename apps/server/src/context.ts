import type { AppConfig } from './config/env.js';
import type { Database } from './db.js';
import type { Logger } from './lib/logger.js';
import type { RateLimiters } from './middleware/rateLimit.js';
import type { PolicyCompiler } from './modules/policies/compiler.js';

/** Dependencies shared by every router. */
export interface AppContext {
  config: AppConfig;
  db: Database;
  logger: Logger;
  limiters: RateLimiters;
  /** Null when the LLM is not configured; compilation then answers 503. */
  policyCompiler: PolicyCompiler | null;
}
