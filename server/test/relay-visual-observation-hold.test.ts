import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RELAY_VISUAL_SETTLE_BEFORE_VERIFY_MS,
  RELAY_VISUAL_OBSERVATION_HOLD_MS,
  RelayFunctionalTestCoordinator,
  type RelayDetectorPort,
} from '../src/relay-functional-test-coordinator.js';
import { normalizeRelayFunctionalTestConfig, type RelayFunctionalTestPhase } from '../src/relay-functional-test.js';

test('alarm and fault verify phases remain observable before reset', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  const phaseAt = new Map<RelayFunctionalTestPhase, number>();
  let alarmCommandAt = 0;

  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      if (state.fire && !state.fault) alarmCommandAt = Date.now();
      internal = { ...state };
      inputs.X1 = state.fire;
      inputs.X2 = state.fault;
    },
    async reset() {
      internal = { fire: false, fault: false };
      inputs.X1 = false;
      inputs.X2 = false;
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
    feedbackTimeoutMs: 500,
    resetTimeoutMs: 500,
    mappings: [{
      detectorIndex: 1,
      alarmInputAddress: 'X1',
      faultInputAddress: 'X2',
      alarmNormalLevel: false,
      faultNormalLevel: false,
    }],
  });

  const coordinator = new RelayFunctionalTestCoordinator(
    detectors,
    { readInputs: () => ({ ...inputs }) },
    config,
    (event) => phaseAt.set(event.phase, Date.now()),
  );

  const report = await coordinator.run('visual-hold');
  assert.equal(report.verdict, 'PASS');

  const alarmVerify = phaseAt.get('ALARM_VERIFY');
  const alarmReset = phaseAt.get('ALARM_RESET');
  const faultVerify = phaseAt.get('FAULT_VERIFY');
  const faultReset = phaseAt.get('FAULT_RESET');
  assert.ok(alarmVerify && alarmReset && faultVerify && faultReset);
  assert.ok(alarmVerify - alarmCommandAt >= RELAY_VISUAL_SETTLE_BEFORE_VERIFY_MS - 100);

  // Allow a small scheduler tolerance while still proving a real observation window exists.
  assert.ok(alarmReset - alarmVerify >= RELAY_VISUAL_OBSERVATION_HOLD_MS - 100);
  assert.ok(faultReset - faultVerify >= RELAY_VISUAL_OBSERVATION_HOLD_MS - 100);
});
