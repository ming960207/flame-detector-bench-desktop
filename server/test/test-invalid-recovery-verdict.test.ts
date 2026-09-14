import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFieldDetectorBatch } from '../src/closure/field-detector-verdict.js';
import { evaluateFieldFinalVerdict } from '../src/closure/field-final-verdict.js';
import {
  DEFAULT_WAVEFORM_ANALYSIS_CONFIG,
  type FieldWaveformAnalysisSnapshot,
  type InterferenceStageResult,
  type WaveformAnalysisUnitResult,
} from '../src/closure/field-waveform-analysis.js';
import { DetectorStartupTracker, type DetectorStartupDiagnostic } from '../src/modbus/detector-startup.js';
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
    profiles: { DUAL_WAVELENGTH: { expectedSoftwareVersion: '90.22.09.15', expectedProbeCount: 2 } },
  }, DEFAULT_PRODUCT_DETECTION_CONFIG);
}

function detectorUnit(index: number): FlameDetectorUnitState {
  return {
    index,
    address: 1,
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
    address_r: 1,
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

function stage(sampleCount = 100, missing = false): InterferenceStageResult {
  return {
    completed: true,
    verdict: missing ? 'FAIL' : 'PASS',
    reason: missing ? 'SAMPLES_MISSING' : 'STAGE_WITHIN_LIMIT',
    sampleCount,
    interferenceRatio: 1.1,
    consistencyTrend: 0.95,
    snr21: 999,
    snr23: 1,
    snr31: 999,
  };
}

function analysisUnit(index: number, flashMissing = false): WaveformAnalysisUnitResult {
  return {
    index,
    address: 1,
    phase: 'COMPLETE',
    verdict: flashMissing ? 'FAIL' : 'PASS',
    noiseRms: 50,
    noisePeakToPeak: 150,
    noiseAbsolute: 500,
    interferenceRms: 100,
    interferenceRatio: 1.1,
    consistencyTrend: 0.95,
    snr21: 999,
    snr23: 1,
    snr31: 999,
    noiseSampleCount: 800,
    noiseTest: {
      verdict: 'PASS',
      reason: 'NOISE_WITHIN_LIMIT',
      sampleCount: 800,
      metrics: {
        probe1: { fluctuation: 1, absolute: 10 },
        probe2: { fluctuation: 160, absolute: 500 },
        probe3: { fluctuation: 160, absolute: 500 },
        probe4: { fluctuation: 0, absolute: 0 },
      },
    },
    interferenceSampleCount: flashMissing ? 268 : 300,
    stages: {
      heat: stage(),
      flash: stage(flashMissing ? 68 : 100, flashMissing),
      emc: stage(),
    },
    sampledAt: 1_000,
    reason: flashMissing ? 'FLASH_SAMPLES_MISSING' : 'WAVEFORM_WITHIN_LIMIT',
  };
}

function snapshot(flashMissingIndex?: number): FieldWaveformAnalysisSnapshot {
  const thresholds = productAwareWaveformConfig(DEFAULT_WAVEFORM_ANALYSIS_CONFIG, 2)!;
  return {
    batchId: 'test-invalid-regression',
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
    verdict: flashMissingIndex ? 'FAIL' : 'PASS',
    startedAt: 1,
    noiseCaptureActive: false,
    noiseStartedAt: 1,
    noiseEndedAt: 2,
    updatedAt: 1_000,
    thresholds,
    units: Array.from({ length: 6 }, (_, offset) => {
      const index = offset + 1;
      return analysisUnit(index, index === flashMissingIndex);
    }),
  };
}

function precheck(): ProductPrecheckReport {
  return {
    batchId: 'test-invalid-regression',
    productType: 'DUAL_WAVELENGTH',
    productLabel: '双波长',
    expectedSoftwareVersion: '90.22.09.15',
    expectedProbeCount: 2,
    startedAt: 1,
    completedAt: 2,
    verdict: 'PASS',
    units: Array.from({ length: 6 }, (_, offset) => ({
      index: offset + 1,
      address: 1,
      productType: 'DUAL_WAVELENGTH' as const,
      expectedSoftwareVersion: '90.22.09.15',
      actualSoftwareVersion: '90.22.09.15',
      expectedProbeCount: 2,
      actualProbeCount: 2,
      fireAlarm: false,
      fault: false,
      checkedAt: 2,
      verdict: 'PASS' as const,
      reasons: [],
    })),
  };
}

function state(): FlameDetectorState {
  return {
    units: Array.from({ length: 6 }, (_, offset) => detectorUnit(offset + 1)),
    onlineCount: 6,
    fireCount: 0,
    faultCount: 0,
    timestamp: 1_000,
  };
}

function failedStartup(index: number): DetectorStartupDiagnostic {
  return {
    state: 'FAILED',
    index,
    address: 1,
    powerOnAt: 100,
    communicationReadyAt: 110,
    modeSwitchStartedAt: 120,
    modeSwitchOkAt: null,
    firstFrameAt: null,
    firstValidSampleAt: null,
    channelFirstValidAt: {},
    channelSyncAt: null,
    testReadyAt: null,
    modeSwitchAttempts: 1,
    channelValidStreak: 0,
    requiredChannelCount: 3,
    failureReason: 'MODE_SWITCH_TIMEOUT',
  };
}

test('successful startup retry clears stale failure and reaches TEST_READY', () => {
  let now = 1_000;
  const tracker = new DetectorStartupTracker(5, 1, () => now);
  tracker.markPowerOn();
  tracker.markCommunicationReady();
  tracker.markModeSwitching(1);
  const failed = tracker.markModeSwitchFailure('MODE_SWITCH_TIMEOUT');
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.failureReason, 'MODE_SWITCH_TIMEOUT');

  now += 100;
  const retrying = tracker.markModeSwitching(2);
  assert.equal(retrying.state, 'MODE_SWITCHING');
  assert.equal(retrying.failureReason, undefined);
  tracker.markModeSwitchOk();
  for (let frame = 0; frame < 5; frame += 1) {
    now += 10;
    tracker.observeFrame([{ probe1: 8, probe2: 2_000, probe3: 2_100 }]);
  }

  const recovered = tracker.snapshot();
  assert.equal(recovered.state, 'TEST_READY');
  assert.equal(recovered.failureReason, undefined);
  assert.equal(recovered.modeSwitchAttempts, 2);
});

test('completed valid waveform is not overwritten by stale startup failure', () => {
  const current = state();
  current.units[4]!.startup = failedStartup(5);
  const verdict = evaluateFieldDetectorBatch(current, snapshot(), precheck(), dualProduct());
  const unit5 = verdict.units.find((unit) => unit.index === 5)!;
  assert.equal(unit5.verdict, 'PASS');
  assert.equal(unit5.grade, 'A_PASS');
  assert.equal(unit5.classification, 'PRODUCT_RESULT');
});

test('completed flash sample shortage is RETEST evidence, not product NG', () => {
  const waveform = snapshot(5);
  const verdict = evaluateFieldDetectorBatch(state(), waveform, precheck(), dualProduct());
  const unit5 = verdict.units.find((unit) => unit.index === 5)!;

  assert.equal(unit5.verdict, 'FAIL');
  assert.equal(unit5.grade, 'FAIL');
  assert.equal(unit5.classification, 'TEST_INVALID');
  assert.equal(unit5.reason, 'FLASH_SAMPLES_MISSING');
  assert.equal(verdict.testInvalidCount, 1);
  assert.equal(verdict.productFailCount, 0);

  const final = evaluateFieldFinalVerdict(
    { stage: 'COMPLETE', processStage: 'COMPLETE', complete: true, valid: true },
    verdict,
    waveform,
  );
  assert.equal(final.verdict, 'FAIL');
  assert.equal(final.reason, 'TEST_INVALID_RETEST_REQUIRED');
});