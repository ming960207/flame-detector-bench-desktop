import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_DETECTION_QUALITY_CONFIG,
  normalizeDetectionQualityConfig,
} from '../dist/closure/field-waveform-analysis.js';
import { evaluateFieldDetectorBatch } from '../dist/closure/field-detector-verdict.js';

function detector(index, snr23 = 1) {
  return {
    index, address: index, online: true, fire: false, fault: false,
    sourceReady: true, syncOk: true, probe1: 100, probe2: 100, probe3: 100,
    snr21: 1, snr23, snr31: 1, sensitivity: 1, sendMode: 0, version: 'test',
    address_r: index, runTime: 0, probeCount: 3, lastUpdate: 1,
  };
}

function segment(verdict = 'PASS', reason = 'STAGE_WITHIN_LIMIT') {
  return { verdict, reason, sampleCount: 5, interferenceRatio: 1, consistencyTrend: 1, snr21: 1, snr23: 1, snr31: 1 };
}

function snapshot(stages) {
  return {
    batchId: 'batch-1', phase: 'COMPLETE', processStage: 'COMPLETE', verdict: 'PASS',
    startedAt: 1, updatedAt: 2,
    thresholds: { minNoiseSamples: 5, minInterferenceSamples: 5, maxNoiseRms: 200, maxInterferenceRatio: 1.5, quality: DEFAULT_DETECTION_QUALITY_CONFIG },
    units: [{
      index: 1, address: 1, phase: 'COMPLETE', verdict: 'PASS', noiseRms: 1,
      noisePeakToPeak: 1, noiseAbsolute: 10, interferenceRms: 1,
      interferenceRatio: 1, consistencyTrend: 1, snr21: 1, snr23: 1, snr31: 1,
      noiseSampleCount: 5, interferenceSampleCount: 15, sampledAt: 2, stages,
    }],
  };
}

test('legacy quality config preserves an explicit A-only acceptance choice', () => {
  const legacy = structuredClone(DEFAULT_DETECTION_QUALITY_CONFIG);
  legacy.acceptanceGrade = 'A';
  legacy.detectors = { '1': { a: { snr21: { min: 0, max: 0 }, snr23: { min: 0.8, max: 1.2 }, snr31: { min: 0, max: 0 } } } };
  delete legacy.ratios;
  const normalized = normalizeDetectionQualityConfig(legacy);

  assert.deepEqual(normalized.ratios.a.snr23, { min: 0.8, max: 1.2 });
  assert.equal(normalized.acceptanceGrade, 'A');
  assert.equal('detectors' in normalized, false);
});

test('final production grade is A only when heat, flash and EMC stages all pass', () => {
  const allPass = evaluateFieldDetectorBatch(
    { units: [detector(1)], timestamp: 2 },
    snapshot({ heat: segment(), flash: segment(), emc: segment() }),
  );
  assert.equal(allPass.units[0].grade, 'A_PASS');
  assert.equal(allPass.grade, 'A_PASS');

  const flashFail = evaluateFieldDetectorBatch(
    { units: [detector(1)], timestamp: 2 },
    snapshot({ heat: segment(), flash: segment('FAIL', 'SNR23_ABOVE_LIMIT'), emc: segment() }),
  );
  assert.equal(flashFail.units[0].grade, 'FAIL');
  assert.equal(flashFail.units[0].reason, 'FLASH_SNR23_ABOVE_LIMIT');
  assert.equal(flashFail.grade, 'FAIL');
});

test('B acceptance can be selected while still reporting A when all A limits pass', () => {
  const quality = structuredClone(DEFAULT_DETECTION_QUALITY_CONFIG);
  quality.acceptanceGrade = 'B';
  quality.ratios.a.snr23 = { min: 0.8, max: 1.2 };
  quality.ratios.b.snr23 = { min: 0.5, max: 1.5 };
  const data = snapshot({ heat: segment(), flash: segment(), emc: segment() });
  data.thresholds.quality = quality;
  for (const stage of Object.values(data.units[0].stages)) stage.snr23 = 1.4;

  const bPass = evaluateFieldDetectorBatch({ units: [detector(1, 1.4)], timestamp: 2 }, data);
  assert.equal(bPass.grade, 'B_PASS');

  for (const stage of Object.values(data.units[0].stages)) stage.snr23 = 1;
  const aPass = evaluateFieldDetectorBatch({ units: [detector(1, 1)], timestamp: 3 }, data);
  assert.equal(aPass.grade, 'A_PASS');
});
