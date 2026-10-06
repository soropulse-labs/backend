import { loadConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { createApp } from './server.js';

const config = loadConfig();
const { pool } = createDatabase(config.DATABASE_URL);
const app = await createApp(pool, config);
const close = async () => { await app.close(); await pool.end(); };
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
await app.listen({ host: config.API_HOST, port: config.API_PORT });
