import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { hashSecret } from '../crypto.js';

export const receiptSchema = z.object({
  schema_version: z.literal(1), receipt_id: z.string().min(1).max(100),
  event_id: z.string().regex(/^\d{19}-\d{10}$/), delivery_id: z.uuid(), consumer_id: z.uuid(),
  processing_run_id: z.string().min(1).max(100), sequence: z.number().int().min(0),
  status: z.enum(['processing', 'succeeded', 'failed']), observed_at: z.iso.datetime({ offset: true }),
  error: z.string().max(500).optional(), business_reference: z.string().max(200).optional(),
});

export type Receipt = z.infer<typeof receiptSchema>;

export function processingState(receipts: Pick<Receipt, 'processing_run_id' | 'sequence' | 'status'>[]):
  'awaiting_receipt' | 'reported_processing' | 'reported_succeeded' | 'reported_failed' | 'conflict' {
  if (!receipts.length) return 'awaiting_receipt';
  const runs = new Map<string, Set<string>>();
  for (const receipt of receipts) {
    const states = runs.get(receipt.processing_run_id) ?? new Set<string>();
    states.add(receipt.status); runs.set(receipt.processing_run_id, states);
  }
  if ([...runs.values()].some((states) => states.has('succeeded') && states.has('failed'))) return 'conflict';
  if ([...runs.values()].some((states) => states.has('succeeded'))) return 'reported_succeeded';
  const latest = [...receipts].sort((a, b) => b.sequence - a.sequence)[0];
  return latest?.status === 'failed' ? 'reported_failed' : 'reported_processing';
}

export function registerReceiptRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post('/v1/processing-receipts', async (request, reply) => {
    const bearer = request.headers.authorization;
    if (!bearer?.startsWith('Bearer spr_')) throw Object.assign(new Error('Consumer credential required'), { statusCode: 401 });
    const credential = await pool.query<{ consumer_id: string; environment_id: string }>(`
      SELECT c.id AS consumer_id,c.environment_id FROM consumer_credentials cc
      JOIN consumers c ON c.id=cc.consumer_id
      WHERE cc.token_hash=$1 AND cc.revoked_at IS NULL`, [hashSecret(bearer.slice(7))]);
    const scope = credential.rows[0];
    if (!scope) throw Object.assign(new Error('Invalid consumer credential'), { statusCode: 401 });
    const body = receiptSchema.parse(request.body);
    if (body.consumer_id !== scope.consumer_id) throw Object.assign(new Error('Consumer scope mismatch'), { statusCode: 403 });
    const delivery = await pool.query<{ event_id: string }>(`
      SELECT e.rpc_event_id AS event_id FROM deliveries d
      JOIN captured_events e ON e.id=d.event_id
      WHERE d.id=$1 AND e.environment_id=$2 AND e.rpc_event_id=$3`,
    [body.delivery_id, scope.environment_id, body.event_id]);
    if (!delivery.rows[0]) throw Object.assign(new Error('Delivery not found in consumer scope'), { statusCode: 404 });
    const normalized = JSON.stringify(body);
    const digest = hashSecret(normalized);
    const result = await pool.query<{ id: string; body_hash: string }>(`
      INSERT INTO processing_receipts(receipt_id,environment_id,consumer_id,delivery_id,event_id,
        processing_run_id,sequence,status,observed_at,error,business_reference,body_hash)
      SELECT $1,$2,$3,$4,e.id,$5,$6,$7,$8,$9,$10,$11 FROM captured_events e
      WHERE e.environment_id=$2 AND e.rpc_event_id=$12 AND e.id=(SELECT event_id FROM deliveries WHERE id=$4)
      ON CONFLICT DO NOTHING RETURNING id,body_hash`,
    [body.receipt_id, scope.environment_id, scope.consumer_id, body.delivery_id, body.processing_run_id,
      body.sequence, body.status, body.observed_at, body.error ?? null, body.business_reference ?? null, digest, body.event_id]);
    if (result.rows[0]) { reply.code(201); return { accepted: true, duplicate: false }; }
    const existing = await pool.query<{ body_hash: string }>(`
      SELECT body_hash FROM processing_receipts WHERE consumer_id=$1 AND receipt_id=$2`,
    [scope.consumer_id, body.receipt_id]);
    if (existing.rows[0]?.body_hash === digest) return { accepted: true, duplicate: true };
    throw Object.assign(new Error('Conflicting receipt ID or sequence'), { statusCode: 409 });
  });
}
