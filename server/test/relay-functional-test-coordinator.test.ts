import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayFunctionalTestCoordinator, type RelayDetectorPort } from '../src/relay-functional-test-coordinator.js';
import {
  normalizeRelayFunctionalTestConfig,
  type RelayFeedbackMapping,
} from '../src/relay-functional-test.js';

function createMapping(indexes: number[]): RelayFeedbackMapping[] {
  return indexes.map((index) => ({
    detectorIndex: index,
    alarmInputKey: `d${index}Alarm`,
    faultInputKey: `d${index}Fault`,
    alarmNormalLevel: false,
    faultNormalLevel: false,
  }));
}

test('FAST_BATCH triggers alarm+fault together and resets only once per detector', async () => {
  const internal = new Map<number, { fire: boolean; fault: boolean }>([
    [1, { fire: false, fault: false }],
    [2, { fire: false, fault: false }],
  ]);
  const inputs: Record<string, boolean> = {
    d1Alarm: false, d1Fault: false,
    d2Alarm: false, d2Fault: false,
  };
  const events: string[] = [];

  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1, 2],
    async simulate(index, state) {
      const label = state.fire && state.fault ? 'alarm+fault' : state.fire ? 'alarm' : state.fault ? 'fault' : 'normal';
      events.push(`simulate:${index}:${label}`);
      internal.set(index, { ...state });
      inputs[`d${index}Alarm`] = state.fire;
      inputs[`d${index}Fault`] = state.fault;
    },
    async reset(index) {
      events.push(`reset:${index}`);
      internal.set(index, { fire: false, fault: false });
      inputs[`d${index}Alarm`] = false;
      inputs[`d${index}Fault`] = false;
    },
    async readLatched(index) {
      return { ...(internal.get(index) ?? { fire: false, fault: false }) };
    },
  };

  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 500,
    resetTimeoutMs: 500,
    mappings: createMapping([1, 2]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('batch-1');

  assert.equal(report.verdict, 'PASS');
  assert.equal(report.units.length, 2);
  assert.ok(report.units.every((unit) => unit.alarm.verdict === 'PASS' && unit.fault.verdict === 'PASS'));
  assert.deepEqual(events.slice(0, 2).sort(), ['simulate:1:alarm+fault', 'simulate:2:alarm+fault']);
  assert.deepEqual(events.slice(2, 4).sort(), ['reset:1', 'reset:2']);
  assert.equal(events.length, 4);
});

test('DIAGNOSTIC keeps alarm and fault as separate simulations', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { d1Alarm: false, d1Fault: false };
  const events: string[] = [];
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      events.push(state.fire ? 'alarm' : state.fault ? 'fault' : 'normal');
      internal = { ...state };
      inputs.d1Alarm = state.fire;
      inputs.d1Fault = state.fault;
    },
    async reset() {
      events.push('reset');
      internal = { fire: false, fault: false };
      inputs.d1Alarm = false;
      inputs.d1Fault = false;
    },
    async readLatched() { return { ...internal }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'DIAGNOSTIC',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 500,
    resetTimeoutMs: 500,
    mappings: createMapping([1]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('diagnostic-1');

  assert.equal(report.verdict, 'PASS');
  assert.deepEqual(events, ['alarm', 'reset', 'fault', 'reset']);
});

test('FAST_BATCH reports the specific relay that does not actuate', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { d1Alarm: false, d1Fault: false };
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      internal = { ...state };
      inputs.d1Alarm = false; // 模拟 Alarm 实体触点未动作
      inputs.d1Fault = state.fault;
    },
    async reset() {
      internal = { fire: false, fault: false };
      inputs.d1Alarm = false;
      inputs.d1Fault = false;
    },
    async readLatched() { return { ...internal }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 200,
    resetTimeoutMs: 200,
    mappings: createMapping([1]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('batch-fail');

  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.units[0]?.alarm.verdict, 'FAIL');
  assert.equal(report.units[0]?.fault.verdict, 'PASS');
  assert.ok(report.units[0]?.alarm.reasons.includes('ALARM_RELAY_NOT_ACTUATED'));
});
