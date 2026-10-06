import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { xdr } from '@stellar/stellar-sdk';
import pg from 'pg';
import { ingestOnce } from '../src/worker/ingest.js';
import { claimDeliveries } from '../src/worker/deliver.js';
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
        VALUES ($1,1,'https://example.com/hook','cipher',$2,now()) RETURNING id`, [endpoint, randomUUID()])).rows[0]!.id;
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
  } finally {
    for (const env of envs) await pool.query('DELETE FROM ingestion_streams WHERE subscription_id IN (SELECT id FROM subscriptions WHERE environment_id=$1)', [env]);
    for (const env of envs) await pool.query('DELETE FROM deliveries WHERE event_id IN (SELECT id FROM captured_events WHERE environment_id=$1)', [env]);
    for (const env of envs) await pool.query('DELETE FROM captured_events WHERE environment_id=$1', [env]);
    for (const env of envs) await pool.query('DELETE FROM subscriptions WHERE environment_id=$1', [env]);
    for (const env of envs) await pool.query('DELETE FROM endpoints WHERE environment_id=$1', [env]);
    for (const env of envs) await pool.query('DELETE FROM environments WHERE id=$1', [env]);
    for (const user of users) await pool.query('DELETE FROM projects WHERE owner_id=$1', [user]);
    for (const user of users) await pool.query('DELETE FROM users WHERE id=$1', [user]);
    await pool.end();
  }
});
