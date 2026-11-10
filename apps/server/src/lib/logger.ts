import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Paths that must never reach logs. Covers HTTP credentials and any object
 * field that looks like a secret (PayPal/Anthropic keys, passwords, tokens).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.apiKey',
  '*.clientSecret',
  '*.secret',
  'paypal.clientSecret',
  'llm.apiKey',
];

export function createLogger(
  options: { level: string; pretty: boolean },
  destination?: DestinationStream,
): Logger {
  const loggerOptions = {
    level: options.level,
    base: { service: 'leash-server' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,service',
            },
          },
        }
      : {}),
  };
  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
}

export type { Logger };
