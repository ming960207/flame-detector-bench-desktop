import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayFunctionalTestCoordinator, type RelayDetectorPort } from '../src/relay-functional-test-coordinator.js';
import { normalizeRelayFunctionalTestConfig } from '../src/relay-functional-test.js';

test('each relay verdict follows only its matching physical DIO feedback', async () => {
  let internal = { fire: false, fault: false };
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  let lastKind: 'alarm' | 'fault' | null = null;
  let resetCount = 0;

  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      if (state.fire) {
        lastKind = 'alarm';
        // Deliberately make internal/cross-channel diagnostics disagree with the
        // physical alarm feedback. Only X1 is authoritative for the alarm relay.
        internal = { fire: false, fault: true };
        inputs.X1 = true;
        inputs.X2 = true;
      } else if (state.fault) {
        lastKind = 'fault';
        internal = { fire: true, fault: false };
        inputs.X1 = true;
        inputs.X2 = true;
      }
    },
    async reset() {
      resetCount += 1;
      internal = { fire: true, fault: true };
      if (resetCount === 1 && lastKind === 'alarm') {
        inputs.X1 = false; // alarm feedback recovered
        inputs.X2 = true;  // unrelated fault feedback remains active
      } else if (resetCount === 2 && lastKind === 'fault') {
        inputs.X1 = true;  // unrelated alarm feedback remains active
        inputs.X2 = false; // fault feedback recovered
      } else {
        // final emergency cleanup
        inputs.X1 = false;
        inputs.X2 = false;
      }
    },
    async readLatched() {
      return { ...internal };
    },
  };

  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    stableSamples: 1,
    sampleIntervalMs: 20,
    feedbackTimeoutMs: 200,
    resetTimeoutMs: 200,
    mappings: [{
      detectorIndex: 1,
      alarmInputAddress: 'X1',
      faultInputAddress: 'X2',
      alarmNormalLevel: false,
      faultNormalLevel: false,
    }],
  });

  const report = await new RelayFunctionalTestCoordinator(
    detectors,
    { readInputs: () => ({ ...inputs }) },
    config,
  ).run('physical-feedback-only');

  const unit = report.units[0]!;
  assert.equal(report.verdict, 'PASS');
  assert.equal(unit.alarm.verdict, 'PASS');
  assert.equal(unit.fault.verdict, 'PASS');
  assert.equal(unit.alarm.internalStateReached, false);
  assert.equal(unit.fault.internalStateReached, false);
  assert.equal(unit.alarm.oppositeRelayStayedNormal, false);
  assert.equal(unit.fault.oppositeRelayStayedNormal, false);
  assert.equal(unit.alarm.physicalStateReached, true);
  assert.equal(unit.fault.physicalStateReached, true);
  assert.equal(unit.alarm.physicalRecovered, true);
  assert.equal(unit.fault.physicalRecovered, true);
  assert.equal(unit.alarm.reasons.includes('ALARM_INTERNAL_STATE_NOT_SET'), false);
  assert.equal(unit.fault.reasons.includes('FAULT_INTERNAL_STATE_NOT_SET'), false);
  assert.equal(unit.alarm.reasons.includes('ALARM_TRIGGERED_FAULT_RELAY'), false);
  assert.equal(unit.fault.reasons.includes('FAULT_TRIGGERED_ALARM_RELAY'), false);
});

test('matching DIO feedback still rejects a relay that never actuates', async () => {
  const inputs: Record<string, boolean> = { X1: false, X2: false };
  let internal = { fire: false, fault: false };

  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      internal = { ...state };
      if (state.fire) {
        inputs.X1 = false; // alarm relay never actuates
        inputs.X2 = true;  // cross feedback must not substitute for X1
      } else if (state.fault) {
        inputs.X2 = true;
      }
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
    sampleIntervalMs: 20,
    feedbackTimeoutMs: 80,
    resetTimeoutMs: 120,
    mappings: [{
      detectorIndex: 1,
      alarmInputAddress: 'X1',
      faultInputAddress: 'X2',
      alarmNormalLevel: false,
      faultNormalLevel: false,
    }],
  });

  const report = await new RelayFunctionalTestCoordinator(
    detectors,
    { readInputs: () => ({ ...inputs }) },
    config,
  ).run('matching-feedback-required');

  const unit = report.units[0]!;
  assert.equal(report.verdict, 'FAIL');
  assert.equal(unit.alarm.verdict, 'FAIL');
  assert.equal(unit.fault.verdict, 'PASS');
  assert.equal(unit.alarm.physicalStateReached, false);
  assert.ok(unit.alarm.reasons.includes('ALARM_RELAY_NOT_ACTUATED'));
});
