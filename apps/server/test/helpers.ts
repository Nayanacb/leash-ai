import { Writable } from 'node:stream';
import { parseConfig, type AppConfig } from '../src/config/env.js';
import { createLogger, type Logger } from '../src/lib/logger.js';

export const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://leash:pw@localhost:5433/leash_test',
  PAYPAL_ENV: 'sandbox',
} as const;

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({ ...BASE_ENV, ...overrides });
}

/** A logger that captures JSON lines in memory instead of printing. */
export function captureLogger(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const logger = createLogger({ level: 'debug', pretty: false }, stream);
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
