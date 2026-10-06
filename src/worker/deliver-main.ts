import { loadConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { deliverOnce } from './deliver.js';

const config = loadConfig();
const { pool } = createDatabase(config.DATABASE_URL);
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
while (!stopping) {
  try {
    const count = await deliverOnce(pool, config);
    if (count) process.stdout.write(JSON.stringify({ level: 'info', worker: 'deliver', count, at: new Date().toISOString() }) + '\n');
    if (!count) await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    process.stderr.write(JSON.stringify({ level: 'error', worker: 'deliver', error: error instanceof Error ? error.message : 'unknown' }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
await pool.end();
