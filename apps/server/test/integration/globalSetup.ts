import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import { createDatabase } from '../../src/db.js';
import { baseTestDatabaseUrl } from './testDatabase.js';

/**
 * Each integration run gets its own Postgres schema inside the test database,
 * migrated from scratch with the non-destructive `prisma migrate deploy`.
 * Nothing that existed before the run is read, modified or deleted; the
 * run's own schema is dropped afterwards. This keeps runs independent (e.g.
 * the audit chain starts at genesis every time).
 */
export default function setup(project: TestProject) {
  const base = baseTestDatabaseUrl();
  const schema = `it_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const url = new URL(base);
  url.searchParams.set('schema', schema);

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
  });
  project.provide('testDatabaseUrl', url.toString());

  return async () => {
    if (process.env.KEEP_TEST_SCHEMA === '1') return;
    const db = createDatabase(base);
    try {
      // Drops only the schema this run created (name generated above).
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await db.$disconnect();
    }
  };
}
