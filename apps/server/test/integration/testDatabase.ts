import 'dotenv/config';

/**
 * Integration tests run against TEST_DATABASE_URL only, and refuse to run
 * against anything that does not look like a throwaway test database.
 */
export function testDatabaseUrl(): string {
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
