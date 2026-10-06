import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { decodeEvent, type RawRpcEvent } from '../stellar/decoder.js';
import { StellarRpc } from '../stellar/rpc.js';

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const LEDGER_WINDOW = 100;

interface StreamClaim {
  id: string; subscription_id: string; next_ledger: string; lease_token: string;
  contract_id: string; topic0_xdr: string | null; decoder: string | null;
  environment_id: string; network: string; epoch: string; rpc_url: string;
  endpoint_version_id: string | null;
}

export async function claimStream(pool: pg.Pool): Promise<StreamClaim | null> {
  const token = randomUUID();
  const claimed = await pool.query<{ id: string }>(`
    UPDATE ingestion_streams SET lease_token=$1, lease_until=now()+interval '60 seconds'
    WHERE id = (SELECT s.id FROM ingestion_streams s
      JOIN subscriptions sub ON sub.id=s.subscription_id
      JOIN environments env ON env.id=sub.environment_id
      WHERE sub.active AND env.active AND (s.lease_until IS NULL OR s.lease_until<now())
      ORDER BY s.updated_at, s.id FOR UPDATE OF s SKIP LOCKED LIMIT 1)
    RETURNING id`, [token]);
  if (!claimed.rows[0]) return null;
  const details = await pool.query<StreamClaim>(`
    SELECT s.id, s.subscription_id, s.next_ledger, s.lease_token, sub.contract_id,
      sub.topic0_xdr, sub.decoder, sub.environment_id, env.network, env.epoch, env.rpc_url,
      ep.active_version_id AS endpoint_version_id
    FROM ingestion_streams s JOIN subscriptions sub ON sub.id=s.subscription_id
    JOIN environments env ON env.id=sub.environment_id
    JOIN endpoints ep ON ep.id=sub.endpoint_id
    WHERE s.id=$1 AND s.lease_token=$2`, [claimed.rows[0].id, token]);
  return details.rows[0] ?? null;
}

async function release(pool: pg.Pool, claim: StreamClaim, error?: string): Promise<void> {
  await pool.query(`UPDATE ingestion_streams SET lease_token=NULL, lease_until=NULL, last_error=$3,
    updated_at=now() WHERE id=$1 AND lease_token=$2`, [claim.id, claim.lease_token, error?.slice(0, 500) ?? null]);
}

function validateRpcEvent(event: RawRpcEvent, claim: StreamClaim): void {
  if (event.type !== 'contract' || event.contractId !== claim.contract_id ||
      !/^\d{19}-\d{10}$/.test(event.id) || !Number.isSafeInteger(event.ledger) ||
      !/^[0-9a-f]{64}$/i.test(event.txHash) || !Array.isArray(event.topic) || event.topic.length < 1 || event.topic.length > 4 ||
      typeof event.value !== 'string') throw new Error('Malformed or out-of-scope RPC event');
}

async function fetchWindow(rpc: StellarRpc, claim: StreamClaim, endLedger: number): Promise<RawRpcEvent[]> {
  const events: RawRpcEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await rpc.getEvents({ contractId: claim.contract_id, topic0Xdr: claim.topic0_xdr,
      ...(cursor ? { cursor } : { startLedger: Number(claim.next_ledger), endLedger }), limit: PAGE_LIMIT });
    if (!Array.isArray(response.events)) throw new Error('Malformed getEvents response');
    for (const event of response.events) {
      validateRpcEvent(event, claim);
      if (event.ledger >= endLedger) return events;
      if (event.ledger < Number(claim.next_ledger)) throw new Error('RPC cursor moved backwards');
      events.push(event);
    }
    if (response.events.length < PAGE_LIMIT) return events;
    if (!response.cursor || response.cursor === cursor) throw new Error('RPC pagination did not advance');
    cursor = response.cursor;
  }
  throw new Error('Event window exceeded pagination bound; reduce ledger window');
}

async function recordIncident(pool: pg.Pool, claim: StreamClaim, kind: string, evidence: Record<string, unknown>): Promise<void> {
  await pool.query(`INSERT INTO coverage_incidents(environment_id,subscription_id,kind,evidence,from_ledger)
    VALUES ($1,$2,$3,$4::jsonb,$5)`, [claim.environment_id, claim.subscription_id, kind, JSON.stringify(evidence), claim.next_ledger]);
}

