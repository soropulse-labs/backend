import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import type { Config } from '../src/config.js';
import { createApp } from '../src/api/server.js';

const config: Config = {
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
  STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015', NETWORK_EPOCH: 'openapi-example', START_LEDGER: 1,
  API_HOST: '127.0.0.1', API_PORT: 3001, PUBLIC_BASE_URL: 'http://localhost:3001',
  FRONTEND_ORIGIN: 'http://localhost:3000', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '',
  SESSION_SECRET: 'x'.repeat(32), ENCRYPTION_KEY: '0'.repeat(64),
  DEV_AUTH_ENABLED: false, DEV_ALLOWED_ENDPOINTS: '',
};
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = await createApp(pool, config);
try {
  const spec = app.swagger();
  spec.info.description = 'Generated route inventory from the running Fastify registration. Request and response models are incomplete; consult docs/FRONTEND_HANDOFF.md and route validation before generating clients.';
  const output = `${JSON.stringify(spec, null, 2)}\n`;
  const path = 'docs/openapi.json';
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== output) throw new Error('OpenAPI route inventory is out of date; run pnpm openapi:generate');
    process.stdout.write('OpenAPI route inventory matches implementation\n');
  } else {
    writeFileSync(path, output);
    process.stdout.write(`Wrote ${path}\n`);
  }
} finally {
  await app.close();
  await pool.end();
}
