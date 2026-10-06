import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, retryDelayMs } from '../src/worker/deliver.js';
import { isPublicIp, validateDestination } from '../src/delivery/http.js';

test('retry policy bounds delay and classifies responses', () => {
  assert.equal(retryDelayMs(1, 0), 4000);
  assert.ok(retryDelayMs(8, 1) <= 900000);
  assert.equal(classify({ status: 200, preview: '', retryAfterSeconds: null, failure: null, durationMs: 1 }).success, true);
  assert.equal(classify({ status: 429, preview: '', retryAfterSeconds: 10, failure: null, durationMs: 1 }).retryable, true);
  assert.equal(classify({ status: 400, preview: '', retryAfterSeconds: null, failure: null, durationMs: 1 }).retryable, false);
});

test('endpoint validation rejects non-public DNS answers and redirect ports', async () => {
  assert.equal(isPublicIp('127.0.0.1'), false);
  assert.equal(isPublicIp('192.168.1.2'), false);
  assert.equal(isPublicIp('8.8.8.8'), true);
  const config = { NODE_ENV: 'production' as const, DEV_ALLOWED_ENDPOINTS: '' };
  const localResolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
  await assert.rejects(validateDestination('https://example.com/hook', config, localResolver as never));
  await assert.rejects(validateDestination('https://example.com:8443/hook', config, localResolver as never));
  await assert.rejects(validateDestination('https://user:pass@example.com/hook', config, localResolver as never));
});
