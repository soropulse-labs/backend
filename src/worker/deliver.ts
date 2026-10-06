import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Config } from '../config.js';
import { decrypt } from '../crypto.js';
import { postWebhook, type HttpResult } from '../delivery/http.js';
import { webhookHeaders, type WebhookPayload } from '../protocol/webhook.js';

const MAX_ATTEMPTS = 8;

interface ClaimedDelivery {
  id: string; lease_token: string; attempt_count: number; endpoint_version_id: string;
  url: string; signing_secret_cipher: string; signing_key_id: string;
  event_id: string; rpc_event_id: string; network: string; epoch: string; contract_id: string;
  tx_hash: string; ledger: string; ledger_closed_at: Date | null; topic_xdr: string[];
  value_xdr: string; decoded: Record<string, unknown> | null; replay_plan_id: string | null;
}

export function retryDelayMs(attempt: number, jitter = Math.random(), retryAfterSeconds: number | null = null): number {
  const exponential = Math.min(900_000, 5_000 * 2 ** Math.max(0, attempt - 1));
  return Math.max(retryAfterSeconds ? Math.min(retryAfterSeconds * 1000, 900_000) : 0,
    Math.round(exponential * (0.8 + Math.min(1, Math.max(0, jitter)) * 0.4)));
}

export function classify(result: HttpResult): { success: boolean; retryable: boolean; failureClass: string | null } {
  if (result.status !== null && result.status >= 200 && result.status < 300 && !result.failure) return { success: true, retryable: false, failureClass: null };
  if (result.failure) return { success: false, retryable: true, failureClass: 'network_error' };
  if (result.status === 408 || result.status === 429 || (result.status !== null && result.status >= 500)) return { success: false, retryable: true, failureClass: 'retryable_http' };
  return { success: false, retryable: false, failureClass: 'permanent_http' };
}

