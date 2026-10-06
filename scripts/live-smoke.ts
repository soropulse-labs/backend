import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { xdr } from '@stellar/stellar-sdk';
import { loadConfig } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import { verifyWebhook } from '../src/protocol/webhook.js';
import { ingestOnce } from '../src/worker/ingest.js';
import { claimDeliveries, deliverClaim } from '../src/worker/deliver.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('Live smoke requires a non-production environment');
const contractId = process.env.LIVE_SMOKE_CONTRACT_ID ?? 'CAUKWP7TRYYXAF2C5NDAZEAQVWCUMXX76KBPK64MQBZHU7EUJ5JVPHGG';
const startLedger = Number(process.env.LIVE_SMOKE_START_LEDGER ?? '4990371');
if (!Number.isSafeInteger(startLedger) || startLedger <= 0) throw new Error('Invalid LIVE_SMOKE_START_LEDGER');
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const marker = randomUUID();
const secret = `smoke_${randomUUID()}_${randomUUID()}`;
const keyId = randomUUID();
const seen: { eventId: string; deliveryId: string; decoded: unknown }[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const payload = JSON.parse(body.toString('utf8')) as { event_id: string; delivery_id: string; decoded: unknown };
  const valid = verifyWebhook({ secret, timestamp: String(request.headers['soropulse-timestamp']),
    deliveryId: String(request.headers['soropulse-id']), signature: String(request.headers['soropulse-signature']),
    body, bodyDeliveryId: payload.delivery_id });
  if (!valid) { response.writeHead(401).end(); return; }
  seen.push({ eventId: payload.event_id, deliveryId: payload.delivery_id, decoded: payload.decoded });
  response.writeHead(202).end();
});
let userId: string | undefined;
let projectId: string | undefined;
let environmentId: string | undefined;
let endpointId: string | undefined;
let subscriptionId: string | undefined;
try {
  const pending = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM deliveries
    WHERE status IN ('queued','retry_scheduled','in_flight')`);
  if (Number(pending.rows[0]?.count) !== 0) throw new Error('Smoke test requires a database without pending deliveries');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Smoke receiver failed to bind');
  const endpointUrl = `http://127.0.0.1:${address.port}/webhook`;
  userId = (await pool.query<{ id: string }>('INSERT INTO users(github_id,login) VALUES ($1,$2) RETURNING id',
    [`smoke:${marker}`, 'smoke'])).rows[0]!.id;
  projectId = (await pool.query<{ id: string }>('INSERT INTO projects(owner_id,name) VALUES ($1,$2) RETURNING id',
    [userId, `smoke-${marker}`])).rows[0]!.id;
  environmentId = (await pool.query<{ id: string }>(`INSERT INTO environments(project_id,name,epoch,rpc_url,network_passphrase)
    VALUES ($1,'testnet',$2,$3,$4) RETURNING id`, [projectId, `smoke-${marker}`, config.STELLAR_RPC_URL, config.NETWORK_PASSPHRASE])).rows[0]!.id;
  endpointId = (await pool.query<{ id: string }>('INSERT INTO endpoints(environment_id,name) VALUES ($1,$2) RETURNING id',
    [environmentId, `smoke-${marker}`])).rows[0]!.id;
  const versionId = (await pool.query<{ id: string }>(`INSERT INTO endpoint_versions(endpoint_id,version,url,signing_secret_cipher,signing_key_id,verified_at)
    VALUES ($1,1,$2,$3,$4,now()) RETURNING id`, [endpointId, endpointUrl, encrypt(secret, config.ENCRYPTION_KEY), keyId])).rows[0]!.id;
  await pool.query('UPDATE endpoints SET active_version_id=$2 WHERE id=$1', [endpointId, versionId]);
  const topic0 = xdr.ScVal.scvSymbol('ticket').toXDR('base64');
  subscriptionId = (await pool.query<{ id: string }>(`INSERT INTO subscriptions(environment_id,endpoint_id,contract_id,topic0_xdr,decoder,start_ledger)
    VALUES ($1,$2,$3,$4,'soropulse.ticket.v1',$5) RETURNING id`,
  [environmentId, endpointId, contractId, topic0, startLedger])).rows[0]!.id;
  await pool.query('INSERT INTO ingestion_streams(subscription_id,next_ledger) VALUES ($1,$2)', [subscriptionId, startLedger]);
  const captured = await ingestOnce(pool);
  if (captured !== 'captured') throw new Error(`Ingestion returned ${captured}`);
  const events = await pool.query<{ rpc_event_id: string; tx_hash: string; ledger: string; decoded: unknown }>(`
    SELECT rpc_event_id,tx_hash,ledger,decoded FROM captured_events WHERE environment_id=$1 ORDER BY ledger,rpc_event_id`, [environmentId]);
  if (!events.rows.length) throw new Error('No retained ticket events found in the smoke ledger window');
  const jobs = await claimDeliveries(pool, 10);
  if (jobs.length !== events.rows.length) throw new Error('Captured event and delivery counts differ');
  for (const job of jobs) await deliverClaim(pool, job,
    { ENCRYPTION_KEY: config.ENCRYPTION_KEY, NODE_ENV: 'test', DEV_ALLOWED_ENDPOINTS: endpointUrl });
  const attempts = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM delivery_attempts a
    JOIN deliveries d ON d.id=a.delivery_id JOIN captured_events e ON e.id=d.event_id
    WHERE e.environment_id=$1 AND d.status='acknowledged' AND a.http_status=202`, [environmentId]);
  if (Number(attempts.rows[0]?.count) !== events.rows.length || seen.length !== events.rows.length)
    throw new Error('Signed delivery or acknowledgement evidence mismatch');
  process.stdout.write(`${JSON.stringify({ provenance: 'live Stellar testnet RPC and local backend smoke',
    contract_id: contractId, start_ledger: startLedger, network_epoch: `smoke-${marker}`,
    captured_events: events.rows, signed_deliveries: seen, acknowledged_attempts: Number(attempts.rows[0]!.count) }, null, 2)}\n`);
} finally {
  if (subscriptionId) {
    await pool.query('DELETE FROM ingestion_streams WHERE subscription_id=$1', [subscriptionId]);
    await pool.query('DELETE FROM coverage_incidents WHERE subscription_id=$1', [subscriptionId]);
    await pool.query(`DELETE FROM delivery_attempts WHERE delivery_id IN
      (SELECT id FROM deliveries WHERE subscription_id=$1)`, [subscriptionId]);
    await pool.query('DELETE FROM deliveries WHERE subscription_id=$1', [subscriptionId]);
    await pool.query('DELETE FROM captured_events WHERE environment_id=$1', [environmentId]);
    await pool.query('DELETE FROM subscriptions WHERE id=$1', [subscriptionId]);
  }
  if (endpointId) await pool.query('DELETE FROM endpoints WHERE id=$1', [endpointId]);
  if (environmentId) await pool.query('DELETE FROM environments WHERE id=$1', [environmentId]);
  if (projectId) await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
  if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  await pool.end();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}
