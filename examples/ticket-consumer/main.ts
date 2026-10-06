import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { verifyWebhook } from '../../src/protocol/webhook.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const cfg = z.object({
  CONSUMER_DATABASE_URL: z.string().url(), CONSUMER_ID: z.uuid(),
  CONSUMER_RECEIPT_CREDENTIAL: z.string().startsWith('spr_'),
  CONSUMER_SIGNING_KEY_ID: z.uuid(), CONSUMER_SIGNING_SECRET: z.string().min(32),
  CONSUMER_CONTRACT_ID: z.string().startsWith('C'), NETWORK_EPOCH: z.string().min(1),
  API_URL: z.url(), DEMO_API_KEY: z.string().min(32),
  CONSUMER_HOST: z.string().default('127.0.0.1'),
  CONSUMER_PORT: z.coerce.number().int().positive().default(3002),
}).parse(process.env);

const pool = new pg.Pool({ connectionString: cfg.CONSUMER_DATABASE_URL, max: 10 });
await pool.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.soropulse-signature', 'req.headers.x-demo-key'] }, bodyLimit: 65536 });
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

const payloadSchema = z.object({
  schema_version: z.literal(1), event_id: z.string().regex(/^\d{19}-\d{10}$/), delivery_id: z.uuid(),
  network: z.literal('testnet'), epoch: z.string(), contract_id: z.string(), transaction_hash: z.string().length(64),
  ledger: z.number().int().positive(), ledger_closed_at: z.string().nullable(),
  raw: z.object({ topics_xdr: z.array(z.string()).min(1).max(4), value_xdr: z.string() }),
  decoded: z.object({ name: z.literal('ticket'), schema_version: z.literal(1),
    event_id: z.string().regex(/^\d+$/), reservation_id: z.string().regex(/^\d+$/),
    attendee: z.string().startsWith('G'), reserved_after: z.number().int().positive() }),
  replay: z.object({ plan_id: z.uuid() }).nullable(),
});