export async function ingestOnce(pool: pg.Pool, rpcFactory = (url: string) => new StellarRpc(url)):
  Promise<'idle' | 'captured' | 'waiting' | 'gap'> {
  const claim = await claimStream(pool);
  if (!claim) return 'idle';
  try {
    const start = Number(claim.next_ledger);
    if (!Number.isSafeInteger(start) || start < 1) throw new Error('Unsafe stream ledger');
    const rpc = rpcFactory(claim.rpc_url);
    const health = await rpc.getHealth();
    if (start < health.oldestLedger) {
      await recordIncident(pool, claim, 'retention_gap', { oldestLedger: health.oldestLedger, latestLedger: health.latestLedger });
      await release(pool, claim, 'Capture halted: checkpoint is older than provider retention');
      return 'gap';
    }
    if (start > health.latestLedger) {
      if (start > health.latestLedger + 100) await recordIncident(pool, claim, 'suspected_reset', { latestLedger: health.latestLedger, checkpoint: start });
      await release(pool, claim);
      return 'waiting';
    }
    const end = Math.min(start + LEDGER_WINDOW, health.latestLedger + 1);
    const events = await fetchWindow(rpc, claim, end);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fence = await client.query(`SELECT id FROM ingestion_streams WHERE id=$1 AND lease_token=$2
        AND lease_until>now() FOR UPDATE`, [claim.id, claim.lease_token]);
      if (!fence.rows[0]) throw new Error('Ingestion lease expired or superseded');
      for (const event of events) {
        const decoded = decodeEvent(event, claim.decoder);
        const inserted = await client.query<{ id: string }>(`
          INSERT INTO captured_events(environment_id,network,epoch,contract_id,rpc_event_id,tx_hash,
            ledger,ledger_closed_at,topic_xdr,value_xdr,decoded,decoder,decode_error)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
          ON CONFLICT (environment_id,network,epoch,contract_id,rpc_event_id)
          DO UPDATE SET rpc_event_id=EXCLUDED.rpc_event_id RETURNING id`,
        [claim.environment_id, claim.network, claim.epoch, claim.contract_id, event.id, event.txHash,
          event.ledger, event.ledgerClosedAt ?? null, event.topic, event.value,
          decoded.decoded ? JSON.stringify(decoded.decoded) : null, decoded.decoder, decoded.error]);
        const eventId = inserted.rows[0]?.id;
        if (!eventId) throw new Error('Failed to persist captured event');
        if (decoded.error) {
          await client.query(`INSERT INTO coverage_incidents(environment_id,subscription_id,kind,evidence,from_ledger)
            VALUES ($1,$2,'decode_failure',$3::jsonb,$4)`,
          [claim.environment_id, claim.subscription_id, JSON.stringify({ rpcEventId: event.id, error: decoded.error }), event.ledger]);
        } else if (claim.endpoint_version_id) {
          await client.query(`INSERT INTO deliveries(event_id,subscription_id,endpoint_version_id)
            VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [eventId, claim.subscription_id, claim.endpoint_version_id]);
        } else {
          await client.query(`INSERT INTO coverage_incidents(environment_id,subscription_id,kind,evidence,from_ledger)
            VALUES ($1,$2,'endpoint_unavailable',$3::jsonb,$4)`,
          [claim.environment_id, claim.subscription_id, JSON.stringify({ rpcEventId: event.id }), event.ledger]);
        }
      }
      const advanced = await client.query(`UPDATE ingestion_streams SET next_ledger=$3, lease_token=NULL,
        lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 RETURNING id`,
      [claim.id, claim.lease_token, end]);
      if (!advanced.rows[0]) throw new Error('Ingestion lease superseded before checkpoint');
      await client.query('COMMIT');
      return 'captured';
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } catch (error) {
    await release(pool, claim, error instanceof Error ? error.message : 'Ingestion error');
    throw error;
  }
}
