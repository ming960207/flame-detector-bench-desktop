import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/product-aware-relay-verification-policy.js';
import { RelayFunctionalTestCoordinator, type RelayDetectorPort } from '../src/relay-functional-test-coordinator.js';
import { normalizeRelayFunctionalTestConfig } from '../src/relay-functional-test.js';

test('runtime DIO baseline handles mixed NO/NC levels and still detects a real no-change relay failure', async () => {
  const internal = new Map<number, { fire: boolean; fault: boolean }>([
    [1, { fire: false, fault: false }],
    [2, { fire: false, fault: false }],
  ]);

  // D1 fault contact is normally HIGH; D2 fault contact is normally LOW.
  // Both mappings deliberately keep configuredNormal=false to prove the runtime baseline overrides it.
  const inputs: Record<string, boolean> = {
    X1: false,
    X2: true,
    X3: false,
    X4: false,
  };

  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1, 2],
    async simulate(index, state) {
      internal.set(index, { ...state });
      if (index === 1) {
        if (state.fire) {
          inputs.X1 = true;
          inputs.X2 = true;
        } else if (state.fault) {
          inputs.X1 = false;
          inputs.X2 = false;
        }
      } else if (state.fire) {
        inputs.X3 = true;
        inputs.X4 = false;
      } else if (state.fault) {
        inputs.X3 = false;
        inputs.X4 = false; // intentionally no physical change: must still be a real FAIL
      }
    },
    async reset(index) {
      internal.set(index, { fire: false, fault: false });
      if (index === 1) {
        inputs.X1 = false;
        inputs.X2 = true;
      } else {
        inputs.X3 = false;
        inputs.X4 = false;
      }
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
    feedbackTimeoutMs: 200,
    resetTimeoutMs: 200,
    mappings: [
      {
        detectorIndex: 1,
        alarmInputAddress: 'X1',
        faultInputAddress: 'X2',
        alarmNormalLevel: false,
        faultNormalLevel: false,
      },
      {
        detectorIndex: 2,
        alarmInputAddress: 'X3',
        faultInputAddress: 'X4',
        alarmNormalLevel: false,
        faultNormalLevel: false,
      },
    ],
  });

  const coordinator = new RelayFunctionalTestCoordinator(
    detectors,
    { readInputs: () => ({ ...inputs }) },
    config,
  );
  const report = await coordinator.run('mixed-baseline');

  const d1 = report.units.find((unit) => unit.detectorIndex === 1)!;
  const d2 = report.units.find((unit) => unit.detectorIndex === 2)!;

  assert.equal(config.mappings[0]?.faultNormalLevel, true, 'D1 fault runtime baseline must be learned as HIGH');
  assert.equal(config.mappings[1]?.faultNormalLevel, false, 'D2 fault runtime baseline must remain LOW');

  assert.equal(d1.verdict, 'PASS');
  assert.equal(d1.alarm.verdict, 'PASS');
  assert.equal(d1.fault.verdict, 'PASS');
  assert.equal(d1.alarm.reasons.includes('FAULT_RELAY_ACTIVE_AT_BASELINE'), false);
  assert.equal(d1.fault.reasons.includes('FAULT_RELAY_ACTIVE_AT_BASELINE'), false);
  assert.equal(d1.fault.reasons.includes('FAULT_RELAY_STUCK_AFTER_RESET'), false);

  assert.equal(d2.alarm.verdict, 'PASS');
  assert.equal(d2.fault.verdict, 'FAIL');
  assert.ok(d2.fault.reasons.includes('FAULT_RELAY_NOT_ACTUATED'));
  assert.equal(report.verdict, 'FAIL');
});
