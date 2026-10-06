import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { xdr } from '@stellar/stellar-sdk';
import { decodeTicketV1, type RawRpcEvent } from '../src/stellar/decoder.js';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/contract-v1/events-v1.local.json', import.meta.url), 'utf8')) as
  { events: { name: string; contract_event_xdr_hex: string }[] };

function rpcEvent(hex: string): RawRpcEvent {
  const event = xdr.ContractEvent.fromXDR(hex, 'hex');
  return { id: '0021433518894649344-0000000000', type: 'contract',
    contractId: 'CAUKWP7TRYYXAF2C5NDAZEAQVWCUMXX76KBPK64MQBZHU7EUJ5JVPHGG', ledger: 4990360,
    txHash: 'a'.repeat(64), topic: event.body().v0().topics().map((topic) => topic.toXDR('base64')),
    value: event.body().v0().data().toXDR('base64') };
}

test('contract-generated XDR fixtures decode with lossless business identifiers', () => {
  for (const fixture of fixtures.events) {
    const decoded = decodeTicketV1(rpcEvent(fixture.contract_event_xdr_hex));
    assert.equal(decoded.error, null);
    assert.equal(decoded.decoded?.name, fixture.name);
    assert.equal(decoded.decoded?.event_id, '7');
    if (fixture.name === 'ticket') assert.equal(decoded.decoded?.reservation_id, '1');
  }
});

test('unknown schema is retained as decode error', () => {
  const event = rpcEvent(fixtures.events[1]!.contract_event_xdr_hex);
  event.topic[1] = xdr.ScVal.scvU32(2).toXDR('base64');
  const decoded = decodeTicketV1(event);
  assert.equal(decoded.decoded, null);
  assert.match(decoded.error ?? '', /Unsupported/);
});
