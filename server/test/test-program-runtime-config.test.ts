import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TEST_PROGRAM_OBSERVER_RUNTIME_CONFIG,
  normalizeTestProgramObserverRuntimeConfig,
} from '../src/test-program/test-program-plan-config.js';

test('test observer defaults keep websocket realtime path backed by 1s polling', () => {
  const config = normalizeTestProgramObserverRuntimeConfig(undefined);
  assert.deepEqual(config, DEFAULT_TEST_PROGRAM_OBSERVER_RUNTIME_CONFIG);
  assert.equal(config.pollIntervalMs, 1_000);
  assert.equal(config.reconnectIntervalMs, 1_000);
  assert.equal(config.completionFlushDelayMs, 350);
  assert.equal(config.staleAfterMs, 5_000);
});

test('test observer runtime config is bounded and stale threshold covers at least two polls', () => {
  const config = normalizeTestProgramObserverRuntimeConfig({
    pollIntervalMs: 4_000,
    reconnectIntervalMs: 10,
    completionFlushDelayMs: 999_999,
    staleAfterMs: 1_000,
  });
  assert.equal(config.pollIntervalMs, 4_000);
  assert.equal(config.reconnectIntervalMs, 250);
  assert.equal(config.completionFlushDelayMs, 5_000);
  assert.equal(config.staleAfterMs, 8_250);
});

test('invalid observer runtime values preserve the previous valid configuration', () => {
  const previous = {
    pollIntervalMs: 750,
    reconnectIntervalMs: 1_500,
    completionFlushDelayMs: 500,
    staleAfterMs: 4_000,
  };
  const config = normalizeTestProgramObserverRuntimeConfig({
    pollIntervalMs: 'bad',
    reconnectIntervalMs: null,
    completionFlushDelayMs: undefined,
    staleAfterMs: Number.NaN,
  }, previous);
  assert.deepEqual(config, previous);
});
