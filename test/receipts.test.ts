import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processingState } from '../src/api/receipts.js';

test('processing state does not regress after reported success', () => {
  assert.equal(processingState([]), 'awaiting_receipt');
  assert.equal(processingState([{ processing_run_id: 'run-1', sequence: 1, status: 'processing' }]), 'reported_processing');
  assert.equal(processingState([
    { processing_run_id: 'run-1', sequence: 1, status: 'succeeded' },
    { processing_run_id: 'run-2', sequence: 2, status: 'failed' },
  ]), 'reported_succeeded');
  assert.equal(processingState([
    { processing_run_id: 'run-1', sequence: 1, status: 'succeeded' },
    { processing_run_id: 'run-1', sequence: 2, status: 'failed' },
  ]), 'conflict');
});
