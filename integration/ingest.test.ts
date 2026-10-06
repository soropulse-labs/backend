import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { xdr } from '@stellar/stellar-sdk';
import pg from 'pg';
import { ingestOnce } from '../src/worker/ingest.js';
import { claimDeliveries, deliverClaim } from '../src/worker/deliver.js';
import { encrypt } from '../src/crypto.js';
import { verifyWebhook } from '../src/protocol/webhook.js';
import type { RawRpcEvent } from '../src/stellar/decoder.js';
import type { StellarRpc } from '../src/stellar/rpc.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');
const fixture = JSON.parse(readFileSync(new URL('../fixtures/contract-v1/events-v1.local.json', import.meta.url), 'utf8')) as
  { events: { name: string; contract_event_xdr_hex: string }[] };
const ticket = xdr.ContractEvent.fromXDR(fixture.events.find((item) => item.name === 'ticket')!.contract_event_xdr_hex, 'hex');
const contractId = 'CAUKWP7TRYYXAF2C5NDAZEAQVWCUMXX76KBPK64MQBZHU7EUJ5JVPHGG';
const ledger = 4990360;

function event(id: string): RawRpcEvent {
  return { id, type: 'contract', contractId, ledger, txHash: 'a'.repeat(64),
    topic: ticket.body().v0().topics().map((value) => value.toXDR('base64')),
    value: ticket.body().v0().data().toXDR('base64') };
}

