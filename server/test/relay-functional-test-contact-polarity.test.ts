import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayFunctionalTestCoordinator, type RelayDetectorPort } from '../src/relay-functional-test-coordinator.js';
import { normalizeRelayFunctionalTestConfig } from '../src/relay-functional-test.js';

test('relay functional test follows observed baseline transition when alarm contact polarity differs from config', async () => {
  let internal = { fire: false, fault: false };

  // Field wiring regression: both contacts are high at rest and go low when actuated.
  // The historical alarm mapping still says normal=false, so the old absolute-polarity
  // implementation treated the real alarm actuation as ALARM_RELAY_NOT_ACTUATED.
  const inputs: Record<string, boolean> = { X1: true, X2: true };

  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      internal = { ...state };
      inputs.X1 = state.fire ? false : true;
      inputs.X2 = state.fault ? false : true;
    },
    async reset() {
      internal = { fire: false, fault: false };
      inputs.X1 = true;
      inputs.X2 = true;
    },
    async readLatched() {
      return { ...internal };
    },
  };

  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 200,
    resetTimeoutMs: 200,
    mappings: [{
      detectorIndex: 1,
      alarmInputAddress: 'X1',
      faultInputAddress: 'X2',
      alarmNormalLevel: false,
      faultNormalLevel: true,
    }],
  });

  const coordinator = new RelayFunctionalTestCoordinator(
    detectors,
    { readInputs: () => ({ ...inputs }) },
    config,
  );
  const report = await coordinator.run('field-inverted-alarm-contact');

  assert.equal(report.verdict, 'PASS');
  assert.equal(report.units[0]?.alarm.verdict, 'PASS');
  assert.equal(report.units[0]?.alarm.physicalStateReached, true);
  assert.equal(report.units[0]?.alarm.physicalRecovered, true);
  assert.equal(report.units[0]?.alarm.reasons.includes('ALARM_RELAY_NOT_ACTUATED'), false);
  assert.equal(report.units[0]?.fault.verdict, 'PASS');
});
