import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DETECTOR_RECONNECT_INITIAL_MS,
  DETECTOR_RECONNECT_MAX_MS,
  DETECTOR_RECONNECT_SLOT_STAGGER_MS,
  detectorReconnectDelayMs,
} from '../src/modbus/flame-detector-reconnect-policy.js';

test('field reconnect delay grows after successive TCP failures, then caps', () => {
  const got = Array.from({ length: 8 }, (_, i) => detectorReconnectDelayMs(i + 1, 1));
  assert.deepEqual(got, [300, 600, 1200, 2400, 4000, 4000, 4000, 4000].map(
    (ms) => ms + DETECTOR_RECONNECT_SLOT_STAGGER_MS,
  ));
  assert.equal(got[0], DETECTOR_RECONNECT_INITIAL_MS + DETECTOR_RECONNECT_SLOT_STAGGER_MS);
  assert.equal(got.at(-1), DETECTOR_RECONNECT_MAX_MS + DETECTOR_RECONNECT_SLOT_STAGGER_MS);
});

test('six detector sockets reconnect with bounded staggering and never synchronize', () => {
  for (let failures = 1; failures <= 50; failures++) {
    const delays = Array.from({ length: 6 }, (_, i) => detectorReconnectDelayMs(failures, i + 1));
    assert.equal(new Set(delays).size, 6);
    assert.ok(delays.every((ms) => ms >= 300 && ms <= 4270));
    assert.ok(delays.every((ms, i) => i === 0 || ms > delays[i - 1]!));
  }
});

test('a 93-second gateway outage cannot trigger the historical 500 connect attempts', () => {
  // Six independently disconnected ports, 750ms connect timeout per attempt.
  const outageMs = 93_000;
  const attempts = Array.from({ length: 6 }, (_, i) => {
    const slot = i + 1;
    let elapsedMs = 0;
    let failures = 0;
    while (elapsedMs < outageMs) {
      failures += 1;
      elapsedMs += 750 + detectorReconnectDelayMs(failures, slot);
    }
    return failures;
  });
  assert.ok(attempts.every((n) => n < 30), `still too many reconnects: ${attempts}`);
  assert.ok(attempts.reduce((a, b) => a + b, 0) < 180);
});

test('invalid reconnect inputs remain bounded', () => {
  assert.equal(detectorReconnectDelayMs(Number.NaN, -1), 300);
  assert.equal(detectorReconnectDelayMs(0, Number.POSITIVE_INFINITY), 300);
  assert.equal(detectorReconnectDelayMs(1_000, 100), 4270);
});
