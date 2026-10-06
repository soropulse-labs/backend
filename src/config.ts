import { z } from 'zod';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url().startsWith('postgresql://'),
  STELLAR_RPC_URL: z.url().startsWith('https://'),
  NETWORK_PASSPHRASE: z.string().min(1),
  NETWORK_EPOCH: z.string().min(1).max(100),
  START_LEDGER: z.coerce.number().int().positive(),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  PUBLIC_BASE_URL: z.url(),
  FRONTEND_ORIGIN: z.url(),
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
  SESSION_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
  DEV_AUTH_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  DEV_ALLOWED_ENDPOINTS: z.string().default(''),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid environment configuration: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const config = result.data;
  if (config.NODE_ENV === 'production' && (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET)) {
    throw new Error('GitHub OAuth credentials are required in production');
  }
  if (config.NODE_ENV === 'production' && config.DEV_AUTH_ENABLED) throw new Error('Development auth is forbidden in production');
  if (config.NODE_ENV === 'production' && new URL(config.PUBLIC_BASE_URL).protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must use HTTPS in production');
  return config;
}
