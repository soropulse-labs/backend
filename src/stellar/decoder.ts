import { scValToNative, xdr } from '@stellar/stellar-sdk';

export interface RawRpcEvent {
  id: string; type: string; contractId: string; ledger: number; ledgerClosedAt?: string;
  txHash: string; topic: string[]; value: string; inSuccessfulContractCall?: boolean;
}

export interface DecodeResult { decoder: string | null; decoded: Record<string, unknown> | null; error: string | null }

function native(xdrBase64: string): unknown { return scValToNative(xdr.ScVal.fromXDR(xdrBase64, 'base64')); }
function decimal(value: unknown): string {
  if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isSafeInteger(value))) throw new Error('Expected lossless integer');
  return String(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected event data map');
  return value as Record<string, unknown>;
}

export function decodeTicketV1(event: RawRpcEvent): DecodeResult {
  try {
    if (event.topic.length < 3 || event.topic.length > 4) throw new Error('Invalid topic count');
    const topics = event.topic.map(native);
    const name = topics[0];
    if (name !== 'ticket' && name !== 'created' && name !== 'closed') throw new Error('Unknown ticket event name');
    if (topics[1] !== 1) throw new Error('Unsupported ticket schema version');
    const data = record(native(event.value));
    const eventId = decimal(topics[2]);
    if (name === 'ticket') {
      if (topics.length !== 4 || typeof data.attendee !== 'string' || !Number.isInteger(data.reserved_after)) throw new Error('Invalid ticket payload');
      return { decoder: 'soropulse.ticket.v1', decoded: { name, schema_version: 1, event_id: eventId, reservation_id: decimal(topics[3]), attendee: data.attendee, reserved_after: data.reserved_after }, error: null };
    }
    if (topics.length !== 3) throw new Error('Invalid topic count');
    if (name === 'created') {
      if (typeof data.title !== 'string' || !Number.isInteger(data.capacity)) throw new Error('Invalid created payload');
      return { decoder: 'soropulse.ticket.v1', decoded: { name, schema_version: 1, event_id: eventId, title: data.title, capacity: data.capacity }, error: null };
    }
    if (!Number.isInteger(data.reserved)) throw new Error('Invalid closed payload');
    return { decoder: 'soropulse.ticket.v1', decoded: { name, schema_version: 1, event_id: eventId, reserved: data.reserved }, error: null };
  } catch (error) {
    return { decoder: 'soropulse.ticket.v1', decoded: null, error: error instanceof Error ? error.message : 'Decode failed' };
  }
}

export function decodeEvent(event: RawRpcEvent, decoder: string | null): DecodeResult {
  if (decoder === 'soropulse.ticket.v1') return decodeTicketV1(event);
  return { decoder, decoded: null, error: decoder ? 'Unsupported decoder' : null };
}
