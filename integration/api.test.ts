import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDatabase } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/api/server.js';
import { encrypt } from '../src/crypto.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');

test('scoped receipts are idempotent and replay rechecks reported success', async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const dbName = `sp_api_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(databaseUrl);
  url.pathname = `/${dbName}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const { db, pool } = createDatabase(url.toString());
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    const config = { ...loadConfig(), DATABASE_URL: url.toString(), NODE_ENV: 'development' as const, DEV_AUTH_ENABLED: true };
    app = await createApp(pool, config);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/dev-login', payload: { login: `test${randomUUID().slice(0, 8)}` } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.headers['set-cookie'];
    assert.ok(typeof cookie === 'string');
    const session = cookie.split(';')[0]!;
    const csrf = login.json().csrf_token as string;
    const writeHeaders = { cookie: session, 'x-csrf-token': csrf };
    const project = await app.inject({ method: 'POST', url: '/v1/projects', headers: writeHeaders, payload: { name: 'api-test' } });
    assert.equal(project.statusCode, 201, project.body);
    const projectId = project.json().id as string;
    const environment = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/environments`, headers: writeHeaders,
      payload: { name: 'testnet', epoch: `test-${randomUUID()}` } });
    assert.equal(environment.statusCode, 201, environment.body);
    const envId = environment.json().id as string;
    const endpoint = (await pool.query<{ id: string }>('INSERT INTO endpoints(environment_id,name) VALUES ($1,$2) RETURNING id',
      [envId, 'receiver'])).rows[0]!.id;
    const version = (await pool.query<{ id: string }>(`INSERT INTO endpoint_versions(endpoint_id,version,url,signing_secret_cipher,signing_key_id,verified_at)
      VALUES ($1,1,'https://example.com/webhook',$2,$3,now()) RETURNING id`,
    [endpoint, encrypt('integration-key', config.ENCRYPTION_KEY), randomUUID()])).rows[0]!.id;
    await pool.query('UPDATE endpoints SET active_version_id=$2 WHERE id=$1', [endpoint, version]);
    const contractId = 'CAUKWP7TRYYXAF2C5NDAZEAQVWCUMXX76KBPK64MQBZHU7EUJ5JVPHGG';
    const subscription = (await pool.query<{ id: string }>(`INSERT INTO subscriptions(environment_id,endpoint_id,contract_id,start_ledger)
      VALUES ($1,$2,$3,4990000) RETURNING id`, [envId, endpoint, contractId])).rows[0]!.id;
    const rpcEventId = '0021433518894649344-0000000000';
    const event = (await pool.query<{ id: string }>(`INSERT INTO captured_events(environment_id,network,epoch,contract_id,rpc_event_id,tx_hash,ledger,topic_xdr,value_xdr)
      VALUES ($1,'testnet',$2,$3,$4,$5,4990380,ARRAY['topic'],'value') RETURNING id`,
    [envId, environment.json().epoch, contractId, rpcEventId, 'a'.repeat(64)])).rows[0]!.id;
    const delivery = (await pool.query<{ id: string }>(`INSERT INTO deliveries(event_id,subscription_id,endpoint_version_id)
      VALUES ($1,$2,$3) RETURNING id`, [event, subscription, version])).rows[0]!.id;
    const stranger = await app.inject({ method: 'POST', url: '/v1/auth/dev-login',
      payload: { login: `other${randomUUID().slice(0, 8)}` } });
    assert.equal(stranger.statusCode, 200);
    const strangerCookie = stranger.headers['set-cookie'];
    assert.ok(typeof strangerCookie === 'string');
    const forbiddenRead = await app.inject({ method: 'GET', url: `/v1/environments/${envId}/events`,
      headers: { cookie: strangerCookie.split(';')[0]! } });
    assert.equal(forbiddenRead.statusCode, 404);
    const consumer = await app.inject({ method: 'POST', url: `/v1/environments/${envId}/consumers`, headers: writeHeaders,
      payload: { name: 'test-consumer' } });
    assert.equal(consumer.statusCode, 201, consumer.body);
    const consumerId = consumer.json().id as string;
    const credential = consumer.json().secret as string;
    const preview = await app.inject({ method: 'POST', url: `/v1/environments/${envId}/replay-plans`, headers: writeHeaders,
      payload: { endpoint_id: endpoint, delivery_ids: [delivery], reason: 'Investigate missing receipt' } });
    assert.equal(preview.statusCode, 201, preview.body);
    assert.equal(preview.json().eligible, 1);
    const planId = preview.json().id as string;
    const receipt = { schema_version: 1, receipt_id: randomUUID(), event_id: rpcEventId,
      delivery_id: delivery, consumer_id: consumerId, processing_run_id: randomUUID(), sequence: 1,
      status: 'succeeded', observed_at: new Date().toISOString() };
    const receiptHeaders = { authorization: `Bearer ${credential}` };
    const accepted = await app.inject({ method: 'POST', url: '/v1/processing-receipts', headers: receiptHeaders, payload: receipt });
    assert.equal(accepted.statusCode, 201, accepted.body);
    const duplicate = await app.inject({ method: 'POST', url: '/v1/processing-receipts', headers: receiptHeaders, payload: receipt });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().duplicate, true);
    const conflicting = await app.inject({ method: 'POST', url: '/v1/processing-receipts', headers: receiptHeaders,
      payload: { ...receipt, status: 'failed' } });
    assert.equal(conflicting.statusCode, 409, conflicting.body);
    const execute = await app.inject({ method: 'POST', url: `/v1/environments/${envId}/replay-plans/${planId}/execute`,
      headers: writeHeaders, payload: {} });
    assert.equal(execute.statusCode, 200, execute.body);
    assert.equal(execute.json().queued, 0);
    assert.equal(execute.json().skipped, 1);
    const executeAgain = await app.inject({ method: 'POST', url: `/v1/environments/${envId}/replay-plans/${planId}/execute`,
      headers: writeHeaders, payload: {} });
    assert.equal(executeAgain.statusCode, 200, executeAgain.body);
    assert.equal(executeAgain.json().idempotent, true);
    const jobs = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM deliveries WHERE replay_plan_id=$1', [planId]);
    assert.equal(jobs.rows[0]!.count, '0');
  } finally {
    if (app) await app.close();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  }
});
