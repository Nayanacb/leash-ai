import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export type Database = PrismaClient;

export function createDatabase(databaseUrl: string): Database {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

/** Minimal capability the HTTP layer needs for readiness checks. */
export interface DatabaseProbe {
  ping(): Promise<void>;
}

export function databaseProbe(db: Database): DatabaseProbe {
  return {
    async ping() {
      await db.$queryRaw`SELECT 1`;
    },
  };
}
