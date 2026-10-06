import { loadConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { ingestOnce } from './ingest.js';

const config = loadConfig();
const { pool } = createDatabase(config.DATABASE_URL);
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
while (!stopping) {
  try {
    const result = await ingestOnce(pool);
    if (result !== 'idle') process.stdout.write(JSON.stringify({ level: 'info', worker: 'ingest', result, at: new Date().toISOString() }) + '\n');
    if (result === 'idle' || result === 'waiting' || result === 'gap') await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch (error) {
    process.stderr.write(JSON.stringify({ level: 'error', worker: 'ingest', error: error instanceof Error ? error.message : 'unknown' }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
await pool.end();
