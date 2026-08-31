import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayFunctionalTestCoordinator, type RelayDetectorPort } from '../src/relay-functional-test-coordinator.js';
import {
  normalizeRelayFunctionalTestConfig,
  type RelayFeedbackMapping,
} from '../src/relay-functional-test.js';

test('FAST_BATCH validates alarm then reset then fault then reset for all detectors', async () => {
  const internal = new Map<number, { fire: boolean; fault: boolean }>([
    [1, { fire: false, fault: false }],
    [2, { fire: false, fault: false }],
  ]);
  const inputs: Record<string, boolean> = {
    d1Alarm: false, d1Fault: false,
    d2Alarm: false, d2Fault: false,
  };
  const events: string[] = [];
  const mapping: RelayFeedbackMapping[] = [1, 2].map((index) => ({
    detectorIndex: index,
    alarmInputKey: `d${index}Alarm`,
    faultInputKey: `d${index}Fault`,
    alarmNormalLevel: false,
    faultNormalLevel: false,
  }));

  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1, 2],
    async simulate(index, state) {
      events.push(`simulate:${index}:${state.fire ? 'alarm' : 'fault'}`);
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
    mappings: mapping,
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
});

test('relay action fails if target physical contact does not actuate', async () => {
  let internal = { fire: false, fault: false };
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) { internal = { ...state }; },
    async reset() { internal = { fire: false, fault: false }; },
    async readLatched() { return { ...internal }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    stableSamples: 1,
    sampleIntervalMs: 50,
    feedbackTimeoutMs: 200,
    resetTimeoutMs: 200,
    mappings: [{ detectorIndex: 1, alarmInputKey: 'alarm', faultInputKey: 'fault', alarmNormalLevel: false, faultNormalLevel: false }],
  });
  const coordinator = new RelayFunctionalTestCoordinator(detectors, { readInputs: () => ({ alarm: false, fault: false }) }, config);
  const report = await coordinator.run('batch-fail');

  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.units[0]?.alarm.verdict, 'FAIL');
  assert.ok(report.units[0]?.alarm.reasons.includes('ALARM_RELAY_NOT_ACTUATED'));
});