test('ingestion commits events, jobs, and checkpoint together while isolating tenants', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const marker = randomUUID();
  const users: string[] = [];
  const envs: string[] = [];
  const secret = 'integration-signing-secret-at-least-32-bytes';
  const keyId = randomUUID();
  const key = process.env.ENCRYPTION_KEY ?? '0'.repeat(64);
  const received: string[] = [];
  let calls = 0;
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts);
    const id = String(request.headers['soropulse-id']);
    assert.ok(verifyWebhook({ secret, timestamp: String(request.headers['soropulse-timestamp']), deliveryId: id,
      signature: String(request.headers['soropulse-signature']), body, bodyDeliveryId: JSON.parse(body.toString()).delivery_id }));
    received.push(id);
    response.writeHead(++calls === 1 ? 503 : 202).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const endpointUrl = `http://127.0.0.1:${address.port}/webhook`;
  try {
    for (let i = 0; i < 2; i++) {
      const user = (await pool.query<{ id: string }>('INSERT INTO users(github_id,login) VALUES ($1,$2) RETURNING id',
        [`integration-${marker}-${i}`, `integration-${i}`])).rows[0]!.id;
      users.push(user);
      const project = (await pool.query<{ id: string }>('INSERT INTO projects(owner_id,name) VALUES ($1,$2) RETURNING id',
        [user, marker])).rows[0]!.id;
      const env = (await pool.query<{ id: string }>(`INSERT INTO environments(project_id,name,epoch,rpc_url,network_passphrase)
        VALUES ($1,'testnet',$2,'https://example.com','Test SDF Network ; September 2015') RETURNING id`,
      [project, marker])).rows[0]!.id;
      envs.push(env);
      const endpoint = (await pool.query<{ id: string }>('INSERT INTO endpoints(environment_id,name) VALUES ($1,$2) RETURNING id',
        [env, marker])).rows[0]!.id;
      const version = (await pool.query<{ id: string }>(`INSERT INTO endpoint_versions(endpoint_id,version,url,signing_secret_cipher,signing_key_id,verified_at)
        VALUES ($1,1,$2,$3,$4,now()) RETURNING id`, [endpoint, endpointUrl, encrypt(secret, key), keyId])).rows[0]!.id;
      await pool.query('UPDATE endpoints SET active_version_id=$2 WHERE id=$1', [endpoint, version]);
      const subscription = (await pool.query<{ id: string }>(`INSERT INTO subscriptions(environment_id,endpoint_id,contract_id,start_ledger,decoder)
        VALUES ($1,$2,$3,$4,'soropulse.ticket.v1') RETURNING id`, [env, endpoint, contractId, ledger])).rows[0]!.id;
      await pool.query('INSERT INTO ingestion_streams(subscription_id,next_ledger) VALUES ($1,$2)', [subscription, ledger]);
    }
    const events = [event('0021433518894649344-0000000000'), event('0021433518894649344-0000000001')];
    const rpc = {
      getHealth: async () => ({ status: 'healthy', oldestLedger: ledger - 10, latestLedger: ledger, ledgerRetentionWindow: 100 }),
      getEvents: async () => ({ events, latestLedger: ledger, oldestLedger: ledger - 10 }),
    } as unknown as StellarRpc;
    assert.equal(await ingestOnce(pool, () => rpc), 'captured');
    assert.equal(await ingestOnce(pool, () => rpc), 'captured');
    const captured = await pool.query<{ environment_id: string; count: string }>(`
      SELECT environment_id,count(*)::text AS count FROM captured_events WHERE environment_id=ANY($1::uuid[])
      GROUP BY environment_id`, [envs]);
    assert.equal(captured.rows.length, 2);
    assert.ok(captured.rows.every((row) => row.count === '2'));
    const deliveries = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM deliveries WHERE event_id IN
      (SELECT id FROM captured_events WHERE environment_id=ANY($1::uuid[]))`, [envs]);
    assert.equal(deliveries.rows[0]!.count, '4');
    const streams = await pool.query<{ next_ledger: string }>(`
      SELECT s.next_ledger FROM ingestion_streams s JOIN subscriptions sub ON sub.id=s.subscription_id
      WHERE sub.environment_id=ANY($1::uuid[])`, [envs]);
    assert.ok(streams.rows.every((row) => row.next_ledger === String(ledger + 1)));
    const [firstClaims, secondClaims] = await Promise.all([claimDeliveries(pool, 5), claimDeliveries(pool, 5)]);
    assert.equal(firstClaims.length + secondClaims.length, 4);
    assert.equal(new Set([...firstClaims, ...secondClaims].map((row) => row.id)).size, 4);
    const first = firstClaims[0] ?? secondClaims[0];
    assert.ok(first);
    const devConfig = { ENCRYPTION_KEY: key, NODE_ENV: 'test' as const, DEV_ALLOWED_ENDPOINTS: endpointUrl };
    await deliverClaim(pool, first, devConfig);
    const retry = await pool.query<{ status: string; attempt_count: number }>('SELECT status,attempt_count FROM deliveries WHERE id=$1', [first.id]);
    assert.equal(retry.rows[0]!.status, 'retry_scheduled');
    assert.equal(retry.rows[0]!.attempt_count, 1);
    await pool.query('UPDATE deliveries SET next_attempt_at=now() WHERE id=$1', [first.id]);
    const reclaimed = (await claimDeliveries(pool, 5)).find((row) => row.id === first.id);
    assert.ok(reclaimed);
    await deliverClaim(pool, reclaimed, devConfig);
    const acknowledged = await pool.query<{ status: string; attempt_count: number }>('SELECT status,attempt_count FROM deliveries WHERE id=$1', [first.id]);
    assert.equal(acknowledged.rows[0]!.status, 'acknowledged');
    assert.equal(acknowledged.rows[0]!.attempt_count, 2);
    assert.deepEqual(received, [first.id, first.id]);
    const attempts = await pool.query<{ http_status: number }>('SELECT http_status FROM delivery_attempts WHERE delivery_id=$1 ORDER BY attempt_number', [first.id]);
    assert.deepEqual(attempts.rows.map((row) => row.http_status), [503, 202]);
  } finally {
    for (const env of envs) await pool.query('DELETE FROM ingestion_streams WHERE subscription_id IN (SELECT id FROM subscriptions WHERE environment_id=$1)', [env]);
    for (const env of envs) await pool.query(`DELETE FROM delivery_attempts WHERE delivery_id IN
      (SELECT d.id FROM deliveries d JOIN captured_events e ON e.id=d.event_id WHERE e.environment_id=$1)`, [env]);
    for (const env of envs) await pool.query('DELETE FROM deliveries WHERE event_id IN (SELECT id FROM captured_events WHERE environment_id=$1)', [env]);
    for (const env of envs) await pool.query('DELETE FROM captured_events WHERE environment_id=$1', [env]);
    for (const env of envs) await pool.query('DELETE FROM subscriptions WHERE environment_id=$1', [env]);
    for (const env of envs) await pool.query('DELETE FROM endpoints WHERE environment_id=$1', [env]);
    for (const env of envs) await pool.query('DELETE FROM environments WHERE id=$1', [env]);
    for (const user of users) await pool.query('DELETE FROM projects WHERE owner_id=$1', [user]);
    for (const user of users) await pool.query('DELETE FROM users WHERE id=$1', [user]);
    await pool.end();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
