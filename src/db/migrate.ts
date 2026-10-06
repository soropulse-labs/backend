import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { createDatabase } from './client.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const databaseUrl = z.string().url().startsWith('postgresql://').parse(process.env.DATABASE_URL);
const { db, pool } = createDatabase(databaseUrl);
try {
  await migrate(db, { migrationsFolder: './drizzle' });
  process.stdout.write('Migrations complete\n');
} finally {
  await pool.end();
}
