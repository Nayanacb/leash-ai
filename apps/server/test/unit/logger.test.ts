import { describe, expect, it } from 'vitest';
import { captureLogger } from '../helpers.js';

describe('logger redaction', () => {
  it('never writes credentials or secrets', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        req: { headers: { authorization: 'Bearer lsh_secret', cookie: 'sid=abc' } },
        paypal: { clientSecret: 'pp-secret' },
        llm: { apiKey: 'sk-ant-secret' },
        user: { password: 'hunter2', passwordHash: '$argon2id$...' },
      },
      'test',
    );
    const output = JSON.stringify(lines());
    for (const secret of [
      'lsh_secret',
      'sid=abc',
      'pp-secret',
      'sk-ant-secret',
      'hunter2',
      '$argon2id$',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[REDACTED]');
  });
});
