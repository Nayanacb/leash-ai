import {
  DEFAULT_APPROVAL_TTL_MINUTES,
  DEFAULT_AUTHORIZATION_TTL_MINUTES,
  SANDBOX_MAX_TRANSACTION_MINOR,
} from '@leash/shared';
import { z } from 'zod';
import { findLivePayPalReferences, PAYPAL_SANDBOX_API_BASE } from './paypalSandbox.js';

/** Treats unset and blank variables the same, so `.env` placeholders like `FOO=` are "unset". */
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().min(1).optional(),
);

/** Model IDs are configuration, never hard-coded; we only check the shape here. */
const optionalModelId = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._:@/-]{1,127}$/i, 'must look like a model identifier')
    .optional(),
);

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// or postgresql:// URL');

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: postgresUrl,
    WEB_ORIGIN: z.url().default('http://localhost:5173'),

    /** Hard limit on a session's lifetime, regardless of activity. */
    SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
    /** A session unused for this long is rejected. */
    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(10_080).default(720),

    PAYPAL_ENV: z.literal('sandbox', {
      error: 'PAYPAL_ENV must be "sandbox". Live PayPal is not permitted.',
    }),
    PAYPAL_CLIENT_ID: optionalString,
    PAYPAL_CLIENT_SECRET: optionalString,
    PAYPAL_WEBHOOK_ID: optionalString,

    ANTHROPIC_API_KEY: optionalString,
    LLM_MODEL_POLICY_COMPILER: optionalModelId,
    LLM_MODEL_CLASSIFIER: optionalModelId,
    /** Per-request timeout for policy compilation. Compilation is interactive but not latency-critical. */
    LLM_POLICY_COMPILER_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
    /**
     * Optional `output_config.effort` for the compiler. Leave unset unless your
     * chosen model supports the effort parameter (sending it to a model that
     * does not will fail the request).
     */
    LLM_POLICY_COMPILER_EFFORT: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    ),

    APPROVAL_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(1440)
      .default(DEFAULT_APPROVAL_TTL_MINUTES),
    AUTHORIZATION_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(120)
      .default(DEFAULT_AUTHORIZATION_TTL_MINUTES),
    /** A purchase still EVALUATING after this long is expired and its funds released. */
    EVALUATION_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
    /** How often the reservation sweep runs. */
    RESERVATION_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    SANDBOX_MAX_TRANSACTION_MINOR: z.coerce
      .number()
      .int()
      .min(1)
      .max(SANDBOX_MAX_TRANSACTION_MINOR, {
        error: `SANDBOX_MAX_TRANSACTION_MINOR may not exceed ${SANDBOX_MAX_TRANSACTION_MINOR} ($500.00)`,
      })
      .default(SANDBOX_MAX_TRANSACTION_MINOR),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.PAYPAL_CLIENT_ID) !== Boolean(env.PAYPAL_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYPAL_CLIENT_SECRET'],
        message: 'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set together',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  databaseUrl: string;
  webOrigin: string;
  /** Origins allowed to make state-changing browser requests (CSRF origin check). */
  allowedOrigins: string[];
  session: {
    absoluteTtlMs: number;
    idleTimeoutMs: number;
    /** Secure cookies (and the __Host- prefix) outside local development. */
    secureCookie: boolean;
  };
  paypal: {
    environment: 'sandbox';
    apiBase: typeof PAYPAL_SANDBOX_API_BASE;
    clientId: string | undefined;
    clientSecret: string | undefined;
    webhookId: string | undefined;
    /** True once sandbox credentials are present (required from Phase 7). */
    configured: boolean;
  };
  llm: {
    apiKey: string | undefined;
    policyCompilerModel: string | undefined;
    classifierModel: string | undefined;
    policyCompilerTimeoutMs: number;
    policyCompilerEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
    /** True once the API key and the compiler model are set (needed to compile policies). */
    policyCompilerConfigured: boolean;
    /** True once the key and both model IDs are present. */
    configured: boolean;
  };
  jobs: {
    evaluationTimeoutMs: number;
    sweepIntervalMs: number;
  };
  limits: {
    approvalTtlMinutes: number;
    authorizationTtlMinutes: number;
    sandboxMaxTransactionMinor: number;
  };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Validates raw environment variables. Pure: does not read process.env itself. */
export function parseConfig(raw: Record<string, string | undefined>): AppConfig {
  const problems = findLivePayPalReferences(raw);
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  }
  if (problems.length > 0 || !result.success) {
    throw new ConfigError(problems);
  }
  const env = result.data;

  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    webOrigin: env.WEB_ORIGIN,
    allowedOrigins: allowedOriginsFor(env.WEB_ORIGIN, env.NODE_ENV),
    session: {
      absoluteTtlMs: env.SESSION_ABSOLUTE_TTL_HOURS * 3_600_000,
      idleTimeoutMs: env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000,
      secureCookie: env.NODE_ENV === 'production',
    },
    paypal: {
      environment: 'sandbox',
      apiBase: PAYPAL_SANDBOX_API_BASE,
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      webhookId: env.PAYPAL_WEBHOOK_ID,
      configured: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
    },
    llm: {
      apiKey: env.ANTHROPIC_API_KEY,
      policyCompilerModel: env.LLM_MODEL_POLICY_COMPILER,
      classifierModel: env.LLM_MODEL_CLASSIFIER,
      policyCompilerTimeoutMs: env.LLM_POLICY_COMPILER_TIMEOUT_MS,
      policyCompilerEffort: env.LLM_POLICY_COMPILER_EFFORT,
      policyCompilerConfigured: Boolean(env.ANTHROPIC_API_KEY && env.LLM_MODEL_POLICY_COMPILER),
      configured: Boolean(
        env.ANTHROPIC_API_KEY && env.LLM_MODEL_POLICY_COMPILER && env.LLM_MODEL_CLASSIFIER,
      ),
    },
    jobs: {
      evaluationTimeoutMs: env.EVALUATION_TIMEOUT_SECONDS * 1000,
      sweepIntervalMs: env.RESERVATION_SWEEP_INTERVAL_SECONDS * 1000,
    },
    limits: {
      approvalTtlMinutes: env.APPROVAL_TTL_MINUTES,
      authorizationTtlMinutes: env.AUTHORIZATION_TTL_MINUTES,
      sandboxMaxTransactionMinor: env.SANDBOX_MAX_TRANSACTION_MINOR,
    },
  };
}

/**
 * The configured dashboard origin. In development the localhost/127.0.0.1
 * twin is also accepted, since browsers treat them as different origins.
 */
function allowedOriginsFor(webOrigin: string, nodeEnv: Env['NODE_ENV']): string[] {
  const origin = new URL(webOrigin).origin;
  const origins = new Set([origin]);
  if (nodeEnv !== 'production') {
    const url = new URL(origin);
    if (url.hostname === 'localhost') origins.add(origin.replace('//localhost', '//127.0.0.1'));
    if (url.hostname === '127.0.0.1') origins.add(origin.replace('//127.0.0.1', '//localhost'));
  }
  return [...origins];
}
