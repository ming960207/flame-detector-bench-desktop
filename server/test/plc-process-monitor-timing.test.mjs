import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePLCProcessPollInterval } from '../dist/plc-process-monitor.js';

test('PLC process polling stays within the one-second stage-response budget', () => {
  assert.equal(normalizePLCProcessPollInterval(undefined), 200);
  assert.equal(normalizePLCProcessPollInterval(50), 100);
  assert.equal(normalizePLCProcessPollInterval(200), 200);
  assert.equal(normalizePLCProcessPollInterval(900), 900);
  assert.equal(normalizePLCProcessPollInterval(1_500), 900);
});
