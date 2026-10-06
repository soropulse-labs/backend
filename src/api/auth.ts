import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from '../config.js';
import { decrypt, encrypt, hashSecret, newSecret, safeEqual } from '../crypto.js';

export interface Actor {
  userId: string | null; projectId: string | null; environmentId: string | null;
  scopes: string[]; kind: 'session' | 'api_key'; csrfHash: string | null;
}

function cookieOptions(config: Config, maxAge: number) {
  return { path: '/', httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax' as const, maxAge };
}

async function createSession(pool: pg.Pool, userId: string, reply: FastifyReply, config: Config): Promise<string> {
  const token = newSecret('sps');
  const csrf = newSecret('csrf');
  await pool.query(`INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at)
    VALUES ($1,$2,$3,now()+interval '7 days')`, [userId, hashSecret(token), hashSecret(csrf)]);
  reply.setCookie('soropulse_session', token, cookieOptions(config, 7 * 86400));
  return csrf;
}

export async function resolveActor(request: FastifyRequest, pool: pg.Pool): Promise<Actor | null> {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7);
    if (!token.startsWith('spk_')) return null;
    const result = await pool.query<{ project_id: string; environment_id: string | null; scopes: string[] }>(`
      SELECT project_id,environment_id,scopes FROM api_keys WHERE token_hash=$1 AND revoked_at IS NULL`, [hashSecret(token)]);
    const key = result.rows[0];
    return key ? { userId: null, projectId: key.project_id, environmentId: key.environment_id,
      scopes: key.scopes, kind: 'api_key', csrfHash: null } : null;
  }
  const cookie = request.cookies.soropulse_session;
  if (!cookie) return null;
  const result = await pool.query<{ user_id: string; csrf_hash: string }>(`
    SELECT user_id,csrf_hash FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`, [hashSecret(cookie)]);
  const session = result.rows[0];
  return session ? { userId: session.user_id, projectId: null, environmentId: null,
    scopes: ['read', 'write', 'replay', 'lab'], kind: 'session', csrfHash: session.csrf_hash } : null;
}

export async function requireActor(request: FastifyRequest, pool: pg.Pool, scope: string): Promise<Actor> {
  const actor = await resolveActor(request, pool);
  if (!actor) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  if (!actor.scopes.includes(scope)) throw Object.assign(new Error('Insufficient scope'), { statusCode: 403 });
  if (actor.kind === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const csrf = request.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !actor.csrfHash || !safeEqual(hashSecret(csrf), actor.csrfHash)) {
      throw Object.assign(new Error('CSRF token required'), { statusCode: 403 });
    }
  }
  return actor;
}

export async function requireProject(pool: pg.Pool, actor: Actor, projectId: string): Promise<void> {
  if (actor.kind === 'api_key') {
    if (actor.projectId !== projectId) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    return;
  }
  const result = await pool.query('SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2', [projectId, actor.userId]);
  if (!result.rows[0]) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
}

export async function requireEnvironment(pool: pg.Pool, actor: Actor, environmentId: string): Promise<{ id: string; projectId: string; epoch: string; network: string }> {
  const result = await pool.query<{ id: string; project_id: string; epoch: string; network: string }>(`
    SELECT env.id,env.project_id,env.epoch,env.network FROM environments env
    JOIN projects p ON p.id=env.project_id WHERE env.id=$1 AND ($2::uuid IS NULL OR p.owner_id=$2)`,
  [environmentId, actor.userId]);
  const row = result.rows[0];
  if (!row || (actor.kind === 'api_key' && (actor.projectId !== row.project_id ||
      (actor.environmentId !== null && actor.environmentId !== row.id)))) {
    throw Object.assign(new Error('Environment not found'), { statusCode: 404 });
  }
  return { id: row.id, projectId: row.project_id, epoch: row.epoch, network: row.network };
}

