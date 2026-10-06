import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { xdr } from '@stellar/stellar-sdk';
import pg from 'pg';
import { decodeTicketV1, type RawRpcEvent } from '../src/stellar/decoder.js';
import { webhookHeaders } from '../src/protocol/webhook.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests');
const fixture = JSON.parse(readFileSync(new URL('../fixtures/contract-v1/events-v1.local.json', import.meta.url), 'utf8')) as
  { events: { name: string; contract_event_xdr_hex: string }[] };

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test('ticket consumer survives duplicate delivery with one business ticket', async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const dbName = `sp_consumer_test_${randomUUID().replaceAll('-', '')}`;
  const consumerUrl = new URL(databaseUrl);
  consumerUrl.pathname = `/${dbName}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new pg.Pool({ connectionString: consumerUrl.toString() });
  const port = await unusedPort();
  const secret = 'consumer-test-signing-secret-at-least-32-bytes';
  const keyId = randomUUID();
  const consumerId = randomUUID();
  const contractId = 'CAUKWP7TRYYXAF2C5NDAZEAQVWCUMXX76KBPK64MQBZHU7EUJ5JVPHGG';
  const epoch = `integration-${randomUUID()}`;
  let output = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'examples/ticket-consumer/main.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      CONSUMER_DATABASE_URL: consumerUrl.toString(), CONSUMER_ID: consumerId,
      CONSUMER_RECEIPT_CREDENTIAL: `spr_${'a'.repeat(40)}`,
      CONSUMER_SIGNING_KEY_ID: keyId, CONSUMER_SIGNING_SECRET: secret,
      CONSUMER_CONTRACT_ID: contractId, NETWORK_EPOCH: epoch,
      API_URL: 'http://127.0.0.1:1', DEMO_API_KEY: 'b'.repeat(40),
      CONSUMER_HOST: '127.0.0.1', CONSUMER_PORT: String(port),
    },
  });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Consumer exited early: ${output.slice(-500)}`);
      try { const response = await fetch(`http://127.0.0.1:${port}/health/live`); if (response.ok) { ready = true; break; } }
      catch { /* process is starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, `Consumer did not start: ${output.slice(-500)}`);
    const contractEvent = xdr.ContractEvent.fromXDR(fixture.events.find((item) => item.name === 'ticket')!.contract_event_xdr_hex, 'hex');
    const raw: RawRpcEvent = { id: '0021433518894649344-0000000000', type: 'contract', contractId,
      ledger: 4990360, txHash: 'a'.repeat(64), topic: contractEvent.body().v0().topics().map((value) => value.toXDR('base64')),
      value: contractEvent.body().v0().data().toXDR('base64') };
    const decoded = decodeTicketV1(raw);
    assert.equal(decoded.error, null);
    for (let i = 0; i < 2; i++) {
      const deliveryId = randomUUID();
      const body = Buffer.from(JSON.stringify({ schema_version: 1, event_id: raw.id, delivery_id: deliveryId,
        network: 'testnet', epoch, contract_id: contractId, transaction_hash: raw.txHash, ledger: raw.ledger,
        ledger_closed_at: null, raw: { topics_xdr: raw.topic, value_xdr: raw.value }, decoded: decoded.decoded, replay: null }));
      const response = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST',
        headers: webhookHeaders(secret, keyId, deliveryId, body), body });
      assert.equal(response.status, 202, await response.text());
    }
    let ticketCount = 0, receiptCount = 0;
    for (let i = 0; i < 100; i++) {
      ticketCount = Number((await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM tickets')).rows[0]!.count);
      receiptCount = Number((await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM receipt_outbox')).rows[0]!.count);
      if (ticketCount === 1 && receiptCount === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ticketCount, 1);
    assert.equal(receiptCount, 2);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  }
});
