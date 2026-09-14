import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DETECTOR_STATUS_LIGHTS,
  indicatorVisionState,
  startsNewRelayStatusSession,
} from '../../components/detector-status-lights-model.ts';
import { DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG } from '../src/relay-functional-test.ts';
import { buildLiveRelayStatusUnits } from '../src/relay-status-lights-service.ts';

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

test('a new relay batch resets latches before the active flag rises', () => {
  assert.equal(
    startsNewRelayStatusSession(
      { active: false, batchId: 'batch-old' },
      { active: false, batchId: 'batch-new' },
    ),
    true,
  );
  assert.equal(
    startsNewRelayStatusSession(
      { active: false, batchId: 'batch-old' },
      { active: false, batchId: 'batch-old' },
    ),
    false,
  );
  assert.equal(
    startsNewRelayStatusSession(
      { active: false, batchId: 'batch-old' },
      { active: true, batchId: null },
    ),
    true,
  );
});

test('live relay lamps reflect physical DIO levels using configured normal polarity', () => {
  const inputs = Object.fromEntries(Array.from({ length: 12 }, (_, offset) => {
    const channel = offset + 1;
    // Default mapping: odd alarm channels are normal-low, even fault channels are normal-high.
    return [`X${channel}`, channel % 2 === 0];
  }));
  inputs.X1 = true; // D1 alarm relay leaves its normal-low state.
  inputs.X4 = false; // D2 fault relay leaves its normal-high state.

  const units = buildLiveRelayStatusUnits(
    [
      { index: 1, online: true, fire: true, fault: false },
      { index: 2, online: true, fire: false, fault: true },
    ],
    inputs,
    DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG,
  );

  assert.equal(units[0]?.relayObserved, true);
  assert.equal(units[0]?.alarmRelay, true);
  assert.equal(units[0]?.faultRelay, false);
  assert.equal(units[0]?.fire, true);
  assert.equal(units[1]?.relayObserved, true);
  assert.equal(units[1]?.alarmRelay, false);
  assert.equal(units[1]?.faultRelay, true);
  assert.equal(units[1]?.fault, true);
});

test('missing DIO data is unknown rather than falsely reported as a normal relay state', () => {
  const units = buildLiveRelayStatusUnits(
    [{ index: 1, online: true }],
    null,
    DEFAULT_RELAY_FUNCTIONAL_TEST_CONFIG,
  );

  assert.equal(units[0]?.relayObserved, false);
  assert.equal(units[0]?.alarmRelay, false);
  assert.equal(units[0]?.faultRelay, false);
});