export function registerAuthRoutes(app: FastifyInstance, pool: pg.Pool, config: Config): void {
  app.get('/v1/auth/github', async (_request, reply) => {
    if (!config.GITHUB_CLIENT_ID) throw Object.assign(new Error('GitHub OAuth not configured'), { statusCode: 503 });
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await pool.query(`INSERT INTO oauth_states(state_hash,code_verifier_cipher,expires_at)
      VALUES ($1,$2,now()+interval '10 minutes')`, [hashSecret(state), encrypt(verifier, config.ENCRYPTION_KEY)]);
    reply.setCookie('soropulse_oauth_state', state, cookieOptions(config, 600));
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', config.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', new URL('/v1/auth/github/callback', config.PUBLIC_BASE_URL).href);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return reply.redirect(url.href);
  });

  app.get('/v1/auth/github/callback', async (request, reply) => {
    const parsed = z.object({ code: z.string().min(1), state: z.string().min(1) }).safeParse(request.query);
    const cookieState = request.cookies.soropulse_oauth_state;
    if (!parsed.success || !cookieState || !safeEqual(cookieState, parsed.data.state)) {
      throw Object.assign(new Error('Invalid OAuth state'), { statusCode: 400 });
    }
    const state = await pool.query<{ code_verifier_cipher: string }>(`
      DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING code_verifier_cipher`,
    [hashSecret(parsed.data.state)]);
    if (!state.rows[0]) throw Object.assign(new Error('Expired OAuth state'), { statusCode: 400 });
    reply.clearCookie('soropulse_oauth_state', { path: '/' });
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.GITHUB_CLIENT_ID, client_secret: config.GITHUB_CLIENT_SECRET,
        code: parsed.data.code, redirect_uri: new URL('/v1/auth/github/callback', config.PUBLIC_BASE_URL).href,
        code_verifier: decrypt(state.rows[0].code_verifier_cipher, config.ENCRYPTION_KEY) }),
    });
    if (!response.ok) throw Object.assign(new Error('GitHub OAuth exchange failed'), { statusCode: 502 });
    const token = z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
    const profileResponse = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'SoroPulse' },
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!profileResponse.ok) throw Object.assign(new Error('GitHub profile lookup failed'), { statusCode: 502 });
    const profile = z.object({ id: z.number().int(), login: z.string().min(1) }).parse(await profileResponse.json());
    const user = await pool.query<{ id: string }>(`INSERT INTO users(github_id,login) VALUES ($1,$2)
      ON CONFLICT (github_id) DO UPDATE SET login=EXCLUDED.login RETURNING id`, [String(profile.id), profile.login]);
    const csrf = await createSession(pool, user.rows[0]!.id, reply, config);
    reply.setCookie('soropulse_csrf_bootstrap', csrf, { path: '/', httpOnly: false,
      secure: config.NODE_ENV === 'production', sameSite: 'lax', maxAge: 300 });
    return reply.redirect(config.FRONTEND_ORIGIN);
  });

  app.post('/v1/auth/dev-login', async (request, reply) => {
    if (config.NODE_ENV !== 'development' || !config.DEV_AUTH_ENABLED) {
      throw Object.assign(new Error('Development login disabled'), { statusCode: 404 });
    }
    const body = z.object({ login: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).parse(request.body);
    const user = await pool.query<{ id: string }>(`INSERT INTO users(github_id,login) VALUES ($1,$2)
      ON CONFLICT (github_id) DO UPDATE SET login=EXCLUDED.login RETURNING id`, [`dev:${body.login}`, body.login]);
    const csrf = await createSession(pool, user.rows[0]!.id, reply, config);
    return { user_id: user.rows[0]!.id, csrf_token: csrf };
  });

  app.get('/v1/auth/me', async (request) => {
    const actor = await requireActor(request, pool, 'read');
    if (!actor.userId) throw Object.assign(new Error('Session required'), { statusCode: 403 });
    const csrf = newSecret('csrf');
    await pool.query(`UPDATE sessions SET csrf_hash=$2 WHERE token_hash=$1`,
    [hashSecret(request.cookies.soropulse_session!), hashSecret(csrf)]);
    const profile = await pool.query<{ login: string }>('SELECT login FROM users WHERE id=$1', [actor.userId]);
    return { user_id: actor.userId, login: profile.rows[0]?.login, csrf_token: csrf };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    await requireActor(request, pool, 'read');
    const token = request.cookies.soropulse_session;
    if (token) await pool.query(`UPDATE sessions SET revoked_at=now() WHERE token_hash=$1`, [hashSecret(token)]);
    reply.clearCookie('soropulse_session', { path: '/' });
    return { ok: true };
  });
}
