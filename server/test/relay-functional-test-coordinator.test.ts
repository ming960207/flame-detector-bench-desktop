import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayFunctionalTestCoordinator, type RelayDetectorPort } from '../src/relay-functional-test-coordinator.js';
import {
  normalizeRelayFunctionalTestConfig,
  relayFunctionalTestMissingMappings,
  relayFunctionalTestReady,
  type RelayFeedbackMapping,
} from '../src/relay-functional-test.js';

function createMapping(indexes: number[]): RelayFeedbackMapping[] {
  return indexes.map((index) => ({
    detectorIndex: index,
    alarmInputKey: `d${index}Alarm`,
    faultInputKey: `d${index}Fault`,
    alarmInputAddress: `I2.${(index - 1) * 2}`,
    faultInputAddress: `I2.${(index - 1) * 2 + 1}`,
    alarmNormalLevel: false,
    faultNormalLevel: false,
  }));
}

test('relay mapping readiness requires both physical DI addresses for every enabled detector', () => {
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mappings: [{
      detectorIndex: 1,
      alarmInputKey: 'd1Alarm', faultInputKey: 'd1Fault',
      alarmInputAddress: 'I2.0', faultInputAddress: '',
      alarmNormalLevel: false, faultNormalLevel: false,
    }],
  });
  assert.deepEqual(relayFunctionalTestMissingMappings(config, [1]), ['D1_FAULT_DI']);
  assert.equal(relayFunctionalTestReady(config, [1]), false);

  const ready = normalizeRelayFunctionalTestConfig({
    ...config,
    mappings: [{ ...config.mappings[0], faultInputAddress: 'I2.1' }],
  }, config);
  assert.deepEqual(relayFunctionalTestMissingMappings(ready, [1]), []);
  assert.equal(relayFunctionalTestReady(ready, [1]), true);
});

test('FAST_BATCH runs alarm/reset/fault/reset while keeping each stage parallel', async () => {
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

  assert.deepEqual(events.slice(0, 2).sort(), ['simulate:1:alarm', 'simulate:2:alarm']);
  assert.deepEqual(events.slice(2, 4).sort(), ['reset:1', 'reset:2']);
  assert.deepEqual(events.slice(4, 6).sort(), ['simulate:1:fault', 'simulate:2:fault']);
  assert.deepEqual(events.slice(6, 8).sort(), ['reset:1', 'reset:2']);
  assert.equal(events.some((event) => event.includes('alarm+fault')), false);
});

test('DIAGNOSTIC completes one detector before activating the next detector', async () => {
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
      events.push(`D${index}:${state.fire ? 'alarm' : state.fault ? 'fault' : 'normal'}`);
      internal.set(index, { ...state });
      inputs[`d${index}Alarm`] = state.fire;
      inputs[`d${index}Fault`] = state.fault;
    },
    async reset(index) {
      events.push(`D${index}:reset`);
      internal.set(index, { fire: false, fault: false });
      inputs[`d${index}Alarm`] = false;
      inputs[`d${index}Fault`] = false;
    },
    async readLatched(index) { return { ...(internal.get(index) ?? { fire: false, fault: false }) }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'DIAGNOSTIC',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 500,
    resetTimeoutMs: 500,
    mappings: createMapping([1, 2]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('diagnostic-1');

  assert.equal(report.verdict, 'PASS');
  assert.deepEqual(events, [
    'D1:alarm', 'D1:reset', 'D1:fault', 'D1:reset',
    'D2:alarm', 'D2:reset', 'D2:fault', 'D2:reset',
  ]);
});

test('FAST_BATCH reports alarm contact failure without invalidating a passing fault phase', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { d1Alarm: false, d1Fault: false };
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      internal = { ...state };
      inputs.d1Alarm = false; // 火警阶段模拟 Alarm 实体触点不动作
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

test('combined alarm+fault simulation is never used by FAST_BATCH production flow', async () => {
  let combinedCalls = 0;
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { d1Alarm: false, d1Fault: false };
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      if (state.fire && state.fault) combinedCalls += 1;
      internal = { ...state };
      inputs.d1Alarm = state.fire;
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
    feedbackTimeoutMs: 500,
    resetTimeoutMs: 500,
    mappings: createMapping([1]),
  });

  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('no-combined');

  assert.equal(report.verdict, 'PASS');
  assert.equal(combinedCalls, 0);
});