export async function claimDeliveries(pool: pg.Pool, limit = 5): Promise<ClaimedDelivery[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidates = await client.query<{ id: string; status: string; attempt_count: number; attempt_started_at: Date | null; endpoint_id: string; active_count: string }>(`
      SELECT d.id,d.status,d.attempt_count,d.attempt_started_at,ep.id AS endpoint_id,
        (SELECT count(*) FROM deliveries active JOIN endpoint_versions av ON av.id=active.endpoint_version_id
         WHERE av.endpoint_id=ep.id AND active.status='in_flight' AND active.lease_until>now()) AS active_count
      FROM deliveries d
      JOIN endpoint_versions v ON v.id=d.endpoint_version_id
      JOIN endpoints ep ON ep.id=v.endpoint_id
      LEFT JOIN replay_plans rp ON rp.id=d.replay_plan_id
      WHERE ((d.status IN ('queued','retry_scheduled') AND d.next_attempt_at<=now())
        OR (d.status='in_flight' AND d.lease_until<now()))
        AND (d.replay_plan_id IS NULL OR rp.status='executed')
        AND ep.disabled_at IS NULL AND v.verified_at IS NOT NULL
        AND (SELECT count(*) FROM deliveries active JOIN endpoint_versions av ON av.id=active.endpoint_version_id
             WHERE av.endpoint_id=ep.id AND active.status='in_flight' AND active.lease_until>now())<2
      ORDER BY d.next_attempt_at,d.created_at FOR UPDATE OF d,ep SKIP LOCKED LIMIT $1`, [Math.min(10, Math.max(1, limit))]);
    const ids: string[] = [];
    const claimedPerEndpoint = new Map<string, number>();
    for (const row of candidates.rows) {
      const alreadyClaimed = claimedPerEndpoint.get(row.endpoint_id) ?? 0;
      if (Number(row.active_count) + alreadyClaimed >= 2) continue;
      if (row.status === 'in_flight' && row.attempt_started_at) {
        await client.query(`INSERT INTO delivery_attempts(delivery_id,attempt_number,started_at,completed_at,duration_ms,failure_class)
          VALUES ($1,$2,$3,now(),GREATEST(0,extract(epoch from (now()-$3::timestamptz))*1000)::int,'worker_lease_expired')
          ON CONFLICT DO NOTHING`, [row.id, row.attempt_count, row.attempt_started_at]);
      }
      const token = randomUUID();
      await client.query(`UPDATE deliveries SET status='in_flight', lease_token=$2,
        lease_until=now()+interval '30 seconds', attempt_started_at=now(), attempt_count=attempt_count+1
        WHERE id=$1`, [row.id, token]);
      ids.push(row.id);
      claimedPerEndpoint.set(row.endpoint_id, alreadyClaimed + 1);
    }
    let result: ClaimedDelivery[] = [];
    if (ids.length) {
      const details = await client.query<ClaimedDelivery>(`
        SELECT d.id,d.lease_token,d.attempt_count,d.endpoint_version_id,d.replay_plan_id,
          v.url,v.signing_secret_cipher,v.signing_key_id,
          e.id AS event_id,e.rpc_event_id,e.network,e.epoch,e.contract_id,e.tx_hash,e.ledger,
          e.ledger_closed_at,e.topic_xdr,e.value_xdr,e.decoded
        FROM deliveries d JOIN endpoint_versions v ON v.id=d.endpoint_version_id
        JOIN captured_events e ON e.id=d.event_id WHERE d.id=ANY($1::uuid[])`, [ids]);
      result = details.rows;
    }
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function deliverClaim(pool: pg.Pool, delivery: ClaimedDelivery, config: Pick<Config, 'ENCRYPTION_KEY' | 'NODE_ENV' | 'DEV_ALLOWED_ENDPOINTS'>): Promise<void> {
  const payload: WebhookPayload = {
    schema_version: 1, event_id: delivery.rpc_event_id, delivery_id: delivery.id,
    network: delivery.network, epoch: delivery.epoch, contract_id: delivery.contract_id,
    transaction_hash: delivery.tx_hash, ledger: Number(delivery.ledger),
    ledger_closed_at: delivery.ledger_closed_at?.toISOString() ?? null,
    raw: { topics_xdr: delivery.topic_xdr, value_xdr: delivery.value_xdr },
    decoded: delivery.decoded, replay: delivery.replay_plan_id ? { plan_id: delivery.replay_plan_id } : null,
  };
  const body = Buffer.from(JSON.stringify(payload));
  const secret = decrypt(delivery.signing_secret_cipher, config.ENCRYPTION_KEY);
  const headers = webhookHeaders(secret, delivery.signing_key_id, delivery.id, body);
  let outcome: HttpResult;
  try { outcome = await postWebhook(delivery.url, body, headers, config); }
  catch (error) { outcome = { status: null, preview: '', retryAfterSeconds: null,
    failure: error instanceof Error ? error.message.slice(0, 100) : 'request_failed', durationMs: 0 }; }
  const state = classify(outcome);
  const status = state.success ? 'acknowledged' : state.retryable && delivery.attempt_count < MAX_ATTEMPTS ? 'retry_scheduled' : 'dead_letter';
  const nextAt = new Date(Date.now() + retryDelayMs(delivery.attempt_count, Math.random(), outcome.retryAfterSeconds));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fence = await client.query(`SELECT attempt_started_at FROM deliveries WHERE id=$1 AND lease_token=$2
      AND lease_until>now() FOR UPDATE`, [delivery.id, delivery.lease_token]);
    if (!fence.rows[0]) { await client.query('ROLLBACK'); return; }
    await client.query(`INSERT INTO delivery_attempts(delivery_id,attempt_number,started_at,completed_at,duration_ms,http_status,failure_class,response_preview)
      VALUES ($1,$2,$3,now(),$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [delivery.id, delivery.attempt_count, fence.rows[0].attempt_started_at, outcome.durationMs, outcome.status,
      state.failureClass, outcome.preview]);
    await client.query(`UPDATE deliveries SET status=$3,next_attempt_at=$4,lease_token=NULL,lease_until=NULL,
      attempt_started_at=NULL,acknowledged_at=CASE WHEN $3='acknowledged' THEN now() ELSE acknowledged_at END
      WHERE id=$1 AND lease_token=$2`, [delivery.id, delivery.lease_token, status, nextAt]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function deliverOnce(pool: pg.Pool, config: Pick<Config, 'ENCRYPTION_KEY' | 'NODE_ENV' | 'DEV_ALLOWED_ENDPOINTS'>): Promise<number> {
  const jobs = await claimDeliveries(pool);
  await Promise.all(jobs.map((job) => deliverClaim(pool, job, config)));
  return jobs.length;
}