app.post('/webhook', async (request, reply) => {
  const body = request.body;
  if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: 'Expected JSON bytes' });
  const timestamp = request.headers['soropulse-timestamp'];
  const deliveryId = request.headers['soropulse-id'];
  const signature = request.headers['soropulse-signature'];
  const keyId = request.headers['soropulse-key-id'];
  if (typeof timestamp !== 'string' || typeof deliveryId !== 'string' || typeof signature !== 'string' ||
      keyId !== cfg.CONSUMER_SIGNING_KEY_ID || !verifyWebhook({ secret: cfg.CONSUMER_SIGNING_SECRET,
        timestamp, deliveryId, signature, body })) return reply.code(401).send({ error: 'Invalid signature' });
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); }
  catch { return reply.code(400).send({ error: 'Invalid JSON' }); }
  const challenge = z.object({ type: z.literal('soropulse.endpoint.verify'), challenge: z.string().length(48) }).safeParse(parsed);
  if (challenge.success) return reply.type('text/plain').send(challenge.data.challenge);
  let payload: z.infer<typeof payloadSchema>;
  try { payload = payloadSchema.parse(parsed); }
  catch { return reply.code(400).send({ error: 'Invalid payload' }); }
  if (payload.delivery_id !== deliveryId || payload.contract_id !== cfg.CONSUMER_CONTRACT_ID || payload.epoch !== cfg.NETWORK_EPOCH) {
    return reply.code(403).send({ error: 'Out-of-scope event' });
  }
  const stable = JSON.stringify({ network: payload.network, epoch: payload.epoch, contract_id: payload.contract_id,
    event_id: payload.event_id, raw: payload.raw, decoded: payload.decoded });
  const hash = createHash('sha256').update(stable).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO inbox_events(network,epoch,contract_id,rpc_event_id,reservation_id,
      business_event_id,attendee,payload_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [payload.network, payload.epoch, payload.contract_id, payload.event_id, payload.decoded.reservation_id,
      payload.decoded.event_id, payload.decoded.attendee, hash]);
    const inbox = await client.query<{ id: string; payload_hash: string; processed_at: Date | null; processing_run_id: string }>(`
      SELECT id,payload_hash,processed_at,processing_run_id FROM inbox_events
      WHERE network=$1 AND epoch=$2 AND contract_id=$3 AND rpc_event_id=$4 FOR UPDATE`,
    [payload.network, payload.epoch, payload.contract_id, payload.event_id]);
    const row = inbox.rows[0];
    if (!row || row.payload_hash !== hash) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Conflicting event identity' }); }
    await client.query(`INSERT INTO inbox_deliveries(delivery_id,inbox_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [payload.delivery_id, row.id]);
    if (row.processed_at) await enqueueReceipt(client, row.id, payload.delivery_id, row.processing_run_id,
      payload.event_id, row.processed_at);
    await client.query('COMMIT');
    return reply.code(202).send({ accepted: true, duplicate: Boolean(row.processed_at) });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});

async function enqueueReceipt(client: pg.PoolClient, inboxId: string, deliveryId: string, runId: string,
  eventId: string, observedAt: Date): Promise<void> {
  const receiptId = randomUUID();
  const body = { schema_version: 1, receipt_id: receiptId, event_id: eventId, delivery_id: deliveryId,
    consumer_id: cfg.CONSUMER_ID, processing_run_id: runId, sequence: 1, status: 'succeeded',
    observed_at: observedAt.toISOString(), business_reference: inboxId };
  await client.query(`INSERT INTO receipt_outbox(delivery_id,body) VALUES ($1,$2::jsonb) ON CONFLICT DO NOTHING`,
  [deliveryId, JSON.stringify(body)]);
}

async function processInbox(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pending = await client.query<{ id: string; network: string; epoch: string; contract_id: string;
      reservation_id: string; rpc_event_id: string; business_event_id: string; attendee: string; processing_run_id: string }>(`
      SELECT * FROM inbox_events WHERE processed_at IS NULL ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    const event = pending.rows[0];
    if (!event) { await client.query('COMMIT'); return; }
    await client.query(`INSERT INTO tickets(network,epoch,contract_id,reservation_id,rpc_event_id,business_event_id,attendee)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [event.network, event.epoch, event.contract_id, event.reservation_id, event.rpc_event_id,
      event.business_event_id, event.attendee]);
    const processedAt = new Date();
    await client.query('UPDATE inbox_events SET processed_at=$2 WHERE id=$1', [event.id, processedAt]);
    const deliveries = await client.query<{ delivery_id: string }>('SELECT delivery_id FROM inbox_deliveries WHERE inbox_id=$1', [event.id]);
    for (const delivery of deliveries.rows) await enqueueReceipt(client, event.id, delivery.delivery_id,
      event.processing_run_id, event.rpc_event_id, processedAt);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function sendReceipt(): Promise<void> {
  const client = await pool.connect();
  let row: { id: string; body: Record<string, unknown> } | undefined;
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string; body: Record<string, unknown> }>(`
      SELECT id,body FROM receipt_outbox WHERE sent_at IS NULL AND next_attempt_at<=now()
      AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED LIMIT 1`);
    row = result.rows[0];
    if (row) await client.query(`UPDATE receipt_outbox SET lease_until=now()+interval '30 seconds',
      attempt_count=attempt_count+1 WHERE id=$1`, [row.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  if (!row) return;
  try {
    const response = await fetch(new URL('/v1/processing-receipts', cfg.API_URL), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${cfg.CONSUMER_RECEIPT_CREDENTIAL}`, 'content-type': 'application/json' },
      body: JSON.stringify(row.body),
    });
    if (!response.ok) throw new Error(`receipt HTTP ${response.status}`);
    await pool.query('UPDATE receipt_outbox SET sent_at=now(),lease_until=NULL,last_error=NULL WHERE id=$1', [row.id]);
  } catch (error) {
    await pool.query(`UPDATE receipt_outbox SET lease_until=NULL,next_attempt_at=now()+interval '15 seconds',
      last_error=$2 WHERE id=$1`, [row.id, error instanceof Error ? error.message.slice(0, 100) : 'send failed']);
  }
}

app.get('/demo/tickets', async (request, reply) => {
  if (request.headers['x-demo-key'] !== cfg.DEMO_API_KEY) return reply.code(401).send({ error: 'Unauthorized' });
  const result = await pool.query(`SELECT id,network,epoch,contract_id,reservation_id,rpc_event_id,
    business_event_id,attendee,created_at FROM tickets ORDER BY created_at DESC LIMIT 100`);
  return { items: result.rows };
});
app.get('/health/live', async () => ({ status: 'ok' }));

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
const timer = setInterval(() => {
  if (stopping) return;
  void processInbox().catch((error) => app.log.error({ err: error }, 'inbox processing failed'));
  void sendReceipt().catch((error) => app.log.error({ err: error }, 'receipt delivery failed'));
}, 1000);
await app.listen({ host: cfg.CONSUMER_HOST, port: cfg.CONSUMER_PORT });
while (!stopping) await new Promise((resolve) => setTimeout(resolve, 500));
clearInterval(timer);
await app.close(); await pool.end();
