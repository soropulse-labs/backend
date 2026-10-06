import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { requireActor, requireEnvironment } from './auth.js';
import { processingState } from './receipts.js';

const idPath = z.object({ id: z.uuid() });
const pagination = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10000).default(0) });

async function eventTrace(pool: pg.Pool, environmentId: string, rpcEventId: string) {
  const found = await pool.query(`SELECT e.* FROM captured_events e WHERE e.environment_id=$1 AND e.rpc_event_id=$2 LIMIT 1`,
  [environmentId, rpcEventId]);
  const event = found.rows[0];
  if (!event) return null;
  const deliveries = await pool.query(`SELECT d.id,d.status,d.attempt_count,d.created_at,d.acknowledged_at,
    d.replay_plan_id,d.endpoint_version_id,ep.name AS endpoint_name
    FROM deliveries d JOIN endpoint_versions v ON v.id=d.endpoint_version_id
    JOIN endpoints ep ON ep.id=v.endpoint_id WHERE d.event_id=$1 ORDER BY d.created_at,d.id LIMIT 100`, [event.id]);
  const items = [];
  const timeline: { at: string; kind: string; delivery_id?: string; detail?: unknown }[] = [
    { at: event.ledger_closed_at?.toISOString() ?? event.captured_at.toISOString(), kind: 'blockchain_event' },
    { at: event.captured_at.toISOString(), kind: 'captured' },
  ];
  for (const delivery of deliveries.rows) {
    const attempts = await pool.query(`SELECT attempt_number,started_at,completed_at,duration_ms,http_status,
      failure_class,response_preview FROM delivery_attempts WHERE delivery_id=$1 ORDER BY attempt_number LIMIT 100`, [delivery.id]);
    const receipts = await pool.query(`SELECT receipt_id,consumer_id,processing_run_id,sequence,status,observed_at,
      received_at,error,business_reference FROM processing_receipts WHERE delivery_id=$1 ORDER BY received_at,sequence LIMIT 100`, [delivery.id]);
    const application = receipts.rows.length ? processingState(receipts.rows) :
      delivery.status === 'acknowledged' && delivery.acknowledged_at && Date.now() - delivery.acknowledged_at.getTime() > 300000
        ? 'overdue' : 'awaiting_receipt';
    items.push({ ...delivery, attempts: attempts.rows, receipts: receipts.rows, dimensions: {
      capture: 'captured', transport: delivery.status, application,
    } });
    timeline.push({ at: delivery.created_at.toISOString(), kind: delivery.replay_plan_id ? 'replay_queued' : 'delivery_queued', delivery_id: delivery.id });
    for (const attempt of attempts.rows) timeline.push({ at: attempt.started_at.toISOString(), kind: 'delivery_attempt', delivery_id: delivery.id,
      detail: { number: attempt.attempt_number, http_status: attempt.http_status, failure: attempt.failure_class } });
    for (const receipt of receipts.rows) timeline.push({ at: receipt.received_at.toISOString(), kind: 'processing_receipt', delivery_id: delivery.id,
      detail: { status: receipt.status, run_id: receipt.processing_run_id, sequence: receipt.sequence } });
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  return { event, deliveries: items, timeline };
}

export function registerTraceRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/v1/environments/:id/events', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const { id } = idPath.parse(request.params); await requireEnvironment(pool, actor, id);
    const query = pagination.extend({ contract_id: z.string().optional() }).parse(request.query);
    const result = await pool.query(`SELECT id,rpc_event_id,contract_id,tx_hash,ledger,ledger_closed_at,
      decoded,decoder,decode_error,captured_at FROM captured_events WHERE environment_id=$1
      AND ($2::text IS NULL OR contract_id=$2) ORDER BY ledger DESC,rpc_event_id DESC LIMIT $3 OFFSET $4`,
    [id, query.contract_id ?? null, query.limit, query.offset]);
    return { items: result.rows };
  });

  app.get('/v1/environments/:id/events/:eventId', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const params = z.object({ id: z.uuid(), eventId: z.string().regex(/^\d{19}-\d{10}$/) }).parse(request.params);
    await requireEnvironment(pool, actor, params.id);
    const trace = await eventTrace(pool, params.id, params.eventId);
    if (!trace) throw Object.assign(new Error('Event not found in captured history'), { statusCode: 404 });
    return trace;
  });

  app.get('/v1/environments/:id/transactions/:hash', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const params = z.object({ id: z.uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/i) }).parse(request.params);
    await requireEnvironment(pool, actor, params.id);
    const events = await pool.query(`SELECT rpc_event_id,contract_id,ledger,decoded,decode_error,captured_at
      FROM captured_events WHERE environment_id=$1 AND tx_hash=$2 ORDER BY ledger,rpc_event_id LIMIT 100`,
    [params.id, params.hash.toLowerCase()]);
    if (events.rows.length) return { capture: 'captured', events: events.rows };
    const subscriptions = await pool.query(`SELECT contract_id,start_ledger,topic0_xdr,active
      FROM subscriptions WHERE environment_id=$1 ORDER BY created_at DESC LIMIT 100`, [params.id]);
    const gaps = await pool.query(`SELECT kind,from_ledger,to_ledger,evidence,created_at FROM coverage_incidents
      WHERE environment_id=$1 AND status='open' ORDER BY created_at DESC LIMIT 20`, [params.id]);
    return { capture: subscriptions.rows.length ? gaps.rows.length ? 'capture_gap' : 'inconclusive' : 'outside_capture_scope',
      events: [], explanation: 'No local event proves neither that a blockchain event exists nor that it does not exist.',
      subscriptions: subscriptions.rows, known_gaps: gaps.rows };
  });

  app.get('/v1/environments/:id/deliveries', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const { id } = idPath.parse(request.params); await requireEnvironment(pool, actor, id);
    const query = pagination.parse(request.query);
    const result = await pool.query(`SELECT d.id,d.status,d.attempt_count,d.created_at,d.acknowledged_at,
      e.rpc_event_id,e.contract_id,e.tx_hash,v.url FROM deliveries d JOIN captured_events e ON e.id=d.event_id
      JOIN endpoint_versions v ON v.id=d.endpoint_version_id WHERE e.environment_id=$1
      ORDER BY d.created_at DESC LIMIT $2 OFFSET $3`, [id, query.limit, query.offset]);
    return { items: result.rows };
  });

  app.get('/v1/environments/:id/deliveries/:deliveryId', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const params = z.object({ id: z.uuid(), deliveryId: z.uuid() }).parse(request.params);
    await requireEnvironment(pool, actor, params.id);
    const result = await pool.query(`SELECT e.rpc_event_id FROM deliveries d JOIN captured_events e ON e.id=d.event_id
      WHERE d.id=$1 AND e.environment_id=$2`, [params.deliveryId, params.id]);
    if (!result.rows[0]) throw Object.assign(new Error('Delivery not found'), { statusCode: 404 });
    return eventTrace(pool, params.id, result.rows[0].rpc_event_id);
  });

  app.get('/v1/environments/:id/coverage-incidents', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const { id } = idPath.parse(request.params); await requireEnvironment(pool, actor, id);
    const query = pagination.parse(request.query);
    const result = await pool.query(`SELECT id,kind,status,from_ledger,to_ledger,evidence,created_at,resolved_at
      FROM coverage_incidents WHERE environment_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [id, query.limit, query.offset]);
    return { items: result.rows };
  });
}
