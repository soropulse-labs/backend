import assert from 'node:assert/strict';
import { test } from 'node:test';
import { xdr } from '@stellar/stellar-sdk';
import { StellarRpc } from '../src/stellar/rpc.js';

test('first-topic filter includes wildcard for remaining Soroban topics', async () => {
  const original = globalThis.fetch;
  let request: unknown;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1,
      result: { events: [], latestLedger: 10, oldestLedger: 1 } }), { status: 200 });
  };
  try {
    const topic = xdr.ScVal.scvSymbol('ticket').toXDR('base64');
    await new StellarRpc('https://example.com').getEvents({ contractId: 'CEXAMPLE', topic0Xdr: topic,
      startLedger: 2, endLedger: 3 });
    const params = (request as { params: { filters: { topics: string[][] }[] } }).params;
    assert.deepEqual(params.filters[0]?.topics, [[topic, '**']]);
  } finally { globalThis.fetch = original; }
});
