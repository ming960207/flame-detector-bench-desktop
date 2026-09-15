import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RelayFunctionalTestCoordinator,
  type RelayDetectorPort,
} from '../src/relay-functional-test-coordinator.js';
import { normalizeRelayFunctionalTestConfig, type RelayFunctionalTestPhase } from '../src/relay-functional-test.js';

test('alarm and fault simulation sends a short command burst without visual wait', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  const phaseAt = new Map<RelayFunctionalTestPhase, number>();
  const simulationCount = { alarm: 0, fault: 0 };
  let alarmCommandAt = 0;
  let faultCommandAt = 0;

  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      const at = Date.now();
      if (state.fire && !state.fault) {
        simulationCount.alarm += 1;
        alarmCommandAt ||= at;
      }
      if (state.fault && !state.fire) {
        simulationCount.fault += 1;
        faultCommandAt ||= at;
      }
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
  assert.equal(simulationCount.alarm, 3);
  assert.equal(simulationCount.fault, 3);
  assert.ok(alarmVerify - alarmCommandAt < 500, 'alarm simulation should enter verification promptly');
  assert.ok(faultVerify - faultCommandAt < 500, 'fault simulation should enter verification promptly');
  assert.ok(alarmReset - alarmVerify < 1000, 'alarm verification should not add a visual hold');
  assert.ok(faultReset - faultVerify < 1000, 'fault verification should not add a visual hold');
});
