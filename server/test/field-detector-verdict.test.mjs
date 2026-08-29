import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_DETECTION_QUALITY_CONFIG,
} from '../dist/closure/field-waveform-analysis.js';
import { evaluateFieldDetectorBatch } from '../dist/closure/field-detector-verdict.js';

function detector(index, snr23) {
  return {
    index,
    address: index,
    online: true,
    fire: false,
    fault: false,
    sourceReady: true,
    syncOk: true,
    probe1: 100,
    probe2: 100,
    probe3: 100,
    snr21: 1,
    snr23,
    snr31: 1,
    sensitivity: 1,
    sendMode: 0,
    version: 'test',
    address_r: index,
    runTime: 0,
    probeCount: 3,
    lastUpdate: 1,
  };
}

function analysisUnit(index) {
  return {
    index,
    address: index,
    phase: 'COMPLETE',
    verdict: 'PASS',
    noiseRms: 1,
    noisePeakToPeak: 1,
    noiseAbsolute: 100,
    interferenceRms: 1,
    interferenceRatio: 1,
    consistencyTrend: 1,
    noiseSampleCount: 5,
    interferenceSampleCount: 5,
    sampledAt: 1,
  };
}

function snapshot(quality, indexes) {
  return {
    batchId: 'test-batch',
    phase: 'COMPLETE',
    processStage: 'COMPLETE',
    verdict: 'PASS',
    startedAt: 1,
    updatedAt: 1,
    thresholds: {
      minNoiseSamples: 5,
      minInterferenceSamples: 5,
      maxNoiseRms: 50,
      maxInterferenceRatio: 10,
      quality,
    },
    units: indexes.map(analysisUnit),
  };
}

test('default quantitative grading ignores fire response and bounds P2/P3', () => {
  assert.equal('requireFireResponse' in DEFAULT_DETECTION_QUALITY_CONFIG, false);
  assert.equal(DEFAULT_DETECTION_QUALITY_CONFIG.acceptanceGrade, 'B');
  assert.deepEqual(DEFAULT_DETECTION_QUALITY_CONFIG.a, {
    maxNoiseRms: 180,
    maxNoiseAbsolute: 1000,
    maxInterferenceRatio: 1.5,
    minConsistencyTrend: 0.8,
    minSensitivity: 0,
  });
  assert.deepEqual(DEFAULT_DETECTION_QUALITY_CONFIG.b, {
    maxNoiseRms: 200,
    maxNoiseAbsolute: 1000,
    maxInterferenceRatio: 1.5,
    minConsistencyTrend: 0.75,
    minSensitivity: 0,
  });
  assert.deepEqual(DEFAULT_DETECTION_QUALITY_CONFIG.ratios.a.snr23, { min: 0.5, max: 1.5 });
  assert.deepEqual(DEFAULT_DETECTION_QUALITY_CONFIG.ratios.b.snr23, { min: 0.48, max: 1.5 });

  const within = evaluateFieldDetectorBatch(
    { units: [detector(1, 1)], timestamp: 1 },
    snapshot(DEFAULT_DETECTION_QUALITY_CONFIG, [1]),
  );
  assert.equal(within.units[0].grade, 'A_PASS');

  const outside = evaluateFieldDetectorBatch(
    { units: [detector(1, 1.6)], timestamp: 1 },
    snapshot(DEFAULT_DETECTION_QUALITY_CONFIG, [1]),
  );
  assert.equal(outside.units[0].verdict, 'FAIL');
  assert.equal(outside.units[0].reason, 'HEAT_SNR23_ABOVE_LIMIT');

  const bPass = evaluateFieldDetectorBatch(
    { units: [detector(1, 0.492)], timestamp: 1 },
    snapshot(DEFAULT_DETECTION_QUALITY_CONFIG, [1]),
  );
  assert.equal(bPass.units[0].grade, 'B_PASS');
});

