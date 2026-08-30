import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFieldDetectorBatch } from '../src/closure/field-detector-verdict.js';
import {
  DEFAULT_WAVEFORM_ANALYSIS_CONFIG,
  type FieldWaveformAnalysisSnapshot,
  type InterferenceStageResult,
  type WaveformAnalysisUnitResult,
} from '../src/closure/field-waveform-analysis.js';
import {
  DEFAULT_PRODUCT_DETECTION_CONFIG,
  canonicalSoftwareVersion,
  normalizeProductDetectionConfig,
  productAwareWaveformConfig,
  softwareVersionMatches,
  type ProductPrecheckReport,
} from '../src/product-profile.js';
import type { FlameDetectorState, FlameDetectorUnitState } from '../src/types.js';

const stagePass: InterferenceStageResult = {
  completed: true,
  verdict: 'PASS',
  reason: 'STAGE_WITHIN_LIMIT',
  sampleCount: 100,
  interferenceRatio: 1,
  consistencyTrend: 1,
  snr21: 1,
  snr23: 1,
  snr31: 1,
};

function unit(index = 1): FlameDetectorUnitState {
  return {
    index,
    address: index,
    online: true,
    fire: false,
    fault: false,
    sourceReady: true,
    syncOk: true,
    probe1: 10,
    probe2: 12,
    probe3: 11,
    probe1Absolute: 100,
    probe2Absolute: 100,
    probe3Absolute: 100,
    probe1Fluctuation: 60,
    probe2Fluctuation: 60,
    probe3Fluctuation: 60,
    snr21: 1,
    snr23: 1,
    snr31: 1,
    sensitivity: 1,
    sendMode: 1,
    version: '01.02.03.04',
    address_r: index,
    runTime: 0,
    probeCount: 2,
    lastUpdate: 1_000,
    protocol: 'standard',
    features: [],
    samples: [],
    rawSamples: [],
    historySamples: [],
    rawHistorySamples: [],
    historySampleTotal: 400,
  };
}

function analysisUnit(index = 1): WaveformAnalysisUnitResult {
  return {
    index,
    address: index,
    phase: 'COMPLETE',
    verdict: 'PASS',
    noiseRms: 60,
    noisePeakToPeak: 60,
    noiseAbsolute: 100,
    interferenceRms: 60,
    interferenceRatio: 1,
    consistencyTrend: 1,
    snr21: 1,
    snr23: 1,
    snr31: 1,
    noiseSampleCount: 400,
    noiseTest: {
      verdict: 'PASS',
      reason: 'NOISE_WITHIN_LIMIT',
      sampleCount: 400,
      metrics: {
        probe1: { fluctuation: 60, absolute: 100 },
        probe2: { fluctuation: 60, absolute: 100 },
        probe3: { fluctuation: 60, absolute: 100 },
        probe4: { fluctuation: 0, absolute: 0 },
      },
    },
    interferenceSampleCount: 300,
    stages: { heat: { ...stagePass }, flash: { ...stagePass }, emc: { ...stagePass } },
    sampledAt: 1_000,
    reason: 'WAVEFORM_WITHIN_LIMIT',
  };
}

function snapshot(result = analysisUnit()): FieldWaveformAnalysisSnapshot {
  return {
    batchId: 'batch-1',
    phase: 'COMPLETE',
    processStage: 'COMPLETE',
    heatSubstage: 'IDLE',
    heatSubstageLabel: '非热源阶段',
    heatStageTimings: {
      stabilizationStartedAt: null,
      stabilizationEndedAt: null,
      noiseStartedAt: 1,
      noiseEndedAt: 2,
      interferenceStartedAt: 3,
      interferenceEndedAt: 4,
    },
    verdict: 'PASS',
    startedAt: 1,
    noiseCaptureActive: false,
    noiseStartedAt: 1,
    noiseEndedAt: 2,
    updatedAt: 1_000,
    thresholds: {
      ...DEFAULT_WAVEFORM_ANALYSIS_CONFIG,
      noiseProbes: ['probe1', 'probe2'],
      consistencyProbes: ['probe1', 'probe2'],
      interferenceRatio: { numerator: 'probe2', denominator: 'probe1' },
    },
    units: [result],
  };
}

