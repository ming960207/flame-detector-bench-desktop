import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFieldDetectorBatch } from '../src/closure/field-detector-verdict.js';

function unit(index: number) {
  return {
    index,
    address: 1,
    online: true,
    fire: false,
    fault: false,
    sourceReady: true,
    syncOk: true,
    probeCount: 3,
    sensitivity: 2,
    lastUpdate: 100 + index,
    features: [],
  } as any;
}

test('detector verdict always exposes D1-D6 even when one state slot is missing', () => {
  const state = {
    units: [1, 2, 3, 4, 5].map(unit),
    onlineCount: 5,
    fireCount: 0,
    faultCount: 0,
    timestamp: 200,
  } as any;

  const pending = evaluateFieldDetectorBatch(state);
  assert.deepEqual(pending.units.map((item) => item.index), [1, 2, 3, 4, 5, 6]);
  assert.equal(pending.units[5]?.reason, 'DETECTOR_SLOT_MISSING');
  assert.equal(pending.units[5]?.verdict, 'PENDING');

  const complete = evaluateFieldDetectorBatch(state, {
    phase: 'COMPLETE',
    thresholds: {},
    units: [],
  } as any);
  assert.equal(complete.units[5]?.verdict, 'PENDING');
  assert.equal(complete.units[5]?.grade, 'PENDING');
  assert.equal(complete.units[5]?.classification, 'TEST_INVALID');
  for (const detector of complete.units.slice(0, 5)) {
    assert.equal(detector.verdict, 'PENDING');
    assert.equal(detector.grade, 'PENDING');
    assert.equal(detector.classification, 'TEST_INVALID');
    assert.equal(detector.reason, 'WAVEFORM_ANALYSIS_MISSING');
  }
  assert.equal(complete.testInvalidCount, 6);
  assert.equal(complete.productFailCount, 0);
  assert.equal(complete.verdict, 'PENDING');
});

test('partial precheck evidence cannot remove an unreported production slot', () => {
  const state = {
    units: [1, 2, 3, 4, 5, 6].map(unit),
    onlineCount: 6,
    fireCount: 0,
    faultCount: 0,
    timestamp: 300,
  } as any;
  const productPrecheck = {
    verdict: 'PASS',
    units: [1, 2, 3, 4, 5].map((index) => ({ index, verdict: 'PASS', reasons: [] })),
  } as any;

  const result = evaluateFieldDetectorBatch(state, undefined, productPrecheck);
  assert.deepEqual(result.units.map((item) => item.index), [1, 2, 3, 4, 5, 6]);
  assert.equal(result.units.length, 6);
});

test('mode-switch startup failure is reported before waveform threshold evaluation', () => {
  const state = {
    units: [1, 2, 3, 4, 5, 6].map(unit),
    onlineCount: 6,
    fireCount: 0,
    faultCount: 0,
    timestamp: 400,
  } as any;
  state.units[5].startup = {
    state: 'FAILED',
    index: 6,
    address: 1,
    powerOnAt: 100,
    communicationReadyAt: 110,
    modeSwitchStartedAt: 120,
    modeSwitchOkAt: null,
    firstFrameAt: null,
    firstValidSampleAt: null,
    channelSyncAt: null,
    testReadyAt: null,
    modeSwitchAttempts: 3,
    channelValidStreak: 0,
    requiredChannelCount: 3,
    failureReason: 'MODE_SWITCH_TIMEOUT',
  };

  const result = evaluateFieldDetectorBatch(state, { phase: 'COMPLETE', thresholds: {}, units: [] } as any);
  assert.equal(result.units[5]?.verdict, 'PENDING');
  assert.equal(result.units[5]?.grade, 'PENDING');
  assert.equal(result.units[5]?.classification, 'TEST_INVALID');
  assert.equal(result.units[5]?.reason, 'MODE_SWITCH_TIMEOUT');
});
