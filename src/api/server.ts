import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import type pg from 'pg';
import { ZodError } from 'zod';
import type { Config } from '../config.js';
import { registerAuthRoutes } from './auth.js';
import { registerControlRoutes } from './control.js';
import { registerReceiptRoutes } from './receipts.js';
import { registerTraceRoutes } from './trace.js';
import { registerReplayRoutes } from './replay.js';

export async function createApp(pool: pg.Pool, config: Config) {
  const app = Fastify({
    logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-csrf-token', 'res.headers.set-cookie'] },
    bodyLimit: 64 * 1024, requestTimeout: 15000,
  });
  await app.register(cookie);
  await app.register(cors, { origin: config.FRONTEND_ORIGIN, credentials: true, methods: ['GET', 'POST', 'OPTIONS'] });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  await app.register(swagger, { openapi: { info: { title: 'SoroPulse Backend API', version: '0.1.0' },
    servers: [{ url: config.PUBLIC_BASE_URL }] } });

  app.setErrorHandler((error, request, reply) => {
    const err = error instanceof Error ? error : new Error('Unknown error');
    const status = error instanceof ZodError ? 400 :
      'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode :
      'code' in err && err.code === '23505' ? 409 : 500;
    if (status >= 500) request.log.error({ err, requestId: request.id }, 'request failed');
    reply.code(status).send({ error: { code: status === 500 ? 'internal_error' : error instanceof ZodError ? 'validation_error' : 'request_error',
      message: status === 500 ? 'Internal server error' : err.message, request_id: request.id } });
  });

  app.get('/v1/health/live', async () => ({ status: 'ok' }));
  app.get('/v1/health/ready', async () => {
    await pool.query('SELECT 1');
    return { status: 'ready' };
  });
  registerAuthRoutes(app, pool, config);
  registerControlRoutes(app, pool, config);
  registerReceiptRoutes(app, pool);
  registerTraceRoutes(app, pool);
  registerReplayRoutes(app, pool);
  await app.ready();
  return app;
}
