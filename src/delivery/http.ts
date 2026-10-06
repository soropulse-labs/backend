import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Config } from '../config.js';

const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [range, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked4.addSubnet(range, prefix, 'ipv4');
for (const [range, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['100::', 64],
  ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked6.addSubnet(range, prefix, 'ipv6');

export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  if (family === 4) return !blocked4.check(address, 'ipv4');
  const normalized = address.toLowerCase();
  if (!normalized.startsWith('2') && !normalized.startsWith('3')) return false;
  return !blocked6.check(address, 'ipv6');
}

export async function validateDestination(raw: string, config: Pick<Config, 'NODE_ENV' | 'DEV_ALLOWED_ENDPOINTS'>,
  resolver: typeof lookup = lookup): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  const url = new URL(raw);
  if (url.username || url.password || url.hash) throw new Error('Endpoint URL contains credentials or fragment');
  const devAllowed = config.NODE_ENV !== 'production' && config.DEV_ALLOWED_ENDPOINTS.split(',').map((v) => v.trim()).includes(url.href);
  if (!devAllowed && (url.protocol !== 'https:' || (url.port && url.port !== '443'))) throw new Error('Endpoint must use HTTPS on port 443');
  if (devAllowed && url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid development URL');
  if (!devAllowed && url.hostname === 'localhost') throw new Error('Loopback endpoint forbidden');
  const answers = await resolver(url.hostname, { all: true, verbatim: true });
  if (!Array.isArray(answers) || answers.length === 0) throw new Error('Endpoint DNS has no answers');
  if (!devAllowed && answers.some(({ address }) => !isPublicIp(address))) throw new Error('Endpoint DNS contains non-public address');
  if (devAllowed && answers.some(({ address }) => !isIP(address))) throw new Error('Invalid development DNS answer');
  const selected = answers[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) throw new Error('Invalid DNS answer');
  return { url, address: selected.address, family: selected.family };
}

export interface HttpResult { status: number | null; preview: string; retryAfterSeconds: number | null; failure: string | null; durationMs: number }

export async function postWebhook(rawUrl: string, body: Buffer, headers: Record<string, string>, config: Pick<Config, 'NODE_ENV' | 'DEV_ALLOWED_ENDPOINTS'>,
  timeoutMs = 10000): Promise<HttpResult> {
  const started = Date.now();
  const { url, address, family } = await validateDestination(rawUrl, config);
  return new Promise<HttpResult>((resolve) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST', headers: { ...headers, 'content-length': String(body.length) }, timeout: timeoutMs,
      maxHeaderSize: 8192, agent: false,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      ...(url.protocol === 'https:' ? { servername: url.hostname, rejectUnauthorized: true } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (part: Buffer) => {
        size += part.length;
        if (size <= 1024) chunks.push(part);
        else res.destroy();
      });
      res.on('end', () => {
        const retryHeader = res.headers['retry-after'];
        const parsed = typeof retryHeader === 'string' && /^\d+$/.test(retryHeader) ? Math.min(Number(retryHeader), 900) : null;
        resolve({ status: res.statusCode ?? null, preview: Buffer.concat(chunks).toString('utf8').replace(/[\u0000-\u001f]/g, ' ').slice(0, 1024),
          retryAfterSeconds: parsed, failure: null, durationMs: Date.now() - started });
      });
      res.on('error', (error) => resolve({ status: res.statusCode ?? null, preview: '', retryAfterSeconds: null,
        failure: error.message.slice(0, 100), durationMs: Date.now() - started }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({ status: null, preview: '', retryAfterSeconds: null,
      failure: error.message.slice(0, 100), durationMs: Date.now() - started }));
    req.end(body);
  });
}