function dualProduct() {
  return normalizeProductDetectionConfig({
    selectedType: 'DUAL_WAVELENGTH',
    profiles: {
      DUAL_WAVELENGTH: { expectedSoftwareVersion: '01.02.03.04' },
    },
  }, DEFAULT_PRODUCT_DETECTION_CONFIG);
}

function precheck(): ProductPrecheckReport {
  return {
    batchId: 'batch-1',
    productType: 'DUAL_WAVELENGTH',
    productLabel: '双波长',
    expectedSoftwareVersion: '01.02.03.04',
    expectedProbeCount: 2,
    startedAt: 10,
    completedAt: 20,
    verdict: 'PASS',
    units: [{
      index: 1,
      address: 1,
      productType: 'DUAL_WAVELENGTH',
      expectedSoftwareVersion: '01.02.03.04',
      actualSoftwareVersion: '01.02.03.04',
      expectedProbeCount: 2,
      actualProbeCount: 2,
      fireAlarm: false,
      fault: false,
      checkedAt: 20,
      verdict: 'PASS',
      reasons: [],
    }],
  };
}

test('software version comparison ignores separators and 0x prefix', () => {
  assert.equal(canonicalSoftwareVersion('0x01-02.03_04'), '01020304');
  assert.equal(softwareVersionMatches('01.02.03.04', '01020304'), true);
  assert.equal(softwareVersionMatches('01.02.03.04', '01020305'), false);
});

test('product normalization fixes dual/triple/quad probe counts', () => {
  const config = normalizeProductDetectionConfig({
    selectedType: 'FOUR_WAVELENGTH',
    profiles: {
      DUAL_WAVELENGTH: { expectedProbeCount: 4 },
      THREE_WAVELENGTH: { expectedProbeCount: 1 },
      FOUR_WAVELENGTH: { expectedProbeCount: 2 },
      IMAGE_DETECTOR: { expectedProbeCount: 4 },
    },
  });
  assert.equal(config.profiles.DUAL_WAVELENGTH.expectedProbeCount, 2);
  assert.equal(config.profiles.THREE_WAVELENGTH.expectedProbeCount, 3);
  assert.equal(config.profiles.FOUR_WAVELENGTH.expectedProbeCount, 4);
  assert.equal(config.profiles.IMAGE_DETECTOR.expectedProbeCount, 4);
});

test('dual wavelength uses P1/P2 for noise, trend and ratio', () => {
  const result = productAwareWaveformConfig(DEFAULT_WAVEFORM_ANALYSIS_CONFIG, 2)!;
  assert.deepEqual(result.noiseProbes, ['probe1', 'probe2']);
  assert.deepEqual(result.consistencyProbes, ['probe1', 'probe2']);
  assert.deepEqual(result.interferenceRatio, { numerator: 'probe2', denominator: 'probe1' });
});

test('expected probe stuck near absolute limit with low fluctuation is a no-data NG', () => {
  const stateUnit = unit();
  const state: FlameDetectorState = {
    units: [stateUnit],
    onlineCount: 1,
    fireCount: 0,
    faultCount: 0,
    timestamp: 1_000,
  };
  const result = analysisUnit();
  result.noiseTest.metrics.probe1 = { absolute: 995, fluctuation: 5 };
  const verdict = evaluateFieldDetectorBatch(state, snapshot(result), precheck(), dualProduct());
  assert.equal(verdict.verdict, 'FAIL');
  assert.equal(verdict.units[0]?.reason, 'PROBE1_SIGNAL_NO_DATA');
  assert.deepEqual(verdict.units[0]?.noDataProbes, ['probe1']);
});

test('unused P3 on a dual-wavelength product does not create a no-data NG', () => {
  const stateUnit = unit();
  const state: FlameDetectorState = {
    units: [stateUnit],
    onlineCount: 1,
    fireCount: 0,
    faultCount: 0,
    timestamp: 1_000,
  };
  const result = analysisUnit();
  result.noiseTest.metrics.probe3 = { absolute: 999, fluctuation: 1 };
  const verdict = evaluateFieldDetectorBatch(state, snapshot(result), precheck(), dualProduct());
  assert.notEqual(verdict.units[0]?.reason, 'PROBE3_SIGNAL_NO_DATA');
  assert.deepEqual(verdict.units[0]?.noDataProbes ?? [], []);
});
