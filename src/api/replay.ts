import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { requireActor, requireEnvironment } from './auth.js';

const uuid = z.uuid();
const planPath = z.object({ id: uuid, planId: uuid });

export function registerReplayRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post('/v1/environments/:id/replay-plans', async (request, reply) => {
    const actor = await requireActor(request, pool, 'replay');
    if (!actor.userId) throw Object.assign(new Error('User session required for replay'), { statusCode: 403 });
    const { id } = z.object({ id: uuid }).parse(request.params);
    const env = await requireEnvironment(pool, actor, id);
    const body = z.object({ endpoint_id: uuid, delivery_ids: z.array(uuid).min(1).max(100),
      reason: z.string().trim().min(10).max(500), include_reported_successes: z.boolean().default(false) }).parse(request.body);
    const selected = [...new Set(body.delivery_ids)];
    const endpoint = await pool.query<{ version_id: string }>(`
      SELECT v.id AS version_id FROM endpoints ep JOIN endpoint_versions v ON v.id=ep.active_version_id
      WHERE ep.id=$1 AND ep.environment_id=$2 AND ep.disabled_at IS NULL AND v.verified_at IS NOT NULL`,
    [body.endpoint_id, id]);
    const version = endpoint.rows[0]?.version_id;
    if (!version) throw Object.assign(new Error('Verified endpoint not found'), { statusCode: 404 });
    const candidates = await pool.query<{ delivery_id: string; event_id: string; subscription_id: string; success: boolean }>(`
      SELECT d.id AS delivery_id,e.id AS event_id,d.subscription_id,
        EXISTS(SELECT 1 FROM processing_receipts r JOIN deliveries rd ON rd.id=r.delivery_id
          WHERE rd.event_id=e.id AND rd.subscription_id=d.subscription_id AND r.status='succeeded') AS success
      FROM deliveries d JOIN captured_events e ON e.id=d.event_id
      JOIN subscriptions sub ON sub.id=d.subscription_id
      JOIN endpoint_versions v ON v.id=d.endpoint_version_id
      WHERE d.id=ANY($1::uuid[]) AND e.environment_id=$2 AND e.epoch=$3
        AND sub.endpoint_id=$4 AND v.endpoint_id=$4`,
    [selected, id, env.epoch, body.endpoint_id]);
    if (candidates.rows.length !== selected.length) throw Object.assign(new Error('Some deliveries are outside replay scope'), { statusCode: 404 });
    const items = candidates.rows.map((item) => ({ ...item, eligibility: item.success && !body.include_reported_successes ? 'excluded_success' : 'eligible' }));
    items.sort((a, b) => a.delivery_id.localeCompare(b.delivery_id));
    const criteria = { source_delivery_ids: selected.sort(), endpoint_id: body.endpoint_id,
      include_reported_successes: body.include_reported_successes, epoch: env.epoch };
    const digest = createHash('sha256').update(JSON.stringify({ environment_id: id, endpoint_version_id: version, criteria, items })).digest('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const plan = await client.query<{ id: string; expires_at: Date }>(`
        INSERT INTO replay_plans(environment_id,endpoint_version_id,created_by,reason,criteria,digest,expires_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,now()+interval '10 minutes') RETURNING id,expires_at`,
      [id, version, actor.userId, body.reason, JSON.stringify(criteria), digest]);
      for (const item of items) await client.query(`INSERT INTO replay_items(plan_id,event_id,subscription_id,eligibility,reason)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [plan.rows[0]!.id, item.event_id, item.subscription_id, item.eligibility,
        item.eligibility === 'excluded_success' ? 'application-reported success' : null]);
      await client.query(`INSERT INTO audit_records(actor_id,project_id,action,detail)
        VALUES ($1,$2,'replay.preview',$3::jsonb)`,
      [actor.userId, env.projectId, JSON.stringify({ plan_id: plan.rows[0]!.id, count: items.length, digest })]);
      await client.query('COMMIT');
      reply.code(201); return { id: plan.rows[0]!.id, digest, expires_at: plan.rows[0]!.expires_at,
        eligible: items.filter((x) => x.eligibility === 'eligible').length,
        exclusions: items.filter((x) => x.eligibility !== 'eligible').map((x) => ({ delivery_id: x.delivery_id, reason: x.eligibility })) };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  app.post('/v1/environments/:id/replay-plans/:planId/execute', async (request) => {
    const actor = await requireActor(request, pool, 'replay');
    if (!actor.userId) throw Object.assign(new Error('User session required for replay'), { statusCode: 403 });
    const { id, planId } = planPath.parse(request.params);
    const env = await requireEnvironment(pool, actor, id);
    const body = z.object({ acknowledge_reported_successes: z.boolean().default(false) }).parse(request.body ?? {});
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{ status: string; expires_at: Date; endpoint_version_id: string; criteria: { epoch: string; endpoint_id: string; include_reported_successes: boolean }; digest: string }>(`
        SELECT status,expires_at,endpoint_version_id,criteria,digest FROM replay_plans
        WHERE id=$1 AND environment_id=$2 FOR UPDATE`, [planId, id]);
      const plan = found.rows[0];
      if (!plan) throw Object.assign(new Error('Replay plan not found'), { statusCode: 404 });
      if (plan.status === 'executed' || plan.status === 'paused') {
        const existing = await client.query('SELECT id,status FROM deliveries WHERE replay_plan_id=$1 ORDER BY created_at,id LIMIT 100', [planId]);
        await client.query('COMMIT'); return { id: planId, idempotent: true, jobs: existing.rows };
      }
      if (plan.status !== 'previewed' || plan.expires_at <= new Date()) throw Object.assign(new Error('Replay plan expired or unavailable'), { statusCode: 409 });
      if (plan.criteria.epoch !== env.epoch) throw Object.assign(new Error('Network epoch changed'), { statusCode: 409 });
      const active = await client.query(`SELECT 1 FROM endpoints ep JOIN endpoint_versions v ON v.id=ep.active_version_id
        WHERE ep.id=$1 AND ep.environment_id=$2 AND v.id=$3 AND v.verified_at IS NOT NULL AND ep.disabled_at IS NULL`,
      [plan.criteria.endpoint_id, id, plan.endpoint_version_id]);
      if (!active.rows[0]) throw Object.assign(new Error('Endpoint configuration changed'), { statusCode: 409 });
      if (plan.criteria.include_reported_successes && !body.acknowledge_reported_successes) {
        throw Object.assign(new Error('Explicit acknowledgement required for reported successes'), { statusCode: 409 });
      }
      const items = await client.query<{ event_id: string; subscription_id: string; eligibility: string; now_success: boolean }>(`
        SELECT i.event_id,i.subscription_id,i.eligibility,
          EXISTS(SELECT 1 FROM processing_receipts r JOIN deliveries d ON d.id=r.delivery_id
            WHERE d.event_id=i.event_id AND d.subscription_id=i.subscription_id AND r.status='succeeded') AS now_success
        FROM replay_items i WHERE i.plan_id=$1 ORDER BY i.event_id,i.subscription_id FOR UPDATE`, [planId]);
      let queued = 0, skipped = 0;
      for (const item of items.rows) {
        if (item.eligibility !== 'eligible' || (item.now_success && !body.acknowledge_reported_successes)) { skipped++; continue; }
        const created = await client.query(`INSERT INTO deliveries(event_id,subscription_id,endpoint_version_id,replay_plan_id)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
        [item.event_id, item.subscription_id, plan.endpoint_version_id, planId]);
        if (created.rows[0]) queued++;
      }
      await client.query(`UPDATE replay_plans SET status='executed',executed_at=now() WHERE id=$1`, [planId]);
      await client.query(`INSERT INTO audit_records(actor_id,project_id,action,detail)
        VALUES ($1,$2,'replay.execute',$3::jsonb)`,
      [actor.userId, env.projectId, JSON.stringify({ plan_id: planId, digest: plan.digest, queued, skipped })]);
      await client.query('COMMIT');
      return { id: planId, queued, skipped, idempotent: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  app.get('/v1/environments/:id/replay-plans/:planId', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const { id, planId } = planPath.parse(request.params); await requireEnvironment(pool, actor, id);
    const result = await pool.query(`SELECT id,status,reason,criteria,digest,expires_at,created_at,executed_at
      FROM replay_plans WHERE id=$1 AND environment_id=$2`, [planId, id]);
    if (!result.rows[0]) throw Object.assign(new Error('Replay plan not found'), { statusCode: 404 });
    const counts = await pool.query(`SELECT status,count(*)::int AS count FROM deliveries WHERE replay_plan_id=$1 GROUP BY status`, [planId]);
    return { ...result.rows[0], delivery_counts: counts.rows };
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/v1/environments/:id/replay-plans/:planId/${action}`, async (request) => {
      const actor = await requireActor(request, pool, 'replay');
      if (!actor.userId) throw Object.assign(new Error('User session required for replay'), { statusCode: 403 });
      const { id, planId } = planPath.parse(request.params);
      const env = await requireEnvironment(pool, actor, id);
      const next = action === 'pause' ? 'paused' : action === 'resume' ? 'executed' : 'cancelled';
      const previous = action === 'resume' ? 'paused' : 'executed';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const changed = await client.query(`UPDATE replay_plans SET status=$3 WHERE id=$1 AND environment_id=$2 AND status=$4 RETURNING id`,
        [planId, id, next, previous]);
        if (!changed.rows[0]) throw Object.assign(new Error('Replay plan state conflict'), { statusCode: 409 });
        if (action === 'cancel') await client.query(`UPDATE deliveries SET status='cancelled' WHERE replay_plan_id=$1 AND status IN ('queued','retry_scheduled')`, [planId]);
        await client.query(`INSERT INTO audit_records(actor_id,project_id,action,detail) VALUES ($1,$2,$3,$4::jsonb)`,
        [actor.userId, env.projectId, `replay.${action}`, JSON.stringify({ plan_id: planId })]);
        await client.query('COMMIT'); return { id: planId, status: next };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  }
}
