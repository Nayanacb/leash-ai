import { execFileSync } from 'node:child_process';
import { testDatabaseUrl } from './testDatabase.js';

/**
 * Applies any pending migrations to the test database before the suite.
 *
 * This is deliberately non-destructive (`migrate deploy`, not `migrate reset`):
 * tests create uniquely-keyed data and never depend on an empty database, so
 * no data needs to be wiped. To start from a clean slate, recreate the
 * container volume (`docker compose down -v && npm run db:up`).
 */
export default function setup() {
  const url = testDatabaseUrl();
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
