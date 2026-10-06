import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signWebhook, verifyWebhook } from '../src/protocol/webhook.js';

const deliveryId = '11111111-1111-4111-8111-111111111111';
const body = Buffer.from('{"delivery_id":"11111111-1111-4111-8111-111111111111"}');
const expected = 'v1=38aefe3adaed1887508be8be81fb4ce77fd2244bb09c6fbc67336a4136a23be8';

test('HMAC golden vector signs exact transmitted bytes', () => {
  assert.equal(signWebhook('test-secret', 1700000000, deliveryId, body), expected);
  assert.equal(verifyWebhook({ secret: 'test-secret', timestamp: '1700000000', deliveryId, signature: expected, body,
    bodyDeliveryId: deliveryId, now: 1700000000 }), true);
  assert.equal(verifyWebhook({ secret: 'test-secret', timestamp: '1700000000', deliveryId, signature: expected,
    body: Buffer.from(' {"delivery_id":"11111111-1111-4111-8111-111111111111"}'), now: 1700000000 }), false);
  assert.equal(verifyWebhook({ secret: 'test-secret', timestamp: '1700000000', deliveryId, signature: expected, body,
    bodyDeliveryId: '22222222-2222-4222-8222-222222222222', now: 1700000000 }), false);
  assert.equal(verifyWebhook({ secret: 'test-secret', timestamp: '1700000000', deliveryId, signature: expected, body,
    now: 1700000301 }), false);
});
