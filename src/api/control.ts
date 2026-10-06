import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { StrKey, xdr } from '@stellar/stellar-sdk';
import { z } from 'zod';
import type { Config } from '../config.js';
import { decrypt, encrypt, hashSecret, newSecret } from '../crypto.js';
import { postWebhook, validateDestination } from '../delivery/http.js';
import { webhookHeaders } from '../protocol/webhook.js';
import { requireActor, requireEnvironment, requireProject } from './auth.js';

const uuid = z.uuid();
const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10000).default(0) });
const pathId = z.object({ id: uuid });

export function registerControlRoutes(app: FastifyInstance, pool: pg.Pool, config: Config): void {
  app.get('/v1/projects', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const p = page.parse(request.query);
    const result = actor.kind === 'session'
      ? await pool.query('SELECT id,name,created_at FROM projects WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [actor.userId, p.limit, p.offset])
      : await pool.query('SELECT id,name,created_at FROM projects WHERE id=$1', [actor.projectId]);
    return { items: result.rows };
  });

  app.post('/v1/projects', async (request, reply) => {
    const actor = await requireActor(request, pool, 'write');
    if (!actor.userId) throw Object.assign(new Error('User session required'), { statusCode: 403 });
    const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    const result = await pool.query('INSERT INTO projects(owner_id,name) VALUES ($1,$2) RETURNING id,name,created_at', [actor.userId, body.name]);
    reply.code(201); return result.rows[0];
  });

  app.get('/v1/projects/:id/environments', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const { id } = pathId.parse(request.params); await requireProject(pool, actor, id);
    const result = await pool.query('SELECT id,name,network,epoch,active,created_at FROM environments WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100', [id]);
    return { items: result.rows };
  });

  app.post('/v1/projects/:id/environments', async (request, reply) => {
    const actor = await requireActor(request, pool, 'write');
    const { id } = pathId.parse(request.params); await requireProject(pool, actor, id);
    const body = z.object({ name: z.string().trim().min(1).max(80), epoch: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/) }).parse(request.body);
    const result = await pool.query(`INSERT INTO environments(project_id,name,network,epoch,rpc_url,network_passphrase)
      VALUES ($1,$2,'testnet',$3,$4,$5) RETURNING id,name,network,epoch`,
    [id, body.name, body.epoch, config.STELLAR_RPC_URL, config.NETWORK_PASSPHRASE]);
    reply.code(201); return result.rows[0];
  });

  app.post('/v1/projects/:id/api-keys', async (request, reply) => {
    const actor = await requireActor(request, pool, 'write');
    if (!actor.userId) throw Object.assign(new Error('User session required'), { statusCode: 403 });
    const { id } = pathId.parse(request.params); await requireProject(pool, actor, id);
    const body = z.object({ name: z.string().trim().min(1).max(80), environment_id: uuid.nullable().default(null),
      scopes: z.array(z.enum(['read', 'write', 'replay', 'lab'])).min(1).max(4) }).parse(request.body);
    if (body.environment_id) {
      const env = await requireEnvironment(pool, actor, body.environment_id);
      if (env.projectId !== id) throw Object.assign(new Error('Environment not found'), { statusCode: 404 });
    }
    const secret = newSecret('spk');
    const result = await pool.query(`INSERT INTO api_keys(project_id,environment_id,name,token_hash,scopes)
      VALUES ($1,$2,$3,$4,$5) RETURNING id,name,scopes,created_at`,
    [id, body.environment_id, body.name, hashSecret(secret), body.scopes]);
    reply.code(201); return { ...result.rows[0], secret };
  });

  app.get('/v1/projects/:id/api-keys', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const { id } = pathId.parse(request.params); await requireProject(pool, actor, id);
    const result = await pool.query(`SELECT id,name,environment_id,scopes,created_at,revoked_at FROM api_keys
      WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`, [id]);
    return { items: result.rows };
  });

  app.post('/v1/projects/:id/api-keys/:keyId/revoke', async (request) => {
    const actor = await requireActor(request, pool, 'write');
    if (!actor.userId) throw Object.assign(new Error('User session required'), { statusCode: 403 });
    const params = z.object({ id: uuid, keyId: uuid }).parse(request.params);
    await requireProject(pool, actor, params.id);
    const result = await pool.query(`UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND project_id=$2 RETURNING id`, [params.keyId, params.id]);
    if (!result.rows[0]) throw Object.assign(new Error('API key not found'), { statusCode: 404 });
    return { revoked: true };
  });

  app.get('/v1/environments/:id/endpoints', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const { id } = pathId.parse(request.params); await requireEnvironment(pool, actor, id);
    const result = await pool.query(`SELECT ep.id,ep.name,ep.disabled_at,v.id AS version_id,v.version,v.url,v.verified_at
      FROM endpoints ep LEFT JOIN endpoint_versions v ON v.id=ep.active_version_id
      WHERE ep.environment_id=$1 ORDER BY ep.created_at DESC LIMIT 100`, [id]);
    return { items: result.rows };
  });

  app.post('/v1/environments/:id/endpoints', async (request, reply) => {
    const actor = await requireActor(request, pool, 'write');
    const { id } = pathId.parse(request.params); await requireEnvironment(pool, actor, id);
    const body = z.object({ name: z.string().trim().min(1).max(80), url: z.url().max(2048) }).parse(request.body);
    await validateDestination(body.url, config);
    const secret = randomBytes(32).toString('base64url');
    const keyId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ep = await client.query<{ id: string }>('INSERT INTO endpoints(environment_id,name) VALUES ($1,$2) RETURNING id', [id, body.name]);
      const version = await client.query<{ id: string }>(`INSERT INTO endpoint_versions(endpoint_id,version,url,signing_secret_cipher,signing_key_id)
        VALUES ($1,1,$2,$3,$4) RETURNING id`, [ep.rows[0]!.id, body.url, encrypt(secret, config.ENCRYPTION_KEY), keyId]);
      await client.query('UPDATE endpoints SET active_version_id=$2 WHERE id=$1', [ep.rows[0]!.id, version.rows[0]!.id]);
      await client.query('COMMIT');
      reply.code(201); return { id: ep.rows[0]!.id, version_id: version.rows[0]!.id, signing_secret: secret, signing_key_id: keyId,
        verification: 'POST /v1/endpoints/:id/verify; receiver must return challenge in response body' };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  app.post('/v1/endpoints/:id/verify', async (request) => {
    const actor = await requireActor(request, pool, 'write');
    const { id } = pathId.parse(request.params);
    const { version_id: requestedVersion } = z.object({ version_id: uuid.optional() }).parse(request.body ?? {});
    const ep = await pool.query<{ environment_id: string; version_id: string; active_version_id: string; url: string; signing_secret_cipher: string; signing_key_id: string; version: number }>(`
      SELECT ep.environment_id,ep.active_version_id,v.id AS version_id,v.version,v.url,v.signing_secret_cipher,v.signing_key_id
      FROM endpoints ep JOIN endpoint_versions v ON v.endpoint_id=ep.id
      WHERE ep.id=$1 AND ep.disabled_at IS NULL AND v.id=COALESCE($2::uuid,ep.active_version_id)`, [id, requestedVersion ?? null]);
    const row = ep.rows[0]; if (!row) throw Object.assign(new Error('Endpoint not found'), { statusCode: 404 });
    await requireEnvironment(pool, actor, row.environment_id);
    const latest = await pool.query<{ version: number }>('SELECT max(version)::int AS version FROM endpoint_versions WHERE endpoint_id=$1', [id]);
    if (requestedVersion && row.version !== latest.rows[0]?.version) throw Object.assign(new Error('Endpoint version is stale'), { statusCode: 409 });
    const challenge = randomBytes(24).toString('hex');
    const body = Buffer.from(JSON.stringify({ type: 'soropulse.endpoint.verify', challenge }));
    const headers = webhookHeaders(decrypt(row.signing_secret_cipher, config.ENCRYPTION_KEY), row.signing_key_id, randomUUID(), body);
    const result = await postWebhook(row.url, body, headers, config);
    if (result.status !== 200 || result.preview !== challenge) throw Object.assign(new Error('Endpoint verification failed'), { statusCode: 422 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query(`UPDATE endpoints SET active_version_id=$2 WHERE id=$1 AND active_version_id=$3
        AND NOT EXISTS (SELECT 1 FROM endpoint_versions newer WHERE newer.endpoint_id=$1 AND newer.version>$4)
        RETURNING id`, [id, row.version_id, row.active_version_id, row.version]);
      if (!changed.rows[0]) throw Object.assign(new Error('Endpoint changed during verification'), { statusCode: 409 });
      await client.query('UPDATE endpoint_versions SET verified_at=now() WHERE id=$1', [row.version_id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return { verified: true, version_id: row.version_id, activated: row.version_id !== row.active_version_id };
  });

  async function stageVersion(request: FastifyRequest, id: string,
    destination?: string) {
    const actor = await requireActor(request, pool, 'write');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const endpoint = await client.query<{ environment_id: string; url: string; version: number }>(`
        SELECT ep.environment_id,v.url,v.version FROM endpoints ep
        JOIN endpoint_versions v ON v.id=ep.active_version_id
        WHERE ep.id=$1 AND ep.disabled_at IS NULL FOR UPDATE OF ep`, [id]);
      const active = endpoint.rows[0];
      if (!active) throw Object.assign(new Error('Endpoint not found'), { statusCode: 404 });
      await requireEnvironment(pool, actor, active.environment_id);
      const url = destination ?? active.url;
      const secret = randomBytes(32).toString('base64url');
      const keyId = randomUUID();
      const next = await client.query<{ id: string; version: number }>(`INSERT INTO endpoint_versions(endpoint_id,version,url,signing_secret_cipher,signing_key_id)
        SELECT $1,max(version)+1,$2,$3,$4 FROM endpoint_versions WHERE endpoint_id=$1
        RETURNING id,version`, [id, url, encrypt(secret, config.ENCRYPTION_KEY), keyId]);
      await client.query('COMMIT');
      return { endpoint_id: id, version_id: next.rows[0]!.id, version: next.rows[0]!.version,
        signing_secret: secret, signing_key_id: keyId, url,
        verification: `POST /v1/endpoints/${id}/verify with {"version_id":"${next.rows[0]!.id}"}` };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  app.post('/v1/endpoints/:id/rotate-key', async (request, reply) => {
    const { id } = pathId.parse(request.params);
    const result = await stageVersion(request, id);
    reply.code(201); return result;
  });

  app.post('/v1/endpoints/:id/change-destination', async (request, reply) => {
    const { id } = pathId.parse(request.params);
    const { url } = z.object({ url: z.url().max(2048) }).parse(request.body);
    await validateDestination(url, config);
    const result = await stageVersion(request, id, url);
    reply.code(201); return result;
  });

  app.post('/v1/endpoints/:id/disable', async (request) => {
    const actor = await requireActor(request, pool, 'write');
    const { id } = pathId.parse(request.params);
    const ep = await pool.query<{ environment_id: string }>('SELECT environment_id FROM endpoints WHERE id=$1', [id]);
    if (!ep.rows[0]) throw Object.assign(new Error('Endpoint not found'), { statusCode: 404 });
    await requireEnvironment(pool, actor, ep.rows[0].environment_id);
    await pool.query(`UPDATE endpoints SET disabled_at=now() WHERE id=$1`, [id]);
    await pool.query(`UPDATE deliveries SET status='cancelled',lease_token=NULL,lease_until=NULL
      WHERE endpoint_version_id IN (SELECT id FROM endpoint_versions WHERE endpoint_id=$1)
      AND status IN ('queued','retry_scheduled')`, [id]);
    return { disabled: true };
  });

  app.post('/v1/environments/:id/subscriptions', async (request, reply) => {
    const actor = await requireActor(request, pool, 'write');
    const { id } = pathId.parse(request.params); await requireEnvironment(pool, actor, id);
    const body = z.object({ endpoint_id: uuid, contract_id: z.string(), start_ledger: z.number().int().positive(),
      topic0_xdr: z.string().nullable().default(null), decoder: z.enum(['soropulse.ticket.v1']).nullable().default(null) }).parse(request.body);
    if (!StrKey.isValidContract(body.contract_id)) throw Object.assign(new Error('Invalid contract ID'), { statusCode: 400 });
    if (body.topic0_xdr) {
      try { const val = xdr.ScVal.fromXDR(body.topic0_xdr, 'base64'); if (val.switch().name !== 'scvSymbol') throw new Error(); }
      catch { throw Object.assign(new Error('Invalid topic filter'), { statusCode: 400 }); }
    }
    const ep = await pool.query(`SELECT ep.id FROM endpoints ep JOIN endpoint_versions v ON v.id=ep.active_version_id
      WHERE ep.id=$1 AND ep.environment_id=$2 AND ep.disabled_at IS NULL AND v.verified_at IS NOT NULL`, [body.endpoint_id, id]);
    if (!ep.rows[0]) throw Object.assign(new Error('Verified endpoint required'), { statusCode: 422 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sub = await client.query<{ id: string }>(`INSERT INTO subscriptions(environment_id,endpoint_id,contract_id,topic0_xdr,decoder,start_ledger)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [id, body.endpoint_id, body.contract_id, body.topic0_xdr, body.decoder, body.start_ledger]);
      await client.query(`INSERT INTO ingestion_streams(subscription_id,next_ledger) VALUES ($1,$2)`, [sub.rows[0]!.id, body.start_ledger]);
      await client.query('COMMIT');
      reply.code(201); return { id: sub.rows[0]!.id, ...body };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  app.get('/v1/environments/:id/subscriptions', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    const { id } = pathId.parse(request.params); await requireEnvironment(pool, actor, id);
    const result = await pool.query(`SELECT sub.id,sub.endpoint_id,sub.contract_id,sub.topic0_xdr,sub.decoder,
      sub.start_ledger,sub.active,s.next_ledger,s.last_error FROM subscriptions sub
      JOIN ingestion_streams s ON s.subscription_id=sub.id WHERE sub.environment_id=$1 ORDER BY sub.created_at DESC LIMIT 100`, [id]);
    return { items: result.rows };
  });

  app.post('/v1/subscriptions/:id/disable', async (request) => {
    const actor = await requireActor(request, pool, 'write');
    const { id } = pathId.parse(request.params);
    const sub = await pool.query<{ environment_id: string }>('SELECT environment_id FROM subscriptions WHERE id=$1', [id]);
    if (!sub.rows[0]) throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    await requireEnvironment(pool, actor, sub.rows[0].environment_id);
    await pool.query('UPDATE subscriptions SET active=false WHERE id=$1', [id]);
    return { disabled: true };
  });

  app.post('/v1/environments/:id/consumers', async (request, reply) => {
    const actor = await requireActor(request, pool, 'write');
    const { id } = pathId.parse(request.params); await requireEnvironment(pool, actor, id);
    const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    const secret = newSecret('spr');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const consumer = await client.query<{ id: string }>('INSERT INTO consumers(environment_id,name) VALUES ($1,$2) RETURNING id', [id, body.name]);
      const cred = await client.query<{ id: string }>(`INSERT INTO consumer_credentials(consumer_id,token_hash) VALUES ($1,$2) RETURNING id`,
      [consumer.rows[0]!.id, hashSecret(secret)]);
      await client.query('COMMIT'); reply.code(201);
      return { id: consumer.rows[0]!.id, credential_id: cred.rows[0]!.id, secret };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  app.post('/v1/consumers/:id/credentials/:credentialId/revoke', async (request) => {
    const actor = await requireActor(request, pool, 'write');
    const { id, credentialId } = z.object({ id: uuid, credentialId: uuid }).parse(request.params);
    const c = await pool.query<{ environment_id: string }>('SELECT environment_id FROM consumers WHERE id=$1', [id]);
    if (!c.rows[0]) throw Object.assign(new Error('Consumer not found'), { statusCode: 404 });
    await requireEnvironment(pool, actor, c.rows[0].environment_id);
    await pool.query('UPDATE consumer_credentials SET revoked_at=now() WHERE id=$1 AND consumer_id=$2', [credentialId, id]);
    return { revoked: true };
  });
}
