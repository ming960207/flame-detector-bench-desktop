import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DETECTOR_STATUS_LIGHTS,
  indicatorVisionState,
} from '../../components/detector-status-lights-model.ts';

test('detector cards render three visual indicator lights before two relay lights', () => {
  assert.deepEqual(
    DETECTOR_STATUS_LIGHTS.map((light) => light.kind),
    ['running-green', 'fire-red', 'fault-yellow', 'alarm-relay', 'fault-relay'],
  );
});

test('indicator vision verdicts map to active, inactive, and unknown states', () => {
  assert.deepEqual(indicatorVisionState('PASS'), { active: true, known: true });
  assert.deepEqual(indicatorVisionState('FAIL'), { active: false, known: true });
  assert.deepEqual(indicatorVisionState('PENDING'), { active: false, known: false });
  assert.deepEqual(indicatorVisionState(undefined), { active: false, known: false });
});
