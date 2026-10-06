import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export function createDatabase(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 15, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export type Database = ReturnType<typeof createDatabase>['db'];
