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
    alarmInputAddress: `X${(index - 1) * 2 + 1}`,
    faultInputAddress: `X${(index - 1) * 2 + 2}`,
    alarmNormalLevel: false,
    faultNormalLevel: false,
  }));
}

test('relay mapping readiness requires both physical DI addresses for every enabled detector', () => {
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mappings: [{
      detectorIndex: 1,
      alarmInputAddress: 'X1', faultInputAddress: '',
      alarmNormalLevel: false, faultNormalLevel: false,
    }],
  });
  assert.deepEqual(relayFunctionalTestMissingMappings(config, [1]), ['D1_FAULT_DI']);
  assert.equal(relayFunctionalTestReady(config, [1]), false);

  const ready = normalizeRelayFunctionalTestConfig({
    ...config,
    dio: { ...config.dio, host: '192.168.1.100' },
    mappings: [{ ...config.mappings[0], faultInputAddress: 'X2' }],
  }, config);
  assert.deepEqual(relayFunctionalTestMissingMappings(ready, [1]), []);
  assert.equal(relayFunctionalTestReady(ready, [1]), true);
});

test('FAST_BATCH runs alarm/reset/fault/reset while keeping each stage parallel', async () => {
  const internal = new Map<number, { fire: boolean; fault: boolean }>([
    [1, { fire: false, fault: false }],
    [2, { fire: false, fault: false }],
  ]);
  const inputs: Record<string, boolean> = { X1: false, X2: false, X3: false, X4: false };
  const events: string[] = [];

  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1, 2],
    async simulate(index, state) {
      const label = state.fire && state.fault ? 'alarm+fault' : state.fire ? 'alarm' : state.fault ? 'fault' : 'normal';
      events.push(`simulate:${index}:${label}`);
      internal.set(index, { ...state });
      inputs[`X${(index - 1) * 2 + 1}`] = state.fire;
      inputs[`X${(index - 1) * 2 + 2}`] = state.fault;
    },
    async reset(index) {
      events.push(`reset:${index}`);
      internal.set(index, { fire: false, fault: false });
      inputs[`X${(index - 1) * 2 + 1}`] = false;
      inputs[`X${(index - 1) * 2 + 2}`] = false;
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
  assert.deepEqual(events.slice(8).sort(), ['reset:1', 'reset:2']);
  assert.equal(events.some((event) => event.includes('alarm+fault')), false);
});

test('DIAGNOSTIC completes one detector before activating the next detector', async () => {
  const internal = new Map<number, { fire: boolean; fault: boolean }>([
    [1, { fire: false, fault: false }],
    [2, { fire: false, fault: false }],
  ]);
  const inputs: Record<string, boolean> = { X1: false, X2: false, X3: false, X4: false };
  const events: string[] = [];
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1, 2],
    async simulate(index, state) {
      events.push(`D${index}:${state.fire ? 'alarm' : state.fault ? 'fault' : 'normal'}`);
      internal.set(index, { ...state });
      inputs[`X${(index - 1) * 2 + 1}`] = state.fire;
      inputs[`X${(index - 1) * 2 + 2}`] = state.fault;
    },
    async reset(index) {
      events.push(`D${index}:reset`);
      internal.set(index, { fire: false, fault: false });
      inputs[`X${(index - 1) * 2 + 1}`] = false;
      inputs[`X${(index - 1) * 2 + 2}`] = false;
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
  assert.deepEqual(events.slice(0, 8), [
    'D1:alarm', 'D1:reset', 'D1:fault', 'D1:reset',
    'D2:alarm', 'D2:reset', 'D2:fault', 'D2:reset',
  ]);
  assert.deepEqual(events.slice(8).sort(), ['D1:reset', 'D2:reset']);
});

test('FAST_BATCH reports alarm contact failure without invalidating a passing fault phase', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      internal = { ...state };
      inputs.X1 = false;
      inputs.X2 = state.fault;
    },
    async reset() {
      internal = { fire: false, fault: false };
      inputs.X1 = false;
      inputs.X2 = false;
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

test('DIO feedback read failures are reported as communication failures', async () => {
  let internal = { fire: false, fault: false };
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) { internal = { ...state }; },
    async reset() { internal = { fire: false, fault: false }; },
    async readLatched() { return { ...internal }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    dio: { host: '192.168.1.100' },
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 200,
    resetTimeoutMs: 200,
    mappings: createMapping([1]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, {
    async readInputs() { throw Object.assign(new Error('socket closed'), { code: 'DIO_CONNECTION_FAILED' }); },
  }, config);
  const report = await coordinator.run('dio-fail');

  assert.equal(report.verdict, 'FAIL');
  assert.ok(report.units[0]?.alarm.reasons.includes('RELAY_FEEDBACK_READ_FAILED:DIO_CONNECTION_FAILED'));
  assert.equal(report.units[0]?.alarm.reasons.includes('ALARM_RELAY_NOT_ACTUATED'), false);
  assert.ok(report.units[0]?.alarm.reasons.some((reason) => reason.startsWith('EMERGENCY_RESET_FEEDBACK_READ_FAILED:')));
});

test('combined alarm+fault simulation is never used by FAST_BATCH production flow', async () => {
  let combinedCalls = 0;
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      if (state.fire && state.fault) combinedCalls += 1;
      internal = { ...state };
      inputs.X1 = state.fire;
      inputs.X2 = state.fault;
    },
    async reset() {
      internal = { fire: false, fault: false };
      inputs.X1 = false;
      inputs.X2 = false;
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

test('emergency cleanup failure is explicit and forces the relay test to fail', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  let resetCalls = 0;
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      internal = { ...state };
      inputs.X1 = state.fire;
      inputs.X2 = state.fault;
    },
    async reset() {
      resetCalls += 1;
      throw new Error('reset transport unavailable');
    },
    async readLatched() { return { ...internal }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 100,
    resetTimeoutMs: 100,
    mappings: createMapping([1]),
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ ...inputs }) }, config);
  const report = await coordinator.run('cleanup-fail');

  assert.equal(report.verdict, 'FAIL');
  assert.ok(resetCalls >= 3);
  assert.ok(report.units[0]?.alarm.reasons.includes('EMERGENCY_RESET_COMMAND_FAILED'));
  assert.ok(report.units[0]?.fault.reasons.includes('EMERGENCY_RESET_COMMAND_FAILED'));
});
