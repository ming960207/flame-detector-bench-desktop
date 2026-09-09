import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFieldDetectorBatch } from '../src/closure/field-detector-verdict.js';
import {
  DEFAULT_WAVEFORM_ANALYSIS_CONFIG,
  type DetectionQualityConfig,
  type FieldWaveformAnalysisSnapshot,
  type InterferenceStageResult,
  type WaveformAnalysisUnitResult,
} from '../src/closure/field-waveform-analysis.js';
import {
  DEFAULT_PRODUCT_DETECTION_CONFIG,
  normalizeProductDetectionConfig,
  productAwareWaveformConfig,
  type ProductPrecheckReport,
} from '../src/product-profile.js';
import type { FlameDetectorState, FlameDetectorUnitState } from '../src/types.js';

function dualProduct() {
  return normalizeProductDetectionConfig({
    selectedType: 'DUAL_WAVELENGTH',
    profiles: {
      DUAL_WAVELENGTH: { expectedSoftwareVersion: '90.22.09.15', expectedProbeCount: 2 },
    },
  }, DEFAULT_PRODUCT_DETECTION_CONFIG);
}

function detectorUnit(index = 1): FlameDetectorUnitState {
  return {
    index,
    address: index,
    online: true,
    fire: false,
    fault: false,
    sourceReady: true,
    syncOk: true,
    probe1: 10,
    probe2: 100,
    probe3: 100,
    probe1Absolute: 10,
    probe2Absolute: 100,
    probe3Absolute: 100,
    probe1Fluctuation: 1,
    probe2Fluctuation: 80,
    probe3Fluctuation: 80,
    snr21: 999,
    snr23: 1,
    snr31: 999,
    sensitivity: 1,
    sendMode: 1,
    version: '90.22.09.15',
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
    historySampleTotal: 832,
  };
}

function stage(interferenceRatio: number, snr23: number): InterferenceStageResult {
  return {
    completed: true,
    verdict: 'PASS',
    reason: 'STAGE_WITHIN_LIMIT',
    sampleCount: 100,
    interferenceRatio,
    consistencyTrend: 0.95,
    snr21: 999,
    snr23,
    snr31: 999,
  };
}

function analysisUnit(interferenceRatio: number, snr23: number): WaveformAnalysisUnitResult {
  return {
    index: 1,
    address: 1,
    phase: 'COMPLETE',
    verdict: 'PASS',
    noiseRms: 140,
    noisePeakToPeak: 140,
    noiseAbsolute: 700,
    interferenceRms: 100,
    interferenceRatio,
    consistencyTrend: 0.95,
    snr21: 999,
    snr23,
    snr31: 999,
    noiseSampleCount: 832,
    noiseTest: {
      verdict: 'PASS',
      reason: 'NOISE_WITHIN_LIMIT',
      sampleCount: 832,
      metrics: {
        probe1: { fluctuation: 1, absolute: 10 },
        probe2: { fluctuation: 140, absolute: 700 },
        probe3: { fluctuation: 140, absolute: 700 },
        probe4: { fluctuation: 0, absolute: 0 },
      },
    },
    interferenceSampleCount: 300,
    stages: {
      heat: stage(interferenceRatio, snr23),
      flash: stage(interferenceRatio, snr23),
      emc: stage(interferenceRatio, snr23),
    },
    sampledAt: 1_000,
    reason: 'WAVEFORM_WITHIN_LIMIT',
  };
}

function snapshot(interferenceRatio: number, snr23: number): FieldWaveformAnalysisSnapshot {
  const thresholds = productAwareWaveformConfig(DEFAULT_WAVEFORM_ANALYSIS_CONFIG, 2)!;
  return {
    batchId: 'field-waveform-regression',
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
    thresholds: thresholds as FieldWaveformAnalysisSnapshot['thresholds'],
    units: [analysisUnit(interferenceRatio, snr23)],
  };
}

function precheck(): ProductPrecheckReport {
  return {
    batchId: 'field-waveform-regression',
    productType: 'DUAL_WAVELENGTH',
    productLabel: '双波长',
    expectedSoftwareVersion: '90.22.09.15',
    expectedProbeCount: 2,
    startedAt: 1,
    completedAt: 2,
    verdict: 'PASS',
    units: [{
      index: 1,
      address: 1,
      productType: 'DUAL_WAVELENGTH',
      expectedSoftwareVersion: '90.22.09.15',
      actualSoftwareVersion: '90.22.09.15',
      expectedProbeCount: 2,
      actualProbeCount: 2,
      fireAlarm: false,
      fault: false,
      checkedAt: 2,
      verdict: 'PASS',
      reasons: [],
    }],
  };
}

