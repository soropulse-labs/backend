import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SCHEMA_VERSION = 1;
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface WebhookPayload {
  schema_version: 1;
  event_id: string;
  delivery_id: string;
  network: string;
  epoch: string;
  contract_id: string;
  transaction_hash: string;
  ledger: number;
  ledger_closed_at: string | null;
  raw: { topics_xdr: string[]; value_xdr: string };
  decoded: Record<string, unknown> | null;
  replay: { plan_id: string } | null;
}

export function signingInput(timestamp: number, deliveryId: string, body: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`v1.${timestamp}.${deliveryId}.`, 'ascii'), Buffer.from(body)]);
}

export function signWebhook(secret: string, timestamp: number, deliveryId: string, body: Uint8Array): string {
  return `v1=${createHmac('sha256', secret).update(signingInput(timestamp, deliveryId, body)).digest('hex')}`;
}

export function verifyWebhook(input: {
  secret: string; timestamp: string; deliveryId: string; signature: string;
  body: Uint8Array; now?: number; bodyDeliveryId?: string;
}): boolean {
  const { secret, timestamp, deliveryId, signature, body, bodyDeliveryId } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!/^\d{10}$/.test(timestamp) || !/^[0-9a-f-]{36}$/i.test(deliveryId)) return false;
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  if (bodyDeliveryId !== undefined && bodyDeliveryId !== deliveryId) return false;
  if (!/^v1=[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signWebhook(secret, Number(timestamp), deliveryId, body).slice(3), 'hex');
  const supplied = Buffer.from(signature.slice(3), 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function webhookHeaders(secret: string, keyId: string, deliveryId: string, body: Uint8Array, now = Date.now()) {
  const timestamp = Math.floor(now / 1000);
  return {
    'content-type': 'application/json',
    'soropulse-id': deliveryId,
    'soropulse-timestamp': String(timestamp),
    'soropulse-key-id': keyId,
    'soropulse-signature': signWebhook(secret, timestamp, deliveryId, body),
  };
}
