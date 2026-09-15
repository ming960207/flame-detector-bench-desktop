import assert from 'node:assert/strict';
import test from 'node:test';
import { createLatestValueScheduler, waveformKeys } from '../../utils/waveform.js';
import type { FlameDetectorUnitState, FlameSample } from '../src/types.js';

test('latest value scheduler publishes only the newest pending detector state', () => {
  const callbacks: Array<(() => void) | null> = [];
  const published: string[] = [];
  const scheduler = createLatestValueScheduler<string>(
    (callback) => {
      callbacks.push(callback);
      return callbacks.length - 1;
    },
    (handle) => { callbacks[Number(handle)] = null; },
    (value) => published.push(value),
  );

  scheduler.push('state-1');
  scheduler.push('state-2');
  scheduler.push('state-3');

  assert.equal(callbacks.length, 1);
  callbacks[0]?.();
  assert.deepEqual(published, ['state-3']);

  scheduler.cancel();
});

test('received probe count limits waveform channels even if a frame carries P4 data', () => {
  const unit = { probeCount: 2, probe4: 23_013 } as FlameDetectorUnitState;
  const samples: FlameSample[] = [{ probe1: 8, probe2: 232, probe3: 152, probe4: 23_013 }];

  assert.deepEqual(waveformKeys(samples, unit), ['probe1', 'probe2']);
});
