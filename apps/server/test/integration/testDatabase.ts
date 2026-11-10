import 'dotenv/config';
import { inject } from 'vitest';

/**
 * Integration tests run against TEST_DATABASE_URL only, and refuse to run
 * against anything that does not look like a throwaway test database.
 */
export function baseTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set (see apps/server/.env.example)');
  }
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against "${dbName}": name must end with "_test"`,
    );
  }
  return url;
}

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

/** URL of the freshly migrated schema created for this test run (see globalSetup.ts). */
export function testDatabaseUrl(): string {
  return inject('testDatabaseUrl');
}