function state(): FlameDetectorState {
  return {
    units: [detectorUnit()],
    onlineCount: 1,
    fireCount: 0,
    faultCount: 0,
    timestamp: 1_000,
  };
}

function terminalStartup(state: 'DISCONNECTED' | 'FAILED') {
  return {
    state,
    index: 1,
    address: 1,
    powerOnAt: null,
    communicationReadyAt: null,
    modeSwitchStartedAt: null,
    modeSwitchOkAt: null,
    firstFrameAt: null,
    firstValidSampleAt: null,
    channelFirstValidAt: {},
    channelSyncAt: null,
    testReadyAt: null,
    modeSwitchAttempts: 0,
    channelValidStreak: 0,
    requiredChannelCount: 3,
    ...(state === 'FAILED' ? { failureReason: 'MODE_SWITCH_FAILED' } : {}),
  } as NonNullable<FlameDetectorUnitState['startup']>;
}

test('dual-wavelength keeps amplitude ratio as diagnostics but disables it as an acceptance gate', () => {
  const config = productAwareWaveformConfig(DEFAULT_WAVEFORM_ANALYSIS_CONFIG, 2)!;
  assert.equal(config.maxInterferenceRatio, 0);
  assert.equal(config.quality?.a.maxInterferenceRatio, 0);
  assert.equal(config.quality?.b.maxInterferenceRatio, 0);
  assert.deepEqual(config.quality?.ratios.a.snr23, { min: 0.5, max: 1.5 });
  assert.deepEqual(config.quality?.ratios.b.snr23, { min: 0.48, max: 1.5 });
});

test('field-log regression: amplitude ratio 1.912 does not reject dual product when P2/P3 is 1.009', () => {
  const verdict = evaluateFieldDetectorBatch(state(), snapshot(1.912, 1.009), precheck(), dualProduct());
  assert.equal(verdict.units[0]?.verdict, 'PASS');
  assert.equal(verdict.units[0]?.grade, 'A_PASS');
});

test('dual-wavelength P2/P3 remains an authoritative upper-limit gate', () => {
  const verdict = evaluateFieldDetectorBatch(state(), snapshot(1.2, 1.6), precheck(), dualProduct());
  assert.equal(verdict.units[0]?.verdict, 'FAIL');
  assert.equal(verdict.units[0]?.reason, 'HEAT_SNR23_ABOVE_LIMIT');
});

test('dual-wavelength ignores P1-based ratios even if a saved config enables them', () => {
  const current = snapshot(1.2, 1.0);
  const quality = current.thresholds.quality as DetectionQualityConfig;
  current.thresholds = {
    ...current.thresholds,
    quality: {
      ...quality,
      a: { ...quality.a },
      b: { ...quality.b },
      ratios: {
        a: { ...quality.ratios.a, snr21: { min: 0.5, max: 1.5 }, snr31: { min: 0.5, max: 1.5 } },
        b: { ...quality.ratios.b, snr21: { min: 0.5, max: 1.5 }, snr31: { min: 0.5, max: 1.5 } },
      },
    },
  };
  const verdict = evaluateFieldDetectorBatch(state(), current, precheck(), dualProduct());
  assert.equal(verdict.units[0]?.verdict, 'PASS');
  assert.equal(verdict.units[0]?.grade, 'A_PASS');
});

test('completed waveform PASS survives intentional stop-stream transport reset', () => {
  const stopped = state();
  const unit = stopped.units[0]!;
  unit.online = false;
  unit.sourceReady = false;
  unit.syncOk = false;
  unit.sendMode = 0;
  unit.startup = terminalStartup('DISCONNECTED');

  const verdict = evaluateFieldDetectorBatch(stopped, snapshot(1.2, 1.0), precheck(), dualProduct());
  assert.equal(verdict.units[0]?.verdict, 'PASS');
  assert.equal(verdict.units[0]?.grade, 'A_PASS');
});

test('explicit startup failure remains authoritative after completion', () => {
  const failed = state();
  failed.units[0]!.startup = terminalStartup('FAILED');

  const verdict = evaluateFieldDetectorBatch(failed, snapshot(1.2, 1.0), precheck(), dualProduct());
  assert.equal(verdict.units[0]?.verdict, 'FAIL');
  assert.equal(verdict.units[0]?.reason, 'MODE_SWITCH_FAILED');
});