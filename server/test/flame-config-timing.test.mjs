import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFlameConfig } from '../dist/closure/field-status-server.js';

function currentConfig(pollIntervalMs) {
  return {
    mode: 'TCP',
    ip: '127.0.0.1',
    port: 31001,
    units: Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      address: 1,
      enabled: true,
      connMode: 'TCP',
      tcpHost: '127.0.0.1',
      tcpPort: 31001 + index * 1000,
    })),
    pollIntervalMs,
  };
}

test('migrates legacy slow waveform polling to a sub-second interval', () => {
  const legacy = currentConfig(2_000);

  assert.equal(normalizeFlameConfig({ pollIntervalMs: 2_000 }, legacy).pollIntervalMs, 250);
  assert.equal(normalizeFlameConfig({ pollIntervalMs: 850 }, legacy).pollIntervalMs, 850);
  assert.ok(normalizeFlameConfig({ pollIntervalMs: 950 }, legacy).pollIntervalMs <= 900);
});

test('normalizes and preserves the configured default waveform send mode', () => {
  const current = currentConfig(250);

  assert.equal(normalizeFlameConfig({ waveformSendMode: 'filtered' }, current).waveformSendMode, 'filtered');
  assert.equal(normalizeFlameConfig({}, current).waveformSendMode, 'active');
});
