import assert from 'node:assert/strict';
import test from 'node:test';
import { waveformKeys } from '../../utils/waveform.js';
import type { FlameDetectorUnitState, FlameSample } from '../src/types.js';

test('received probe count limits waveform channels even if a frame carries P4 data', () => {
  const unit = { probeCount: 2, probe4: 23_013 } as FlameDetectorUnitState;
  const samples: FlameSample[] = [{ probe1: 8, probe2: 232, probe3: 152, probe4: 23_013 }];

  assert.deepEqual(waveformKeys(samples, unit), ['probe1', 'probe2']);
});
