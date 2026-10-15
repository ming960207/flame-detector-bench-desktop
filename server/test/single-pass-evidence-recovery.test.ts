import assert from 'node:assert/strict';
import test from 'node:test';
import { completedIndicatorResults, aggregateSamples, analyzeIndicatorFrame, type IndicatorSlotRoi } from '../../components/indicator-camera-analysis.ts';
import { relayEvidenceIsInfrastructureInvalid } from '../src/product-aware-flame-detector-service.js';
import { RelayFunctionalTestCoordinator, type RelayDetectorPort } from '../src/relay-functional-test-coordinator.js';
import { normalizeRelayFunctionalTestConfig } from '../src/relay-functional-test.js';

const roi: IndicatorSlotRoi = { slot: 1, x: 0, y: 0, width: 1, height: 1 };
function photo(green: boolean, red: boolean): ImageData {
  const width = 48;
  const data = new Uint8ClampedArray(width * width * 4);
  const dot = (startX: number, rgb: number[]) => {
    for (let y = 10; y < 15; y++) for (let x = startX; x < startX + 5; x++) {
      data.set([...rgb, 255], (y * width + x) * 4);
    }
  };
  if (green) dot(10, [30, 230, 45]);
  if (red) dot(24, [230, 30, 40]);
  return { width, height: width, data } as ImageData;
}
function observed(phase: 'BASELINE' | 'ALARM_VERIFY', green: boolean, red: boolean, count: number) {
  const slots = analyzeIndicatorFrame(photo(green, red), [roi], phase);
  return aggregateSamples(
    Array.from({ length: count }, (_, i) => ({ capturedAt: i * 240, phase, slots })),
    phase,
    [roi],
  );
}

test('one cycle: completed LED results reject green observations from the wrong phase', () => {
  const phaseMap = new Map();
  phaseMap.set('ALARM_VERIFY', observed('ALARM_VERIFY', true, true, 3));
  assert.equal(completedIndicatorResults(phaseMap, [roi])[0]?.verdict, 'WAITING');
  assert.equal(completedIndicatorResults(phaseMap, [roi])[0]?.lights.green.state, 'UNKNOWN');

  phaseMap.set('BASELINE', observed('BASELINE', false, false, 3));
  assert.equal(completedIndicatorResults(phaseMap, [roi])[0]?.verdict, 'FAIL');
  assert.equal(completedIndicatorResults(phaseMap, [roi])[0]?.lights.green.state, 'OFF');

  phaseMap.set('BASELINE', observed('BASELINE', true, false, 3));
  assert.equal(completedIndicatorResults(phaseMap, [roi])[0]?.verdict, 'PASS');
  phaseMap.set('ALARM_VERIFY', observed('ALARM_VERIFY', false, true, 1));
  assert.equal(completedIndicatorResults(phaseMap, [roi])[0]?.verdict, 'WAITING');
});

test('blocked DIO baseline is test-invalid even when cleanup says contact stuck', () => {
  assert.equal(relayEvidenceIsInfrastructureInvalid(['RELAY_BASELINE_NOT_NORMAL', 'ALARM_RELAY_STUCK_AFTER_RESET']), true);
  assert.equal(relayEvidenceIsInfrastructureInvalid(['RELAY_FEEDBACK_READ_FAILED:DIO_READ_TIMEOUT', 'FAULT_RELAY_STUCK_AFTER_RESET']), true);
  assert.equal(relayEvidenceIsInfrastructureInvalid(['ALARM:RELAY_BASELINE_READ_FAILED']), true);
  assert.equal(relayEvidenceIsInfrastructureInvalid(['ALARM_RELAY_NOT_ACTUATED']), false);
  assert.equal(relayEvidenceIsInfrastructureInvalid([]), false);
});

test('transient shared DIO timeout recovers automatically during the same relay test, without a second PLC pass', async () => {
  let simulateCalls = 0;
  let reads = 0;
  const inputs = { X1: false, X2: false };
  const detectors: RelayDetectorPort = {
    enabledDetectorIndexes: () => [1],
    async simulate(_index, state) {
      simulateCalls++;
      inputs.X1 = state.fire;
      inputs.X2 = state.fault;
    },
    async reset() {
      inputs.X1 = false;
      inputs.X2 = false;
    },
    async readLatched() { return { fire: inputs.X1, fault: inputs.X2 }; },
  };
  const config = normalizeRelayFunctionalTestConfig({
    enabled: true,
    mode: 'FAST_BATCH',
    sampleIntervalMs: 20,
    stableSamples: 1,
    feedbackTimeoutMs: 200,
    resetTimeoutMs: 200,
    mappings: [{ detectorIndex: 1, alarmInputAddress: 'X1', faultInputAddress: 'X2', alarmNormalLevel: false, faultNormalLevel: false }],
  });
  const source = { readInputs() {
    reads++;
    if (reads <= 3) throw Object.assign(new Error('transient DIO timeout'), { code: 'DIO_READ_TIMEOUT' });
    return { ...inputs };
  } };
  const result = await new RelayFunctionalTestCoordinator(detectors, source, config).run('one-pass-recovery');
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.units[0]?.verdict, 'PASS');
  assert.ok(reads > 3);
  assert.equal(simulateCalls, 6, 'alarm and fault each run only one bounded command burst');
  assert.deepEqual(result.units[0]?.alarm.reasons, []);
});
