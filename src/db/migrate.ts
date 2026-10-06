import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const { db, pool } = createDatabase(config.DATABASE_URL);
try {
  await migrate(db, { migrationsFolder: './drizzle' });
  process.stdout.write('Migrations complete\n');
} finally {
  await pool.end();
}