test('noise between A and B limits is graded B instead of A', () => {
  const quality = structuredClone(DEFAULT_DETECTION_QUALITY_CONFIG);
  quality.acceptanceGrade = 'B';
  quality.a.maxNoiseRms = 200;
  quality.b.maxNoiseRms = 250;
  const data = snapshot(quality, [1]);
  data.units[0].noiseTest = {
    verdict: 'PASS',
    reason: 'NOISE_WITHIN_LIMIT',
    sampleCount: 400,
    metrics: {
      probe1: { fluctuation: 100, absolute: 300 },
      probe2: { fluctuation: 224, absolute: 400 },
      probe3: { fluctuation: 232, absolute: 420 },
      probe4: { fluctuation: 0, absolute: 0 },
    },
  };

  const result = evaluateFieldDetectorBatch({ units: [detector(1, 1)], timestamp: 1 }, data);

  assert.equal(result.units[0].grade, 'B_PASS');
  assert.equal(result.units[0].reason, 'A_GRADE_NOISE_RMS_EXCEEDS_LIMIT');
  assert.equal(result.grade, 'B_PASS');
});

test('all detectors use the same configured P2/P3 range', () => {
  const quality = structuredClone(DEFAULT_DETECTION_QUALITY_CONFIG);
  quality.ratios.a.snr23 = { min: 0.8, max: 1.2 };
  quality.ratios.b.snr23 = { min: 0.8, max: 1.2 };

  const result = evaluateFieldDetectorBatch(
    { units: [detector(1, 1.4), detector(2, 1.4)], timestamp: 1 },
    snapshot(quality, [1, 2]),
  );

  assert.equal(result.units[0].verdict, 'FAIL');
  assert.equal(result.units[1].verdict, 'FAIL');
  assert.equal(result.units[1].reason, 'HEAT_SNR23_ABOVE_LIMIT');
});

test('quantitative grading uses complete test-process metrics instead of only the latest probe values', () => {
  const quality = structuredClone(DEFAULT_DETECTION_QUALITY_CONFIG);
  const historical = snapshot(quality, [1]);
  historical.units[0].noiseRms = 9_999;
  historical.units[0].noisePeakToPeak = 9_999;

  const current = detector(1, 1);
  current.probe1 = 100;
  current.probe2 = 120;
  current.probe3 = 80;
  current.probe1Fluctuation = 10;
  current.probe2Fluctuation = 20;
  current.probe3Fluctuation = 5;
  current.probe1Absolute = 100;
  current.probe2Absolute = 120;
  current.probe3Absolute = 80;
  const result = evaluateFieldDetectorBatch({ units: [current], timestamp: 2 }, historical);
  assert.equal(result.units[0].verdict, 'FAIL');
  assert.equal(result.units[0].metrics.noiseRms, 9_999);
  assert.equal(result.units[0].reason, 'HEAT_NOISE_RMS_EXCEEDS_LIMIT');
});

test('completed captured metrics are graded even when return-home power-off leaves devices offline', () => {
  const state = detector(1, 1);
  state.online = false;
  state.sourceReady = false;
  state.syncOk = false;

  const result = evaluateFieldDetectorBatch(
    { units: [state], timestamp: 2 },
    snapshot(DEFAULT_DETECTION_QUALITY_CONFIG, [1]),
  );
  assert.equal(result.units[0].verdict, 'PASS');
  assert.equal(result.units[0].grade, 'A_PASS');
});

test('one incomplete detector does not prevent completed peers from being graded', () => {
  const analysis = snapshot(DEFAULT_DETECTION_QUALITY_CONFIG, [1, 2]);
  analysis.verdict = 'FAIL';
  analysis.units[1].verdict = 'FAIL';
  analysis.units[1].reason = 'FLASH_SAMPLES_MISSING';

  const result = evaluateFieldDetectorBatch(
    { units: [detector(1, 1), detector(2, 1)], timestamp: 2 },
    analysis,
  );
  assert.equal(result.units[0].grade, 'A_PASS');
  assert.equal(result.units[1].grade, 'FAIL');
});
